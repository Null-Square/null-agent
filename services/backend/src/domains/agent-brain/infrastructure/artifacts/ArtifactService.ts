import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { type SessionState, type SessionArtifact } from '../../domain/types';
import type { ArtifactServicePort } from '../../ports';
import { type SessionStore } from '../../application/core/SessionStore';
import type { StreamBroker } from '../../application/orchestration/streaming/StreamBroker';
import { type ArtifactRepository } from '@/domains/agent-brain/adapters/persistence';
import { type S3StorageService } from '@/shared/storage/S3StorageService';
import type { ResolvedConfig } from '@/config/configTypes';
import { logger } from '@/shared/logger';
import { CompletionBlockedError } from '../../domain/errors';
import type { SessionTraceRecorder } from '../telemetry';
import { createTimelineEntry } from '../../application/orchestration/utils/timelineEntries';
import { isStagingNoiseArtifactPath } from '@/shared/utils/artifact-path-filters';
import {
    remoteExecAdapter,
    type RemoteExecAdapter,
} from '@/domains/security-ops/runners/RemoteExecAdapter';
import {
    isScopeRunnerBinding,
    resolveRunnerSessionBinding,
    resolveRunnerWorkspaceKey,
} from '@/domains/security-ops/runners/runnerSession';
import { shouldRequireReportForSession } from '../../domain/workers/workerContracts';

const REMOTE_ARTIFACT_BASE_PATHS = ['summary.md', 'report.md', '.artifacts'] as const;

export class ArtifactService implements ArtifactServicePort {
    private readonly storageRoot: string;
    private readonly summaryFileName = 'summary.md';
    private readonly reportFileName = 'report.md';
    // REMOVED Dec 2025: keepLocalCopy - debug mirror feature removed
    private readonly log = logger.child({ scope: 'ArtifactService' });

    constructor(
        private readonly sessionStore: SessionStore,
        private readonly artifactRepository?: ArtifactRepository,
        storageRoot?: string,
        private readonly s3?: { bucket: string; client: S3StorageService },
        private readonly config?: ResolvedConfig,
        private readonly remoteExec: RemoteExecAdapter = remoteExecAdapter,
    ) {
        const resolvedRoot = storageRoot ?? config?.workspace.artifactStorageRoot;
        this.storageRoot = resolvedRoot
            ? path.resolve(process.cwd(), resolvedRoot)
            : path.resolve(process.cwd(), 'storage', 'artifacts');
        // REMOVED Dec 2025: keepLocalCopy - debug mirror feature removed
        this.ensureStorageRoot();
    }

    private ensureStorageRoot(): void {
        if (!fs.existsSync(this.storageRoot)) {
            fs.mkdirSync(this.storageRoot, { recursive: true });
        }
    }

    /**
     * Save artifacts using explicit output contract (Dec 2025).
     * 
     * PROVIDER-ALIGNED: Like Codex/Claude, only persist explicit outputs:
     * 1. Mandatory: summary.md, report.md (root-level)
     * 2. Allowlist: .artifacts/** directory
     * 3. Optional: files listed in .artifacts/publish.json manifest
     * 
     * This replaces recursive workspace scanning which was noisy and unpredictable.
     */
    async saveArtifacts(session: SessionState): Promise<void> {
        this.log.debug({ sessionId: session.id }, 'Saving artifacts for session (explicit contract)');
        await this.syncRemoteArtifactsIntoWorkspace(session);

        // CHANGED Dec 2025: Use explicit output contract instead of recursive scanning
        const sessionArtifacts = await this.collectExplicitArtifacts(session);
        this.ensureSyntheticSummary(session, sessionArtifacts);
        // derive summary/report before mutating paths for S3
        this.applyArtifactDerivedState(session, sessionArtifacts);
        if (this.s3) {
            await this.uploadToS3(session.id, sessionArtifacts);
        }

        session.artifacts = sessionArtifacts;
        this.sessionStore.set(session.id, session);
        await this.persistArtifactRecords(session.id, sessionArtifacts);
    }

