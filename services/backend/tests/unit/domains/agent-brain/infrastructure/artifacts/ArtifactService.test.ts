import { vi, describe, it, expect, beforeEach, beforeAll, afterAll, Mock } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ArtifactService } from '@/domains/agent-brain/infrastructure/artifacts/ArtifactService';
import type { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { StreamBroker } from '@/domains/agent-brain/application/orchestration/streaming/StreamBroker';
import type { ArtifactRepository } from '@/domains/agent-brain/adapters/persistence';
import type { SessionState, SessionArtifact } from '@/domains/agent-brain/domain/types';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

// =============================================================================
// Mock Factories
// =============================================================================

function createMockSessionStore(): SessionStore & { _setSession: (id: string, s: any) => void } {
    const sessions = new Map<string, SessionState>();

    return {
        get: vi.fn((id: string) => sessions.get(id)),
        set: vi.fn((id: string, session: any) => sessions.set(id, session)),
        waitForSessionPersisted: vi.fn().mockResolvedValue(undefined),
        _setSession: (id: string, session: any) => sessions.set(id, session),
    } as unknown as SessionStore & { _setSession: (id: string, s: any) => void };
}

function createMockArtifactRepository(): ArtifactRepository {
    const artifacts = new Map<string, any[]>();

    return {
        bulkInsert: vi.fn(async (records: any[]) => {
            if (records.length === 0) return;
            const sessionId = records[0].sessionId;
            artifacts.set(sessionId, records);
        }),
        deleteBySession: vi.fn(async (sessionId: string) => {
            artifacts.delete(sessionId);
        }),
        findBySession: vi.fn(async (sessionId: string) => artifacts.get(sessionId) ?? []),
    } as unknown as ArtifactRepository;
}

function createMockS3Client() {
    return {
        ensureBucket: vi.fn().mockResolvedValue(undefined),
        uploadFileFromPath: vi.fn().mockResolvedValue(undefined),
        getObjectBuffer: vi.fn().mockResolvedValue(Buffer.from('test content')),
        makeKey: vi.fn((sessionId: string, filename: string) => `${sessionId}/${filename}`),
    };
}

function createTestSession(overrides: Partial<SessionState> = {}): SessionState {
    return {
        id: 'test-session-123',
        status: 'running',
        mode: 'interactive',
        turn: 0,
        history: [],
        plan: [],
        memory: createEmptyMemory(),
        pendingApproval: undefined,
        checkpoints: [],
        artifacts: [],
        flags: {},
        toolPolicy: {},
        createdAt: Date.now(),
        lastActive: Date.now(),
        ...overrides,
    } as SessionState;
}

// Use a unique temp directory per test run to avoid cross-test pollution
const TEST_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-tests-'));
const resetStorageRoot = () => {
    fs.rmSync(TEST_STORAGE_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TEST_STORAGE_ROOT, { recursive: true });
};

beforeAll(() => {
    resetStorageRoot();
});

beforeEach(() => {
    resetStorageRoot();
});

afterAll(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_STORAGE_ROOT)) {
        fs.rmSync(TEST_STORAGE_ROOT, { recursive: true, force: true });
    }
});

