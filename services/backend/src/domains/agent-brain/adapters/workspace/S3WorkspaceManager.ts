import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createHash, randomUUID } from 'crypto';
import type {
    WorkspaceAllocationOptions,
    WorkspaceManager,
    WorkspaceOrphanCleanupOptions,
    WorkspaceOrphanCleanupResult,
    WorkspaceSnapshotManifest,
} from './WorkspaceManager';
import { reapLocalWorkspaceOrphans } from './workspaceOrphanCleanup';
import { type S3StorageService } from '@/shared/storage/S3StorageService';
import { logger } from '@/shared/logger';
import { ensureSandboxWritableDirectory } from './workspacePermissions';

const WORKSPACES_PREFIX = 'workspaces';
const SNAPSHOTS_DIR = '.snapshots';

// App composition can construct more than one SessionStore/S3WorkspaceManager in one process.
// Startup hydration may then ask those instances to restore the same run workspace concurrently.
// The snapshot stage path is intentionally deterministic, so an instance-local guard is not
// enough: one restore can otherwise remove another restore's stage directory mid-download.
const pendingWorkspaceEnsures = new Map<
    string,
    { ownerId?: string; promise: Promise<void> }
>();

type WorkspaceSnapshotPointer = {
    schemaVersion: 1;
    snapshotId: string;
    manifestKey: string;
    directoryHash: string;
};

const parseJsonObject = (buffer: Buffer, label: string): Record<string, unknown> => {
    try {
        const value = JSON.parse(buffer.toString('utf8')) as unknown;
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            return value as Record<string, unknown>;
        }
    } catch {
        // normalized below
    }
    throw new Error(`workspace.snapshot_invalid_${label}`);
};

const safeSnapshotPath = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('workspace.snapshot_invalid_path');
    const normalized = value.replace(/\\/g, '/');
    if (path.posix.isAbsolute(normalized) || path.posix.normalize(normalized).startsWith('../')) {
        throw new Error('workspace.snapshot_unsafe_path');
    }
    return normalized;
};

type S3WorkspaceManagerOptions = {
    /** Local root for temp workspace directories, defaults to os.tmpdir() */
    localRoot?: string;
    /** Max bytes per workspace for quota enforcement */
    maxBytesPerWorkspace?: number;
};

/**
 * Workspace manager that persists/restores workspaces to/from S3/MinIO.
 * 
 * Local filesystem is used as a temp cache during active sessions.
 * On cleanup, workspace is persisted to S3.
 * On restore, workspace is downloaded from S3.
 * 
 * This ensures sessions are recoverable even if:
 * - Local files are deleted
 * - Container restarts
 * - Session is resumed on a different worker node
 */
export class S3WorkspaceManager implements WorkspaceManager {
    private readonly localRoot: string;
    private maxBytesPerWorkspace?: number;
    private readonly log = logger.child({ scope: 'S3WorkspaceManager' });

    // Metrics
    private restored = 0;
    private persisted = 0;
    private cleaned = 0;
    private blocked = 0;
    private lastRestoreAt?: number;
    private lastPersistAt?: number;
    private lastCleanupAt?: number;
    private lastBlockedAt?: number;
    private lastBlockedWorkspace?: string;

    constructor(
        private readonly s3: S3StorageService,
        options: S3WorkspaceManagerOptions = {},
    ) {
        this.localRoot = options.localRoot ?? path.join(os.tmpdir(), 'ns-workspaces');
        this.maxBytesPerWorkspace = options.maxBytesPerWorkspace;
    }

    /**
     * Allocate a local workspace path for a session or run.
     * The path is deterministic based on the selected owner ID.
     */
    allocateWorkspace(ownerId: string, options: WorkspaceAllocationOptions = {}): string {
        const prefix = options.kind === 'run' ? 'ns-run' : 'ns-agent';
        return path.join(this.localRoot, `${prefix}-${ownerId}`);
    }