    async flush(
        sessionId: string,
        _turnNumber: number,
        stream: StreamBroker,
        _recorder?: SessionTraceRecorder,
    ): Promise<{ hasSummary: boolean; hasReport: boolean }> {
        const latestSession = this.sessionStore.get(sessionId);
        if (!latestSession) {
            return { hasSummary: false, hasReport: false };
        }

        const previousArtifactFlags = this.isRecord(latestSession.flags?.artifacts)
            ? (latestSession.flags?.artifacts as Record<string, unknown>)
            : undefined;
        const hadSummary = previousArtifactFlags?.hasSummary === true;
        const hadReport = previousArtifactFlags?.hasReport === true;
        const requiresReportOutput = shouldRequireReportForSession(latestSession);
        let saveSucceeded = false;

        try {
            await this.saveArtifacts(latestSession);
            saveSucceeded = true;
        } catch (err) {
            this.log.warn({ err, sessionId }, 'Failed to save artifacts');
            stream.raw('warning', {
                code: 'artifact_persist_failed',
                message: requiresReportOutput
                    ? 'Artifacts were not durably persisted. Completion is blocked until persistence succeeds.'
                    : 'Run-local artifacts were not durably persisted for this turn. Resolve storage pressure if these artifacts are needed.',
            });
        }

        const artifacts = saveSucceeded ? latestSession.artifacts ?? [] : [];
        const hasSummary = artifacts.some((a) => a.originalName.toLowerCase() === this.summaryFileName);
        const hasReport = artifacts.some((a) => a.originalName.toLowerCase() === this.reportFileName);

        if (saveSucceeded && hasSummary && !hadSummary) {
            const summaryArtifact = this.findArtifact(artifacts, this.summaryFileName);
            stream.raw('timeline_event', createTimelineEntry({
                sessionId,
                kind: 'artifact',
                status: 'success',
                title: 'Summary ready',
                source: 'artifact',
                importance: 'medium',
                relatedIds: {
                    artifactId: summaryArtifact?.id,
                },
                metadata: {
                    filePath: summaryArtifact?.filePath,
                    originalName: summaryArtifact?.originalName,
                },
            }));
        }

        if (saveSucceeded && hasReport && !hadReport) {
            const reportArtifact = this.findArtifact(artifacts, this.reportFileName);
            stream.raw('timeline_event', createTimelineEntry({
                sessionId,
                kind: 'artifact',
                status: 'success',
                title: 'Report ready',
                source: 'artifact',
                importance: 'high',
                relatedIds: {
                    artifactId: reportArtifact?.id,
                },
                metadata: {
                    filePath: reportArtifact?.filePath,
                    originalName: reportArtifact?.originalName,
                },
            }));
        }

        if (requiresReportOutput && !hasSummary) {
            stream.raw('warning', {
                code: 'summary_missing',
                message: 'summary.md is required. Create or update it now.',
            });
        }

        return { hasSummary, hasReport };
    }