// =============================================================================
// Tests
// =============================================================================
describe('ArtifactService', () => {
    describe('constructor', () => {
        it('should initialize with session store only', () => {
            const sessionStore = createMockSessionStore();
            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                undefined,
                TEST_STORAGE_ROOT
            );
            expect(service).toBeDefined();
        });

        it('should initialize with all dependencies', () => {
            const sessionStore = createMockSessionStore();
            const artifactRepository = createMockArtifactRepository();
            const s3Client = createMockS3Client();

            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                artifactRepository,
                TEST_STORAGE_ROOT,
                { bucket: 'test-bucket', client: s3Client as any }
            );
            expect(service).toBeDefined();
        });
    });

    describe('getStorageRoot', () => {
        it('should return the configured storage root', () => {
            const sessionStore = createMockSessionStore();
            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                undefined,
                TEST_STORAGE_ROOT
            );

            expect(service.getStorageRoot()).toBe(TEST_STORAGE_ROOT);
        });
    });

    describe('getArtifactContent', () => {
        it('should return null for non-existent session', async () => {
            const sessionStore = createMockSessionStore();
            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                undefined,
                TEST_STORAGE_ROOT
            );

            const content = await service.getArtifactContent('nonexistent-session', 'report.md');
            expect(content).toBeNull();
        });

        it('should return null for session without artifacts', async () => {
            const sessionStore = createMockSessionStore();
            const session = createTestSession({ artifacts: [] });
            sessionStore._setSession('s1', session);

            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                undefined,
                TEST_STORAGE_ROOT
            );

            const content = await service.getArtifactContent('s1', 'report.md');
            expect(content).toBeNull();
        });

        it('should return null for non-existent artifact', async () => {
            const sessionStore = createMockSessionStore();
            const session = createTestSession({
                artifacts: [{
                    id: 'art-1',
                    filePath: 'test-session-123/other.txt',
                    originalName: 'other.txt',
                    fileType: 'txt',
                    sizeBytes: 100,
                    createdAt: Date.now(),
                }],
            });
            sessionStore._setSession('s1', session);

            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                undefined,
                TEST_STORAGE_ROOT
            );

            const content = await service.getArtifactContent('s1', 'report.md');
            expect(content).toBeNull();
        });

        it('should read content from local file', async () => {
            const sessionStore = createMockSessionStore();

            // Create test file
            const sessionDir = path.join(TEST_STORAGE_ROOT, 'read-test-session');
            fs.mkdirSync(sessionDir, { recursive: true });
            const testFilePath = path.join(sessionDir, 'report.md');
            fs.writeFileSync(testFilePath, '# Test Report\n\nThis is test content.');

            const session = createTestSession({
                id: 'read-test-session',
                artifacts: [{
                    id: 'art-1',
                    filePath: 'read-test-session/report.md',
                    originalName: 'report.md',
                    fileType: 'md',
                    sizeBytes: 100,
                    createdAt: Date.now(),
                }],
            });
            sessionStore._setSession('read-test-session', session);

            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                undefined,
                TEST_STORAGE_ROOT
            );

            const content = await service.getArtifactContent('read-test-session', 'report.md');
            expect(content).toBe('# Test Report\n\nThis is test content.');
        });

        it('should find artifact case-insensitively', async () => {
            const sessionStore = createMockSessionStore();

            // Create test file
            const sessionDir = path.join(TEST_STORAGE_ROOT, 'case-test-session');
            fs.mkdirSync(sessionDir, { recursive: true });
            fs.writeFileSync(path.join(sessionDir, 'Summary.MD'), 'Test summary content');

            const session = createTestSession({
                id: 'case-test-session',
                artifacts: [{
                    id: 'art-1',
                    filePath: 'case-test-session/Summary.MD',
                    originalName: 'Summary.MD',
                    fileType: 'md',
                    sizeBytes: 50,
                    createdAt: Date.now(),
                }],
            });
            sessionStore._setSession('case-test-session', session);

            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                undefined,
                TEST_STORAGE_ROOT
            );

            // Should find regardless of case
            const content = await service.getArtifactContent('case-test-session', 'summary.md');
            expect(content).toBe('Test summary content');
        });
    });

    describe('saveArtifacts', () => {
        it('should persist artifact records to repository', async () => {
            const sessionStore = createMockSessionStore();
            const artifactRepository = createMockArtifactRepository();

            // Create test file in workspace
            const sessionDir = path.join(TEST_STORAGE_ROOT, 'save-test-session');
            fs.mkdirSync(sessionDir, { recursive: true });
            fs.writeFileSync(path.join(sessionDir, 'output.txt'), 'Test output');

            const session = createTestSession({ id: 'save-test-session', workspaceDir: sessionDir });
            sessionStore._setSession('save-test-session', session);

            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                artifactRepository,
                TEST_STORAGE_ROOT
            );

            await service.saveArtifacts(session);

            // Should have called deleteBySession first
            expect(artifactRepository.deleteBySession).toHaveBeenCalledWith('save-test-session');
        });

        it('should update session with artifacts', async () => {
            const sessionStore = createMockSessionStore();

            // Create test file in workspace
            const sessionDir = path.join(TEST_STORAGE_ROOT, 'update-test-session');
            fs.mkdirSync(sessionDir, { recursive: true });
            fs.writeFileSync(path.join(sessionDir, 'data.json'), '{"test": true}');

            const session = createTestSession({ id: 'update-test-session', workspaceDir: sessionDir });
            sessionStore._setSession('update-test-session', session);

            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                undefined,
                TEST_STORAGE_ROOT
            );

            await service.saveArtifacts(session);

            // Session should be updated
            expect(sessionStore.set).toHaveBeenCalled();
        });

        it('should set hasSummary flag when summary.md exists', async () => {
            const sessionStore = createMockSessionStore();

            // Create summary.md file
            const sessionDir = path.join(TEST_STORAGE_ROOT, 'summary-flag-session');
            fs.mkdirSync(sessionDir, { recursive: true });
            fs.writeFileSync(path.join(sessionDir, 'summary.md'), '# Summary\nTest');

            const session = createTestSession({ id: 'summary-flag-session', workspaceDir: sessionDir });
            sessionStore._setSession('summary-flag-session', session);

            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                undefined,
                TEST_STORAGE_ROOT
            );

            await service.saveArtifacts(session);

            // Check session was updated with artifacts flag
            const setCall = (sessionStore.set as Mock).mock.calls.find(
                (c: any[]) => c[0] === 'summary-flag-session'
            );
            if (setCall) {
                const updatedSession = setCall[1] as SessionState;
                expect((updatedSession.flags?.artifacts as any)?.hasSummary).toBe(true);
            }
        });

        it('should set hasReport flag when report.md exists', async () => {
            const sessionStore = createMockSessionStore();

            // Create report.md file
            const sessionDir = path.join(TEST_STORAGE_ROOT, 'report-flag-session');
            fs.mkdirSync(sessionDir, { recursive: true });
            fs.writeFileSync(path.join(sessionDir, 'report.md'), '# Report\nFindings');

            const session = createTestSession({ id: 'report-flag-session', workspaceDir: sessionDir });
            sessionStore._setSession('report-flag-session', session);

            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                undefined,
                TEST_STORAGE_ROOT
            );

            await service.saveArtifacts(session);

            const setCall = (sessionStore.set as Mock).mock.calls.find(
                (c: any[]) => c[0] === 'report-flag-session'
            );
            if (setCall) {
                const updatedSession = setCall[1] as SessionState;
                expect((updatedSession.flags?.artifacts as any)?.hasReport).toBe(true);
            }
        });

        it('blocks completion when artifact metadata persistence fails', async () => {
            const sessionStore = createMockSessionStore();
            const artifactRepository = {
                bulkInsert: vi.fn().mockRejectedValue(new Error('artifact insert failed')),
                deleteBySession: vi.fn().mockResolvedValue(undefined),
            } as unknown as ArtifactRepository;

            const sessionDir = path.join(TEST_STORAGE_ROOT, 'durability-failure-session');
            fs.mkdirSync(sessionDir, { recursive: true });
            fs.writeFileSync(path.join(sessionDir, 'report.md'), '# Report\nFindings');

            const session = createTestSession({
                id: 'durability-failure-session',
                mode: 'automated',
                workspaceDir: sessionDir,
            });
            sessionStore._setSession('durability-failure-session', session);

            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                artifactRepository,
                TEST_STORAGE_ROOT
            );
            const events: Array<{ type: string; data?: unknown }> = [];
            const stream = new StreamBroker((event) => events.push(event));

            const result = await service.flush(session.id, 1, stream);

            expect(result.hasReport).toBe(false);
            expect(events).toContainEqual(
                expect.objectContaining({
                    type: 'warning',
                    data: expect.objectContaining({ code: 'artifact_persist_failed' }),
                }),
            );
        });

        it('does not require summary.md for non-reporting security phases or workers', async () => {
            const cases = [
                createTestSession({
                    id: 'enumeration-no-summary-session',
                    mode: 'automated',
                    workspaceDir: path.join(TEST_STORAGE_ROOT, 'enumeration-no-summary-session'),
                    flags: { securityops: { activePhaseKey: 'enumeration' } },
                }),
                createTestSession({
                    id: 'worker-no-summary-session',
                    mode: 'automated',
                    workspaceDir: path.join(TEST_STORAGE_ROOT, 'worker-no-summary-session'),
                    coordination: { role: 'worker' },
                }),
            ];

            for (const session of cases) {
                const sessionStore = createMockSessionStore();
                fs.mkdirSync(session.workspaceDir!, { recursive: true });
                sessionStore._setSession(session.id, session);
                const service = new ArtifactService(
                    sessionStore as unknown as SessionStore,
                    undefined,
                    TEST_STORAGE_ROOT
                );
                const events: Array<{ type: string; data?: unknown }> = [];
                const stream = new StreamBroker((event) => events.push(event));

                const result = await service.flush(session.id, 1, stream);

                expect(result.hasSummary).toBe(false);
                expect(events).not.toContainEqual(
                    expect.objectContaining({
                        type: 'warning',
                        data: expect.objectContaining({ code: 'summary_missing' }),
                    }),
                );
            }
        });

        it('emits summary-ready and report-ready timeline events on first flush', async () => {
            const sessionStore = createMockSessionStore();
            const sessionDir = path.join(TEST_STORAGE_ROOT, 'timeline-flush-session');
            fs.mkdirSync(sessionDir, { recursive: true });
            fs.writeFileSync(path.join(sessionDir, 'summary.md'), '# Summary');
            fs.writeFileSync(path.join(sessionDir, 'report.md'), '# Report');

            const session = createTestSession({
                id: 'timeline-flush-session',
                workspaceDir: sessionDir,
                flags: { artifacts: { hasSummary: false, hasReport: false } },
            });
            sessionStore._setSession('timeline-flush-session', session);

            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                undefined,
                TEST_STORAGE_ROOT
            );
            const events: Array<{ type: string; data?: unknown }> = [];
            const stream = new StreamBroker((event) => events.push(event));

            const result = await service.flush(session.id, 1, stream);

            expect(result).toEqual({ hasSummary: true, hasReport: true });
            expect(events).toContainEqual(
                expect.objectContaining({
                    type: 'timeline_event',
                    data: expect.objectContaining({ title: 'Summary ready', kind: 'artifact' }),
                }),
            );
            expect(events).toContainEqual(
                expect.objectContaining({
                    type: 'timeline_event',
                    data: expect.objectContaining({ title: 'Report ready', kind: 'artifact' }),
                }),
            );
        });
    });

    describe('S3 integration', () => {
        it('should upload artifacts to S3 when configured', async () => {
            const sessionStore = createMockSessionStore();
            const s3Client = createMockS3Client();

            // Create test file
            const sessionDir = path.join(TEST_STORAGE_ROOT, 's3-test-session');
            fs.mkdirSync(sessionDir, { recursive: true });
            fs.writeFileSync(path.join(sessionDir, 'upload.txt'), 'Content to upload');

            const session = createTestSession({ id: 's3-test-session', workspaceDir: sessionDir });
            sessionStore._setSession('s3-test-session', session);

            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                undefined,
                TEST_STORAGE_ROOT,
                { bucket: 'test-bucket', client: s3Client as any }
            );

            await service.saveArtifacts(session);

            // Should have ensured bucket exists
            expect(s3Client.ensureBucket).toHaveBeenCalled();
        });

        it('should update artifact path to S3 URI after upload', async () => {
            const sessionStore = createMockSessionStore();
            const s3Client = createMockS3Client();

            // Create test file
            const sessionDir = path.join(TEST_STORAGE_ROOT, 's3-uri-session');
            fs.mkdirSync(sessionDir, { recursive: true });
            fs.writeFileSync(path.join(sessionDir, 'test-file.md'), 'Content');

            const session = createTestSession({ id: 's3-uri-session', workspaceDir: sessionDir });
            sessionStore._setSession('s3-uri-session', session);

            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                undefined,
                TEST_STORAGE_ROOT,
                { bucket: 'my-bucket', client: s3Client as any }
            );

            await service.saveArtifacts(session);

            // Check that artifacts have S3 URIs
            const setCall = (sessionStore.set as Mock).mock.calls.find(
                (c: any[]) => c[0] === 's3-uri-session'
            );
            if (setCall && setCall[1].artifacts?.length > 0) {
                const artifact = setCall[1].artifacts[0];
                expect(artifact.filePath).toMatch(/^s3:\/\//);
                expect(artifact.storage).toBe('s3');
            }
        });
    });

    describe('ensureSyntheticSummary', () => {
        it('should create summary.md from session.summary when no summary artifact exists', async () => {
            const sessionStore = createMockSessionStore();

            // Session with summary but no summary.md file
            const sessionDir = path.join(TEST_STORAGE_ROOT, 'synthetic-summary-session');
            fs.mkdirSync(sessionDir, { recursive: true });
            // No summary.md file created - the ensureSyntheticSummary should create one

            const session = createTestSession({
                id: 'synthetic-summary-session',
                workspaceDir: sessionDir,
                summary: 'This is the session summary.',
            });
            sessionStore._setSession('synthetic-summary-session', session);

            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                undefined,
                TEST_STORAGE_ROOT
            );

            await service.saveArtifacts(session);

            // Verify sessionStore.set was called
            expect(sessionStore.set).toHaveBeenCalled();

            // Check that synthetic summary was created
            const setCall = (sessionStore.set as Mock).mock.calls.find(
                (c: any[]) => c[0] === 'synthetic-summary-session'
            );
            expect(setCall).toBeDefined();

            const updatedSession = setCall![1] as SessionState;
            expect(updatedSession.artifacts).toBeDefined();
            expect(updatedSession.artifacts!.length).toBeGreaterThanOrEqual(1);

            const summaryArtifact = updatedSession.artifacts?.find(
                (a: any) => a.originalName === 'summary.md'
            );
            expect(summaryArtifact).toBeDefined();
            expect(summaryArtifact!.originalName).toBe('summary.md');
        });
    });

    describe('truncate', () => {
        it('should truncate content exceeding limit', async () => {
            const sessionStore = createMockSessionStore();

            // Create a large file
            const sessionDir = path.join(TEST_STORAGE_ROOT, 'truncate-session');
            fs.mkdirSync(sessionDir, { recursive: true });
            const largeContent = 'x'.repeat(50000);
            fs.writeFileSync(path.join(sessionDir, 'large.md'), largeContent);

            const session = createTestSession({
                id: 'truncate-session',
                artifacts: [{
                    id: 'art-1',
                    filePath: 'truncate-session/large.md',
                    originalName: 'large.md',
                    fileType: 'md',
                    sizeBytes: 50000,
                    createdAt: Date.now(),
                }],
            });
            sessionStore._setSession('truncate-session', session);

            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                undefined,
                TEST_STORAGE_ROOT,
                undefined,
                { trace: { artifactMaxChars: 1000 } } as any
            );

            const content = await service.getArtifactContent('truncate-session', 'large.md');
            expect(content).toBeDefined();
            expect(content!.length).toBeLessThan(2000);
            expect(content).toContain('...[truncated]');
        });
    });

    describe('explicit artifact collection', () => {
        it('syncs remote artifacts into workspace for internal sessions before collecting', async () => {
            const sessionStore = createMockSessionStore();
            const sessionDir = path.join(TEST_STORAGE_ROOT, 'remote-sync-session');
            fs.mkdirSync(sessionDir, { recursive: true });

            const session = createTestSession({
                id: 'remote-sync-session',
                workspaceDir: sessionDir,
                flags: {
                    securityops: {
                        executionTarget: 'scope_runner',
                        runnerId: 'runner-123',
                    },
                },
            });
            sessionStore._setSession('remote-sync-session', session);

            const fetchArtifacts = vi
                .fn()
                .mockResolvedValueOnce(
                    new Map<string, Buffer>([
                        ['summary.md', Buffer.from('# Remote Summary')],
                        ['report.md', Buffer.from('# Remote Report')],
                        ['.artifacts/publish.json', Buffer.from(JSON.stringify({ include: ['extra.txt'] }))],
                    ]),
                )
                .mockResolvedValueOnce(
                    new Map<string, Buffer>([['extra.txt', Buffer.from('extra remote content')]]),
                );

            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                undefined,
                TEST_STORAGE_ROOT,
                undefined,
                undefined,
                { fetchArtifacts } as any,
            );

            await service.saveArtifacts(session);

            expect(fetchArtifacts).toHaveBeenCalledTimes(2);
            expect(fetchArtifacts).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    runnerId: 'runner-123',
                    sessionId: 'remote-sync-session',
                    paths: expect.arrayContaining(['summary.md', 'report.md', '.artifacts']),
                }),
            );
            expect(fetchArtifacts).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    runnerId: 'runner-123',
                    sessionId: 'remote-sync-session',
                    paths: ['extra.txt'],
                }),
            );

            const persistedSession = (sessionStore.set as Mock).mock.calls
                .find((call: any[]) => call[0] === 'remote-sync-session')?.[1] as SessionState | undefined;
            expect(persistedSession?.artifacts?.some((artifact) => artifact.originalName === 'summary.md')).toBe(true);
            expect(persistedSession?.artifacts?.some((artifact) => artifact.originalName === 'report.md')).toBe(true);
            expect(persistedSession?.artifacts?.some((artifact) => artifact.originalName === 'extra.txt')).toBe(true);
            expect(fs.readFileSync(path.join(sessionDir, 'report.md'), 'utf-8')).toBe('# Remote Report');
        });

        it('collects files listed in publish.json', async () => {
            const sessionStore = createMockSessionStore();
            const sessionDir = path.join(TEST_STORAGE_ROOT, 'publish-session');
            fs.mkdirSync(path.join(sessionDir, '.artifacts'), { recursive: true });
            fs.writeFileSync(path.join(sessionDir, 'extra.txt'), 'Extra file');
            fs.writeFileSync(
                path.join(sessionDir, '.artifacts', 'publish.json'),
                JSON.stringify({ include: ['extra.txt'] }),
            );

            const session = createTestSession({ id: 'publish-session', workspaceDir: sessionDir });
            sessionStore._setSession('publish-session', session);
            const service = new ArtifactService(sessionStore as unknown as SessionStore, undefined, TEST_STORAGE_ROOT);

            await service.saveArtifacts(session);

            const setCall = (sessionStore.set as Mock).mock.calls.find((c: any[]) => c[0] === 'publish-session');
            const updatedSession = setCall?.[1] as SessionState;
            expect(updatedSession.artifacts?.some((a) => a.originalName === 'extra.txt')).toBe(true);
        });

        it('filters operational shell and proxy scaffolding while preserving evidence files', async () => {
            const sessionStore = createMockSessionStore();
            const sessionDir = path.join(TEST_STORAGE_ROOT, 'filtered-artifacts-session');
            const shellJobDir = path.join(sessionDir, '.artifacts', 'shell-jobs', 'job-1');
            fs.mkdirSync(shellJobDir, { recursive: true });
            fs.mkdirSync(path.join(sessionDir, '.artifacts', 'proxy'), { recursive: true });
            fs.mkdirSync(path.join(sessionDir, '.artifacts', 'broad'), { recursive: true });
            fs.mkdirSync(path.join(sessionDir, '.artifacts', 'vuln'), { recursive: true });
            fs.mkdirSync(path.join(sessionDir, '.mitmproxy'), { recursive: true });

            fs.writeFileSync(path.join(shellJobDir, 'command.sh'), 'httpx -json\n');
            fs.writeFileSync(path.join(shellJobDir, 'runner.sh'), '#!/usr/bin/env bash\n');
            fs.writeFileSync(path.join(shellJobDir, 'status.json'), '{"status":"completed","exitCode":0}\n');
            fs.writeFileSync(path.join(shellJobDir, 'stdout.log'), '{"url":"https://example.com"}\n');
            fs.writeFileSync(path.join(shellJobDir, 'stderr.log'), '');
            fs.writeFileSync(path.join(shellJobDir, 'pid'), '123');
            fs.writeFileSync(path.join(sessionDir, '.artifacts', 'proxy', 'mitmproxy.log'), 'proxy started\n');
            fs.writeFileSync(path.join(sessionDir, '.artifacts', 'proxy', 'mitmproxy.pid'), '456');
            fs.writeFileSync(path.join(sessionDir, '.artifacts', 'broad', 'httpx.jsonl'), '{"url":"https://example.com"}\n');
            fs.writeFileSync(path.join(sessionDir, '.artifacts', 'vuln', 'proof.log'), 'proof\n');
            fs.writeFileSync(path.join(sessionDir, '.artifacts', 'vuln', 'empty.log'), '');
            fs.writeFileSync(path.join(sessionDir, '.mitmproxy', 'mitmproxy-ca-cert.pem'), 'internal-ca');
            fs.writeFileSync(
                path.join(sessionDir, '.artifacts', 'publish.json'),
                JSON.stringify({ include: ['.mitmproxy/mitmproxy-ca-cert.pem'] }),
            );

            const session = createTestSession({ id: 'filtered-artifacts-session', workspaceDir: sessionDir });
            sessionStore._setSession('filtered-artifacts-session', session);
            const service = new ArtifactService(sessionStore as unknown as SessionStore, undefined, TEST_STORAGE_ROOT);

            await service.saveArtifacts(session);

            const setCall = (sessionStore.set as Mock).mock.calls.find((c: any[]) => c[0] === 'filtered-artifacts-session');
            const updatedSession = setCall?.[1] as SessionState;
            const names = updatedSession.artifacts
                ?.map((artifact) => artifact.originalName.replace(/\\/g, '/'))
                .sort() ?? [];

            expect(names).toEqual(expect.arrayContaining([
                '.artifacts/broad/httpx.jsonl',
                '.artifacts/shell-jobs/job-1/command.sh',
                '.artifacts/shell-jobs/job-1/status.json',
                '.artifacts/shell-jobs/job-1/stdout.log',
                '.artifacts/vuln/proof.log',
            ]));
            expect(names).not.toContain('.artifacts/shell-jobs/job-1/runner.sh');
            expect(names).not.toContain('.artifacts/shell-jobs/job-1/pid');
            expect(names).not.toContain('.artifacts/shell-jobs/job-1/stderr.log');
            expect(names).not.toContain('.artifacts/proxy/mitmproxy.log');
            expect(names).not.toContain('.artifacts/proxy/mitmproxy.pid');
            expect(names).not.toContain('.artifacts/vuln/empty.log');
            expect(names).not.toContain('.mitmproxy/mitmproxy-ca-cert.pem');
        });

        it('ignores invalid publish.json manifests without crashing', async () => {
            const sessionStore = createMockSessionStore();
            const sessionDir = path.join(TEST_STORAGE_ROOT, 'bad-manifest-session');
            fs.mkdirSync(path.join(sessionDir, '.artifacts'), { recursive: true });
            fs.writeFileSync(path.join(sessionDir, 'summary.md'), 'Summary');
            fs.writeFileSync(path.join(sessionDir, '.artifacts', 'publish.json'), '{invalid-json');

            const session = createTestSession({ id: 'bad-manifest-session', workspaceDir: sessionDir });
            sessionStore._setSession('bad-manifest-session', session);
            const service = new ArtifactService(sessionStore as unknown as SessionStore, undefined, TEST_STORAGE_ROOT);

            await expect(service.saveArtifacts(session)).resolves.toBeUndefined();
            const setCall = (sessionStore.set as Mock).mock.calls.find((c: any[]) => c[0] === 'bad-manifest-session');
            const updatedSession = setCall?.[1] as SessionState;
            expect(updatedSession.artifacts?.some((a) => a.originalName === 'summary.md')).toBe(true);
        });
    });

    describe('S3 validation and reads', () => {
        it('reads artifact content from S3 URIs', async () => {
            const sessionStore = createMockSessionStore();
            const s3Client = {
                getObjectBuffer: vi.fn().mockResolvedValue(Buffer.from('s3-body')),
            };

            const session = createTestSession({
                id: 's3-read-session',
                artifacts: [
                    {
                        id: 'art-1',
                        filePath: 's3://test-bucket/s3-read-session/report.md',
                        originalName: 'report.md',
                        fileType: 'md',
                        sizeBytes: 10,
                        createdAt: Date.now(),
                        storage: 's3',
                    },
                ],
            });
            sessionStore._setSession('s3-read-session', session);

            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                undefined,
                TEST_STORAGE_ROOT,
                { bucket: 'test-bucket', client: s3Client as any },
            );

            const content = await service.getArtifactContent('s3-read-session', 'report.md');
            expect(content).toBe('s3-body');
            expect(s3Client.getObjectBuffer).toHaveBeenCalledWith('s3-read-session/report.md');
        });

        it('returns missing and s3Errors during validation', async () => {
            const sessionStore = createMockSessionStore();
            const s3Client = {
                objectExistsWithReason: vi
                    .fn()
                    .mockResolvedValueOnce({ exists: false, reason: 'not_found' })
                    .mockResolvedValueOnce({ exists: false, reason: 's3_error', error: new Error('down') }),
            };

            const session = createTestSession({
                id: 's3-validate-session',
                artifacts: [
                    {
                        id: 'art-1',
                        filePath: 's3://bucket/a/report.md',
                        originalName: 'report.md',
                        fileType: 'markdown',
                        sizeBytes: 10,
                        createdAt: Date.now(),
                        storage: 's3',
                    },
                    {
                        id: 'art-2',
                        filePath: 's3://bucket/a/summary.md',
                        originalName: 'summary.md',
                        fileType: 'markdown',
                        sizeBytes: 12,
                        createdAt: Date.now(),
                        storage: 's3',
                    },
                ],
            });
            sessionStore._setSession('s3-validate-session', session);

            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                undefined,
                TEST_STORAGE_ROOT,
                { bucket: 'bucket', client: s3Client as any },
            );

            const result = await service.validateS3Artifacts('s3-validate-session');
            expect(result.missing).toEqual(['report.md']);
            expect(result.s3Errors[0].name).toBe('summary.md');
        });
    });

    describe('S3 retry behavior', () => {
        it('retries uploads when S3 responds with SlowDown', async () => {
            const sessionStore = createMockSessionStore();
            const s3Client = {
                ensureBucket: vi.fn().mockResolvedValue(undefined),
                uploadFileFromPath: vi
                    .fn()
                    .mockRejectedValueOnce({ Code: 'SlowDown' })
                    .mockResolvedValueOnce(undefined),
                getObjectBuffer: vi.fn().mockResolvedValue(Buffer.from('ok')),
                makeKey: vi.fn((sessionId: string, filename: string) => `${sessionId}/${filename}`),
            };

            const sessionDir = path.join(TEST_STORAGE_ROOT, 's3-retry-session');
            fs.mkdirSync(sessionDir, { recursive: true });
            fs.writeFileSync(path.join(sessionDir, 'report.md'), 'Report content');

            const session = createTestSession({ id: 's3-retry-session', workspaceDir: sessionDir });
            sessionStore._setSession('s3-retry-session', session);

            const service = new ArtifactService(
                sessionStore as unknown as SessionStore,
                undefined,
                TEST_STORAGE_ROOT,
                { bucket: 'bucket', client: s3Client as any },
            );

            await service.saveArtifacts(session);

            expect(s3Client.uploadFileFromPath).toHaveBeenCalledTimes(2);
        });
    });
});