    /**
     * Ensure workspace exists locally, restoring from S3 if needed.
     */
    async ensureWorkspace(workspaceDir: string, sessionId?: string): Promise<void> {
        const key = path.resolve(workspaceDir);
        const pending = pendingWorkspaceEnsures.get(key);
        if (pending) {
            await pending.promise;
            // Same workspace and snapshot owner means the completed restore satisfies this caller.
            if (pending.ownerId === sessionId) return;
            // A different owner targeting the same local path must run after, never alongside it.
            return this.ensureWorkspace(workspaceDir, sessionId);
        }

        const promise = this.ensureWorkspaceOnce(workspaceDir, sessionId);
        const entry = { ...(sessionId ? { ownerId: sessionId } : {}), promise };
        pendingWorkspaceEnsures.set(key, entry);
        try {
            await promise;
        } finally {
            if (pendingWorkspaceEnsures.get(key) === entry) pendingWorkspaceEnsures.delete(key);
        }
    }

    private async ensureWorkspaceOnce(workspaceDir: string, sessionId?: string): Promise<void> {
        await ensureSandboxWritableDirectory(workspaceDir);

        // Restore from S3 if session ID provided
        if (sessionId) {
            await this.restoreWorkspace(workspaceDir, sessionId);
        }

        // Enforce quota if configured
        if (this.maxBytesPerWorkspace && this.maxBytesPerWorkspace > 0) {
            await this.enforceQuota(workspaceDir);
        }
    }

    /**
     * Restore workspace contents from S3.
     */
    async restoreWorkspace(workspaceDir: string, sessionId: string): Promise<void> {
        try {
            if (await this.restoreLatestSnapshot(workspaceDir, sessionId)) return;
            if (await this.restoreLegacySnapshot(workspaceDir, sessionId)) return;
            this.log.debug({ sessionId }, '[S3WorkspaceManager] No backup found in S3');
        } catch (err) {
            this.log.error({ err, sessionId }, '[S3WorkspaceManager] Failed to restore workspace from S3');
            throw err;
        }
    }

    /**
     * Cleanup workspace - persist to S3, then delete local.
     */
    async cleanupWorkspace(workspaceDir: string, sessionId?: string): Promise<void> {
        if (sessionId) {
            await this.createSnapshot(workspaceDir, sessionId);
        }

        try {
            await fs.rm(workspaceDir, { recursive: true, force: true });
            this.cleaned++;
            this.lastCleanupAt = Date.now();
        } catch (err) {
            this.log.error({ err, workspaceDir }, '[S3WorkspaceManager] Failed to cleanup local workspace');
            throw err;
        }
    }