    /**
     * Collect artifacts using explicit output contract.
     * 
     * OUTPUT CONTRACT:
     * 1. Always: summary.md, report.md (root-level mandatory files)
     * 2. Allowlist: .artifacts/** (explicit outputs directory)
     * 3. Optional: files listed in .artifacts/publish.json manifest
     */
    private async collectExplicitArtifacts(session: SessionState): Promise<SessionArtifact[]> {
        if (!session.workspaceDir || !fs.existsSync(session.workspaceDir)) {
            return [];
        }

        const artifacts: SessionArtifact[] = [];
        const sessionStorageDir = path.join(this.storageRoot, session.id);

        if (!fs.existsSync(sessionStorageDir)) {
            fs.mkdirSync(sessionStorageDir, { recursive: true });
        }

        // 1. Always collect: summary.md, report.md (mandatory files)
        const mandatoryFiles = [this.summaryFileName, this.reportFileName];
        for (const fileName of mandatoryFiles) {
            const srcPath = path.join(session.workspaceDir, fileName);
            if (fs.existsSync(srcPath)) {
                const artifact = this.stageArtifact(srcPath, fileName, sessionStorageDir);
                if (artifact) artifacts.push(artifact);
            }
        }

        // 2. Allowlist: .artifacts/** directory
        const artifactsDir = path.join(session.workspaceDir, '.artifacts');
        if (fs.existsSync(artifactsDir) && fs.statSync(artifactsDir).isDirectory()) {
            const allowlistArtifacts = this.scanArtifactsDirectory(artifactsDir, session.workspaceDir, sessionStorageDir);
            artifacts.push(...allowlistArtifacts);
        }

        // 3. Optional: files listed in .artifacts/publish.json manifest
        const manifestPath = path.join(artifactsDir, 'publish.json');
        if (fs.existsSync(manifestPath)) {
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                const includeList: string[] = manifest.include ?? [];
                for (const relativePath of includeList) {
                    // Skip mandatory files (already collected)
                    if (mandatoryFiles.includes(relativePath)) continue;
                    // Skip .artifacts paths (already collected via allowlist)
                    if (relativePath.startsWith('.artifacts/') || relativePath.startsWith('.artifacts\\')) continue;
                    
                    const srcPath = path.join(session.workspaceDir, relativePath);
                    if (fs.existsSync(srcPath)) {
                        const stat = fs.statSync(srcPath);
                        if (!stat.isFile()) continue;
                        if (isStagingNoiseArtifactPath(relativePath, { sizeBytes: stat.size })) {
                            continue;
                        }
                        const artifact = this.stageArtifact(srcPath, relativePath, sessionStorageDir);
                        if (artifact) artifacts.push(artifact);
                    }
                }
            } catch (err) {
                this.log.warn({ err, sessionId: session.id }, 'Failed to parse .artifacts/publish.json manifest');
            }
        }

        this.log.info(
            { sessionId: session.id, artifactCount: artifacts.length, names: artifacts.map(a => a.originalName) },
            'Collected artifacts using explicit contract'
        );