    /**
     * Upload an immutable snapshot. Files and the manifest are read back and
     * verified before the latest pointer is committed. A failed upload leaves
     * the prior pointer and local workspace untouched.
     */
    async createSnapshot(workspaceDir: string, ownerId: string): Promise<WorkspaceSnapshotManifest | null> {
        let stats;
        try {
            stats = await fs.stat(workspaceDir);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
        if (!stats.isDirectory()) throw new Error(`workspace.snapshot_not_directory:${workspaceDir}`);

        const snapshotId = `${Date.now()}-${randomUUID()}`;
        const files = await this.walkDirectory(workspaceDir);
        files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
        const manifestFiles: WorkspaceSnapshotManifest['files'] = [];
        const directoryHash = createHash('sha256');
        for (const file of files) {
            const content = await fs.readFile(file.absolutePath);
            const sha256 = createHash('sha256').update(content).digest('hex');
            const key = this.snapshotFileKey(ownerId, snapshotId, file.relativePath);
            await this.s3.uploadBuffer(key, content, 'application/octet-stream');
            const stored = await this.s3.getObjectBuffer(key);
            if (createHash('sha256').update(stored).digest('hex') !== sha256) {
                throw new Error(`workspace.snapshot_upload_verification_failed:${file.relativePath}`);
            }
            manifestFiles.push({ path: file.relativePath, size: content.byteLength, sha256 });
            directoryHash.update(file.relativePath);
            directoryHash.update(content);
        }

        const manifest: WorkspaceSnapshotManifest = {
            schemaVersion: 1,
            ownerId,
            snapshotId,
            createdAt: new Date().toISOString(),
            directoryHash: directoryHash.digest('hex'),
            files: manifestFiles,
        };
        const manifestKey = this.snapshotManifestKey(ownerId, snapshotId);
        const manifestBuffer = Buffer.from(JSON.stringify(manifest), 'utf8');
        await this.s3.uploadBuffer(manifestKey, manifestBuffer, 'application/json');
        const storedManifest = await this.s3.getObjectBuffer(manifestKey);
        if (!storedManifest.equals(manifestBuffer)) {
            throw new Error('workspace.snapshot_manifest_verification_failed');
        }

        const pointer: WorkspaceSnapshotPointer = {
            schemaVersion: 1,
            snapshotId,
            manifestKey,
            directoryHash: manifest.directoryHash,
        };
        const pointerBuffer = Buffer.from(JSON.stringify(pointer), 'utf8');
        const pointerKey = this.snapshotPointerKey(ownerId);
        await this.s3.uploadBuffer(pointerKey, pointerBuffer, 'application/json');
        const storedPointer = await this.s3.getObjectBuffer(pointerKey);
        if (!storedPointer.equals(pointerBuffer)) {
            throw new Error('workspace.snapshot_pointer_verification_failed');
        }

        this.persisted++;
        this.lastPersistAt = Date.now();
        this.log.info({ ownerId, snapshotId, fileCount: files.length }, '[S3WorkspaceManager] Persisted verified workspace snapshot');
        return manifest;
    }

    async restoreLatestSnapshot(workspaceDir: string, ownerId: string): Promise<boolean> {
        const pointerKey = this.snapshotPointerKey(ownerId);
        const snapshotObjects = await this.s3.listPrefix(this.snapshotRootKey(ownerId));
        if (!snapshotObjects.some((object) => object.key === pointerKey)) return false;

        const pointerValue = parseJsonObject(await this.s3.getObjectBuffer(pointerKey), 'pointer');
        if (
            pointerValue.schemaVersion !== 1
            || typeof pointerValue.snapshotId !== 'string'
            || typeof pointerValue.manifestKey !== 'string'
            || typeof pointerValue.directoryHash !== 'string'
        ) {
            throw new Error('workspace.snapshot_invalid_pointer');
        }
        const expectedManifestKey = this.snapshotManifestKey(ownerId, pointerValue.snapshotId);
        if (pointerValue.manifestKey !== expectedManifestKey) {
            throw new Error('workspace.snapshot_manifest_pointer_mismatch');
        }
        const manifestValue = parseJsonObject(
            await this.s3.getObjectBuffer(expectedManifestKey),
            'manifest',
        );
        if (
            manifestValue.schemaVersion !== 1
            || manifestValue.ownerId !== ownerId
            || manifestValue.snapshotId !== pointerValue.snapshotId
            || manifestValue.directoryHash !== pointerValue.directoryHash
            || !Array.isArray(manifestValue.files)
        ) {
            throw new Error('workspace.snapshot_invalid_manifest');
        }

        const stageDir = `${workspaceDir}.restore-${pointerValue.snapshotId}`;
        await fs.rm(stageDir, { recursive: true, force: true });
        await ensureSandboxWritableDirectory(stageDir);
        try {
            for (const entry of manifestValue.files) {
                if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
                    throw new Error('workspace.snapshot_invalid_file_entry');
                }
                const file = entry as Record<string, unknown>;
                const relativePath = safeSnapshotPath(file.path);
                if (typeof file.sha256 !== 'string' || typeof file.size !== 'number') {
                    throw new Error('workspace.snapshot_invalid_file_entry');
                }
                const content = await this.s3.getObjectBuffer(
                    this.snapshotFileKey(ownerId, pointerValue.snapshotId, relativePath),
                );
                if (
                    content.byteLength !== file.size
                    || createHash('sha256').update(content).digest('hex') !== file.sha256
                ) {
                    throw new Error(`workspace.snapshot_file_verification_failed:${relativePath}`);
                }
                const localPath = path.join(stageDir, relativePath);
                await ensureSandboxWritableDirectory(path.dirname(localPath));
                await fs.writeFile(localPath, content);
            }
            const restoredHash = await this.getDirectoryHash(stageDir);
            if (restoredHash !== pointerValue.directoryHash) {
                throw new Error('workspace.snapshot_directory_verification_failed');
            }
            await this.swapRestoredWorkspace(workspaceDir, stageDir, pointerValue.snapshotId);
        } catch (error) {
            await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
            throw error;
        }

        this.restored++;
        this.lastRestoreAt = Date.now();
        this.log.info(
            { ownerId, snapshotId: pointerValue.snapshotId, fileCount: manifestValue.files.length },
            '[S3WorkspaceManager] Restored verified workspace snapshot',
        );
        return true;
    }

    private async restoreLegacySnapshot(workspaceDir: string, ownerId: string): Promise<boolean> {
        const prefix = this.s3Key(ownerId, '');
        const objects = (await this.s3.listPrefix(prefix)).filter(
            (object) => !object.relativePath.replace(/^\/+/, '').startsWith(`${SNAPSHOTS_DIR}/`),
        );
        if (objects.length === 0) return false;
        const hashObject = objects.find((object) => object.relativePath.replace(/^\/+/, '') === '.hash');
        if (!hashObject) throw new Error('workspace.legacy_snapshot_hash_missing');
        const expectedHash = (await this.s3.getObjectBuffer(hashObject.key)).toString('utf8').trim();
        const stageDir = `${workspaceDir}.restore-legacy`;
        await fs.rm(stageDir, { recursive: true, force: true });
        await ensureSandboxWritableDirectory(stageDir);
        try {
            for (const object of objects) {
                const relativePath = object.relativePath.replace(/^\/+/, '');
                if (relativePath === '.hash') continue;
                const safePath = safeSnapshotPath(relativePath);
                const localPath = path.join(stageDir, safePath);
                await ensureSandboxWritableDirectory(path.dirname(localPath));
                await fs.writeFile(localPath, await this.s3.getObjectBuffer(object.key));
            }
            if (await this.getDirectoryHash(stageDir) !== expectedHash) {
                throw new Error('workspace.legacy_snapshot_hash_mismatch');
            }
            await this.swapRestoredWorkspace(workspaceDir, stageDir, 'legacy');
        } catch (error) {
            await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
            throw error;
        }
        this.restored++;
        this.lastRestoreAt = Date.now();
        return true;
    }