        return artifacts;
    }

    private async syncRemoteArtifactsIntoWorkspace(session: SessionState): Promise<void> {
        const remoteRunner = this.resolveRemoteRunnerId(session);
        if (!remoteRunner || !session.workspaceDir || !fs.existsSync(session.workspaceDir)) {
            return;
        }

        try {
            const workspaceKey = resolveRunnerWorkspaceKey(session);
            const baseArtifacts = await this.remoteExec.fetchArtifacts({
                runnerId: remoteRunner,
                sessionId: session.id,
                workspaceKey,
                paths: [...REMOTE_ARTIFACT_BASE_PATHS],
            });
            this.persistRemoteArtifacts(session.workspaceDir, baseArtifacts);

            const manifestPath = path.join(session.workspaceDir, '.artifacts', 'publish.json');
            if (!fs.existsSync(manifestPath)) {
                return;
            }

            const includePaths = this.readPublishManifest(manifestPath);
            if (includePaths.length === 0) {
                return;
            }

            const publishedArtifacts = await this.remoteExec.fetchArtifacts({
                runnerId: remoteRunner,
                sessionId: session.id,
                workspaceKey,
                paths: includePaths,
            });
            this.persistRemoteArtifacts(session.workspaceDir, publishedArtifacts);
        } catch (error) {
            this.log.warn({ err: error, sessionId: session.id }, 'Remote artifact sync skipped');
        }
    }

    private persistRemoteArtifacts(workspaceDir: string, artifacts: Map<string, Buffer>): void {
        if (artifacts.size === 0) {
            return;
        }

        const workspaceRoot = path.resolve(workspaceDir);
        for (const [relativePath, content] of artifacts.entries()) {
            const normalized = relativePath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
            if (!normalized) {
                continue;
            }

            const destination = path.resolve(workspaceRoot, normalized);
            if (
                destination !== workspaceRoot &&
                !destination.startsWith(`${workspaceRoot}${path.sep}`)
            ) {
                this.log.warn({ path: relativePath }, 'Ignoring remote artifact outside workspace');
                continue;
            }

            try {
                fs.mkdirSync(path.dirname(destination), { recursive: true });
                fs.writeFileSync(destination, content);
            } catch (error) {
                this.log.warn({ err: error, path: normalized }, 'Failed to persist remote artifact file');
            }
        }
    }

    private readPublishManifest(manifestPath: string): string[] {
        try {
            const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            const include = Array.isArray(parsed?.include) ? parsed.include : [];
            const seen = new Set<string>();
            const filtered: string[] = [];
            for (const entry of include) {
                if (typeof entry !== 'string') continue;
                const candidate = entry.trim().replace(/\\/g, '/').replace(/^\/+/, '');
                if (!candidate || candidate.startsWith('.artifacts/')) continue;
                if (candidate === this.summaryFileName || candidate === this.reportFileName) continue;
                if (seen.has(candidate)) continue;
                seen.add(candidate);
                filtered.push(candidate);
            }
            return filtered;
        } catch (error) {
            this.log.warn({ err: error, manifestPath }, 'Failed to parse remote publish manifest');
            return [];
        }
    }

    private resolveRemoteRunnerId(session: SessionState): string | null {
        const binding = resolveRunnerSessionBinding(session);
        return isScopeRunnerBinding(binding) ? binding.runnerId : null;
    }

    /**
     * Recursively scan .artifacts directory (allowlist only).
     */
    private scanArtifactsDirectory(dir: string, workspaceDir: string, sessionStorageDir: string): SessionArtifact[] {
        const artifacts: SessionArtifact[] = [];
        
        try {
            const entries = fs.readdirSync(dir);
            for (const entry of entries) {
                // Skip the publish.json manifest itself
                if (entry === 'publish.json') continue;
                
                const fullPath = path.join(dir, entry);
                const stat = fs.statSync(fullPath);
                
                if (stat.isDirectory()) {
                    // Recurse into subdirectories within .artifacts
                    artifacts.push(...this.scanArtifactsDirectory(fullPath, workspaceDir, sessionStorageDir));
                } else if (stat.isFile()) {
                    const relativePath = path.relative(workspaceDir, fullPath);
                    if (isStagingNoiseArtifactPath(relativePath, { sizeBytes: stat.size })) {
                        continue;
                    }
                    const artifact = this.stageArtifact(fullPath, relativePath, sessionStorageDir);
                    if (artifact) artifacts.push(artifact);
                }
            }
        } catch (err) {
            this.log.warn({ err, dir }, 'Failed to scan .artifacts directory');
        }
        
        return artifacts;
    }

    /**
     * Stage a single file to the session storage directory and create artifact record.
     */
    private stageArtifact(srcPath: string, relativePath: string, sessionStorageDir: string): SessionArtifact | null {
        try {
            const stat = fs.statSync(srcPath);
            if (!stat.isFile()) return null;

            // Maintain directory structure in storage
            const destPath = path.join(sessionStorageDir, relativePath);
            const destDir = path.dirname(destPath);

            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }

            fs.copyFileSync(srcPath, destPath);

            return {
                id: randomUUID(),
                filePath: path.relative(this.storageRoot, destPath),
                originalName: relativePath,
                fileType: path.extname(srcPath).slice(1) || 'txt',
                sizeBytes: stat.size,
                createdAt: Date.now(),
            };
        } catch (err) {
            this.log.warn({ err, srcPath, relativePath }, 'Failed to stage artifact');
            return null;
        }
    }

    private applyArtifactDerivedState(session: SessionState, artifacts: SessionArtifact[]): void {
        const summaryArtifact = this.findArtifact(artifacts, this.summaryFileName);
        const reportArtifact = this.findArtifact(artifacts, this.reportFileName);

        const artifactFlags: Record<string, unknown> = {
            ...(session.flags?.artifacts as Record<string, unknown> | undefined),
        };
        artifactFlags.hasSummary = Boolean(summaryArtifact);
        artifactFlags.hasReport = Boolean(reportArtifact);
        if (summaryArtifact) {
            artifactFlags.summaryPath = summaryArtifact.filePath;
        } else {
            delete artifactFlags.summaryPath;
        }
        if (reportArtifact) {
            artifactFlags.reportPath = reportArtifact.filePath;
        } else {
            delete artifactFlags.reportPath;
        }

        session.flags = session.flags ?? {};
        session.flags.artifacts = artifactFlags;

        if (summaryArtifact) {
            const summaryContent = this.readArtifactContent(summaryArtifact);
            if (typeof summaryContent === 'string') {
                session.summary = summaryContent;
            }
        } else {
            session.summary = undefined;
        }
    }

    private findArtifact(artifacts: SessionArtifact[], targetName: string): SessionArtifact | undefined {
        return artifacts.find(
            (artifact) => artifact.originalName.toLowerCase() === targetName.toLowerCase(),
        );
    }

    private async readArtifactContent(artifact: SessionArtifact): Promise<string | undefined> {
        if (artifact.filePath.startsWith('s3://') && this.s3) {
            try {
                const parsed = this.parseS3Uri(artifact.filePath);
                if (parsed) {
                    const buffer = await this.s3.client.getObjectBuffer(parsed.key);
                    return this.truncate(buffer.toString('utf-8'), this.config?.trace.artifactMaxChars ?? 20_000);
                }
            } catch (error) {
                this.log.warn({ err: error, path: artifact.filePath }, 'Failed to read artifact content from S3');
            }
            return undefined;
        }

        const localCandidate = artifact.localPath ?? artifact.filePath;
        const absolutePath = path.join(this.storageRoot, localCandidate);
        try {
            const raw = fs.readFileSync(absolutePath, 'utf-8');
            return this.truncate(raw, this.config?.trace.artifactMaxChars ?? 20_000);
        } catch (error) {
            this.log.warn({ err: error, path: absolutePath }, 'Failed to read artifact content');
            return undefined;
        }
    }

    private truncate(value: string, limit: number): string {
        if (!Number.isFinite(limit) || limit <= 0) {
            return value;
        }
        return value.length > limit ? `${value.slice(0, limit)}\n\n...[truncated]` : value;
    }

    async getArtifactContent(sessionId: string, targetName: string): Promise<string | null> {
        const session = this.sessionStore.get(sessionId);
        if (!session?.artifacts) {
            return null;
        }
        const artifact = this.findArtifact(session.artifacts, targetName);
        if (!artifact) {
            return null;
        }
        const content = await this.readArtifactContent(artifact);
        return typeof content === 'string' ? content : null;
    }

    getStorageRoot(): string {
        return this.storageRoot;
    }

    private async persistArtifactRecords(sessionId: string, artifacts: SessionArtifact[]): Promise<void> {
        if (!this.artifactRepository) {
            return;
        }
        await this.sessionStore.waitForSessionPersisted(sessionId);
        await this.artifactRepository.deleteBySession(sessionId);
        if (artifacts.length === 0) {
            return;
        }
        await this.artifactRepository.bulkInsert(
            artifacts.map((artifact) => ({
                id: artifact.id,
                sessionId,
                filePath: artifact.filePath,
                originalName: artifact.originalName,
                fileType: artifact.fileType,
                sizeBytes: artifact.sizeBytes,
                createdAt: new Date(artifact.createdAt),
            })),
        );
    }

    private async uploadToS3(sessionId: string, artifacts: SessionArtifact[]): Promise<void> {
        if (!this.s3) return;
        await this.s3.client.ensureBucket();

        // REMOVED Dec 2025: localMirrorPath - debug mirror feature removed
        let failed = false;

        for (const artifact of artifacts) {
            const originalPath = artifact.filePath;
            const absolutePath = path.join(this.storageRoot, originalPath);
            const key = this.s3.client.makeKey(sessionId, artifact.originalName);
            const success = await this.uploadWithRetry(key, absolutePath);
            if (success) {
                artifact.filePath = `s3://${this.s3.bucket}/${key}`;
                artifact.storage = 's3';
                artifact.bucket = this.s3.bucket;
                artifact.localPath = originalPath;

                // REMOVED Dec 2025: debug mirror feature (keepLocalCopy/localMirrorPath)

                // Always clean staging files after S3 upload (staging is internal)
                fs.rmSync(absolutePath, { force: true });
            } else {
                failed = true;
                this.log.warn(
                    { sessionId, artifact: artifact.originalName },
                    'Failed to upload artifact to S3 after retries; marking session as failed.',
                );
            }
        }

        // Clean up empty session directory in staging after uploads
        const sessionStorageDir = path.join(this.storageRoot, sessionId);
        try {
            if (fs.existsSync(sessionStorageDir)) {
                const remaining = fs.readdirSync(sessionStorageDir);
                if (remaining.length === 0) {
                    fs.rmdirSync(sessionStorageDir);
                }
            }
        } catch {
            // Ignore cleanup errors
        }

        if (failed) {
            throw new Error('artifact_upload_failed');
        }
    }

    private async uploadWithRetry(key: string, absolutePath: string, attempts = 3): Promise<boolean> {
        if (!this.s3) return false;
        let backoff = 250;
        for (let i = 1; i <= attempts; i += 1) {
            try {
                await this.s3.client.uploadFileFromPath(key, absolutePath);
                return true;
            } catch (error: unknown) {
                const { retryable } = this.parseS3Error(error);
                if (i === attempts || !retryable) {
                    this.log.warn(
                        { err: error, path: absolutePath, attempt: i, attempts },
                        'Failed to upload artifact to S3; giving up',
                    );
                    return false;
                }
                await new Promise((r) => setTimeout(r, backoff));
                backoff *= 2;
            }
        }
        return false;
    }

    private parseS3Error(error: unknown): { code?: string; retryable: boolean } {
        if (!this.isRecord(error)) {
            return { retryable: false };
        }
        const code =
            typeof error.Code === 'string'
                ? error.Code
                : typeof error.name === 'string'
                    ? error.name
                    : undefined;
        const retryableFlag = error.$retryable;
        const retryable =
            code === 'SlowDownWrite' ||
            code === 'SlowDown' ||
            retryableFlag === true ||
            (this.isRecord(retryableFlag) && retryableFlag.throttling === true);
        return { code, retryable };
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    private parseS3Uri(uri: string): { bucket: string; key: string } | null {
        if (!uri.startsWith('s3://')) return null;
        const without = uri.replace('s3://', '');
        const parts = without.split('/');
        const bucket = parts.shift();
        if (!bucket) return null;
        return { bucket, key: parts.join('/') };
    }

    // ============================================================================
    // PHASE 4: Durable Artifact Validation
    // ============================================================================

    /**
     * Validate that artifacts exist in S3 before marking task complete.
     * 
     * PROVIDER-ALIGNED: Like Codex/Anthropic, a task is only "done" when
     * the completion artifact exists in durable storage, not just local filesystem.
     * 
     * HARDENING: Distinguishes "not found" from "S3 infra failure".
     * 
     * @returns Object with missing, valid, and s3Error arrays
     */
    async validateS3Artifacts(sessionId: string, artifactNames?: string[]): Promise<{ 
        missing: string[]; 
        valid: string[]; 
        s3Errors: Array<{ name: string; error: Error }>;
    }> {
        const session = this.sessionStore.get(sessionId);
        if (!session?.artifacts || !this.s3) {
            return { missing: artifactNames ?? [], valid: [], s3Errors: [] };
        }

        const toValidate = artifactNames
            ? session.artifacts.filter(a => artifactNames.includes(a.originalName))
            : session.artifacts.filter(a => a.storage === 's3');

        const missing: string[] = [];
        const valid: string[] = [];
        const s3Errors: Array<{ name: string; error: Error }> = [];

        for (const artifact of toValidate) {
            if (!artifact.filePath.startsWith('s3://')) {
                missing.push(artifact.originalName);
                continue;
            }

            const parsed = this.parseS3Uri(artifact.filePath);
            if (!parsed) {
                missing.push(artifact.originalName);
                continue;
            }

            const result = await this.s3.client.objectExistsWithReason(parsed.key);
            
            if (result.exists) {
                valid.push(artifact.originalName);
            } else if (result.reason === 'not_found') {
                missing.push(artifact.originalName);
            } else {
                // S3 infra error - should be retriable
                s3Errors.push({ name: artifact.originalName, error: result.error });
                this.log.warn(
                    { err: result.error, artifact: artifact.originalName, sessionId },
                    '[ArtifactService] S3 infra error during validation (retriable)'
                );
            }
        }

        if (missing.length > 0) {
            this.log.warn(
                { sessionId, missing, valid },
                '[ArtifactService] Some artifacts missing from S3'
            );
        }

        return { missing, valid, s3Errors };
    }

    /**
     * Validate that report.md exists in S3 before marking automated task complete.
     * 
     * @returns true if report.md exists in S3, false otherwise
     * @deprecated Use ensureReportForCompletion for proper error handling
     */
    async validateReportForCompletion(sessionId: string): Promise<boolean> {
        try {
            await this.ensureReportForCompletion(sessionId);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Ensure report.md exists in S3 before marking automated task complete.
     * Throws CompletionBlockedError with proper retryable flag on failure.
     * 
     * COMPLETION CONTRACT: Automated tasks MUST call this before marking "done".
     * 
     * @throws CompletionBlockedError if report.md is missing or S3 is unavailable
     */
    async ensureReportForCompletion(sessionId: string): Promise<void> {
        const { missing, s3Errors } = await this.validateS3Artifacts(sessionId, [this.reportFileName]);
        
        // S3 infra error = retryable
        const reportS3Error = s3Errors.find(e => e.name === this.reportFileName);
        if (reportS3Error) {
            this.log.warn(
                { sessionId, err: reportS3Error.error },
                '[ArtifactService] COMPLETION BLOCKED: S3 unavailable (retryable)'
            );
            throw new CompletionBlockedError({
                reason: 's3_unavailable',
                sessionId,
                artifactName: this.reportFileName,
                message: 'S3 unavailable during completion validation - retry later',
            });
        }
        
        // Genuinely missing = NOT retryable
        if (missing.includes(this.reportFileName)) {
            this.log.warn(
                { sessionId },
                '[ArtifactService] COMPLETION BLOCKED: report.md not found in S3'
            );
            throw new CompletionBlockedError({
                reason: 'report_missing_in_s3',
                sessionId,
                artifactName: this.reportFileName,
                message: 'report.md not found in S3 - cannot complete task',
            });
        }

        this.log.info(
            { sessionId },
            '[ArtifactService] COMPLETION VALIDATED: report.md exists in S3'
        );
    }

    private ensureSyntheticSummary(session: SessionState, artifacts: SessionArtifact[]): void {
        const hasSummary = artifacts.some((a) => a.originalName.toLowerCase() === this.summaryFileName);
        if (!hasSummary && session.summary) {
            const summaryPath = path.join(this.storageRoot, session.id, this.summaryFileName);
            fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
            fs.writeFileSync(summaryPath, session.summary, 'utf-8');
            artifacts.push({
                id: `${session.id}-summary`,
                filePath: path.relative(this.storageRoot, summaryPath),
                originalName: this.summaryFileName,
                fileType: 'md',
                sizeBytes: Buffer.byteLength(session.summary, 'utf-8'),
                createdAt: Date.now(),
                storage: this.s3 ? 's3' : 'local',
                bucket: this.s3?.bucket,
            });
        }
    }
}