    private async swapRestoredWorkspace(workspaceDir: string, stageDir: string, snapshotId: string): Promise<void> {
        const backupDir = `${workspaceDir}.previous-${snapshotId}`;
        await fs.rm(backupDir, { recursive: true, force: true });
        let hadExisting = false;
        try {
            await fs.rename(workspaceDir, backupDir);
            hadExisting = true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        try {
            await fs.rename(stageDir, workspaceDir);
            if (hadExisting) await fs.rm(backupDir, { recursive: true, force: true });
        } catch (error) {
            if (hadExisting) {
                await fs.rename(backupDir, workspaceDir).catch(() => undefined);
            }
            throw error;
        }
    }

    /**
     * Cleanup stale workspaces older than TTL.
     */
    async cleanupStaleWorkspaces(ttlMs: number): Promise<number> {
        if (ttlMs <= 0) return 0;

        const now = Date.now();
        let removed = 0;

        try {
            const entries = await fs.readdir(this.localRoot, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                if (!entry.name.startsWith('ns-agent-') && !entry.name.startsWith('ns-run-')) continue;

                const fullPath = path.join(this.localRoot, entry.name);
                const stats = await fs.stat(fullPath);
                const age = now - stats.mtimeMs;

                if (age > ttlMs) {
                    await fs.rm(fullPath, { recursive: true, force: true });
                    removed++;
                }
            }
        } catch (err) {
            this.log.warn({ err }, '[S3WorkspaceManager] Failed to cleanup stale workspaces');
        }

        if (removed > 0) {
            this.cleaned += removed;
            this.lastCleanupAt = Date.now();
        }
        return removed;
    }

    async cleanupOrphanedWorkspaces(
        options: WorkspaceOrphanCleanupOptions,
    ): Promise<WorkspaceOrphanCleanupResult> {
        return reapLocalWorkspaceOrphans({
            root: this.localRoot,
            minAgeMs: options.minAgeMs,
            isOwnerActive: options.isOwnerActive,
            cleanupWorkspace: async (workspaceDir, owner) => {
                await this.cleanupWorkspace(workspaceDir, owner.id);
            },
            log: this.log,
        });
    }

    /**
     * Enforce quota on workspace size.
     */
    async enforceQuota(workspaceDir: string): Promise<boolean> {
        if (!this.maxBytesPerWorkspace || this.maxBytesPerWorkspace <= 0) {
            return true;
        }

        const size = await this.getDirectorySize(workspaceDir);
        if (size > this.maxBytesPerWorkspace) {
            this.blocked++;
            this.lastBlockedAt = Date.now();
            this.lastBlockedWorkspace = workspaceDir;
            throw new Error(`workspace.quota_exceeded:${size}`);
        }
        return true;
    }

    setMaxBytesPerWorkspace(maxBytes?: number): void {
        if (typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0) {
            this.maxBytesPerWorkspace = maxBytes;
        } else {
            this.maxBytesPerWorkspace = undefined;
        }
    }

    getMetrics() {
        return {
            restored: this.restored,
            persisted: this.persisted,
            cleaned: this.cleaned,
            blocked: this.blocked,
            lastRestoreAt: this.lastRestoreAt,
            lastPersistAt: this.lastPersistAt,
            lastCleanupAt: this.lastCleanupAt,
            lastBlockedAt: this.lastBlockedAt,
            lastBlockedWorkspace: this.lastBlockedWorkspace,
            localRoot: this.localRoot,
            bucket: this.s3.getBucket(),
        };
    }

    // Helper: Build S3 key for a file in a session workspace
    private s3Key(sessionId: string, relativePath: string): string {
        return this.s3.makeKey(WORKSPACES_PREFIX, sessionId, relativePath);
    }

    private snapshotRootKey(ownerId: string): string {
        return this.s3.makeKey(WORKSPACES_PREFIX, ownerId, SNAPSHOTS_DIR);
    }

    private snapshotPointerKey(ownerId: string): string {
        return this.s3.makeKey(this.snapshotRootKey(ownerId), 'latest.json');
    }

    private snapshotManifestKey(ownerId: string, snapshotId: string): string {
        return this.s3.makeKey(this.snapshotRootKey(ownerId), snapshotId, 'manifest.json');
    }

    private snapshotFileKey(ownerId: string, snapshotId: string, relativePath: string): string {
        return this.s3.makeKey(this.snapshotRootKey(ownerId), snapshotId, 'files', relativePath);
    }

    // Helper: Walk directory recursively and return all files
    private async walkDirectory(dir: string): Promise<{ absolutePath: string; relativePath: string }[]> {
        const results: { absolutePath: string; relativePath: string }[] = [];
        await this.walkDirectoryRecursive(dir, dir, results);
        return results;
    }

    private async walkDirectoryRecursive(
        baseDir: string,
        currentDir: string,
        results: { absolutePath: string; relativePath: string }[],
    ): Promise<void> {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const absolutePath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                await this.walkDirectoryRecursive(baseDir, absolutePath, results);
            } else if (entry.isFile()) {
                const relativePath = path.relative(baseDir, absolutePath).replace(/\\/g, '/');
                results.push({ absolutePath, relativePath });
            }
        }
    }

    // Helper: Get directory size recursively
    private async getDirectorySize(dir: string): Promise<number> {
        let total = 0;
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const stats = await fs.stat(fullPath);
                if (stats.isDirectory()) {
                    total += await this.getDirectorySize(fullPath);
                } else {
                    total += stats.size;
                }
            }
        } catch {
            // Directory doesn't exist or can't be read
        }
        return total;
    }

    // Helper: Get hash of directory contents for integrity check
    private async getDirectoryHash(dir: string): Promise<string> {
        const hash = createHash('sha256');
        const files = await this.walkDirectory(dir);

        // Sort for deterministic hash
        files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

        for (const file of files) {
            hash.update(file.relativePath);
            const content = await fs.readFile(file.absolutePath);
            hash.update(content);
        }

        return hash.digest('hex');
    }
}
