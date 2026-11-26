import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, type Mock } from 'vitest';
/**
 * Integration tests for SessionTraceRecorder workspace S3/MinIO sync.
 * 
 * Tests the syncWorkspaceToS3 method with mocked S3 storage service.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionTraceRecorder } from '@/domains/agent-brain/infrastructure/telemetry';

describe('SessionTraceRecorder Workspace Sync Integration', () => {
    let tempWorkspace: string;
    let mockS3Client: {
        ensureBucket: Mock;
        uploadFileFromPath: Mock;
        uploadBuffer: Mock;
    };
    let recorder: SessionTraceRecorder;

    beforeEach(() => {
        // Create temp workspace
        tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-test-'));

        // Create test files
        fs.writeFileSync(path.join(tempWorkspace, 'file1.txt'), 'Test content 1');
        fs.writeFileSync(path.join(tempWorkspace, 'file2.py'), 'print("hello")');
        fs.mkdirSync(path.join(tempWorkspace, 'src'));
        fs.writeFileSync(path.join(tempWorkspace, 'src', 'main.ts'), 'export const x = 1;');

        // Create .git and node_modules (should be excluded)
        fs.mkdirSync(path.join(tempWorkspace, '.git'));
        fs.writeFileSync(path.join(tempWorkspace, '.git', 'config'), 'git config');
        fs.mkdirSync(path.join(tempWorkspace, 'node_modules'));
        fs.writeFileSync(path.join(tempWorkspace, 'node_modules', 'package.json'), '{}');

        // Create .env (should be excluded)
        fs.writeFileSync(path.join(tempWorkspace, '.env'), 'SECRET=value');

        // Mock S3 client
        mockS3Client = {
            ensureBucket: vi.fn().mockResolvedValue(undefined),
            uploadFileFromPath: vi.fn().mockResolvedValue(undefined),
            uploadBuffer: vi.fn().mockResolvedValue(undefined),
        };

        // Create recorder with mock S3
        recorder = new SessionTraceRecorder(
            { rootDir: tempWorkspace },
            { client: mockS3Client as any, bucket: 'test-bucket' },
        );
    });

    afterEach(() => {
        // Cleanup temp workspace
        fs.rmSync(tempWorkspace, { recursive: true, force: true });
        vi.clearAllMocks();
    });

    describe('syncWorkspaceToS3', () => {
        it('should upload workspace files to S3 with correct keys', async () => {
            // Act
            const result = await recorder.syncWorkspaceToS3('session-123', tempWorkspace);

            // Assert
            expect(result.success).toBe(true);
            expect(result.filesUploaded).toBeGreaterThan(0);
            expect(result.errors).toHaveLength(0);

            // Verify S3 client calls
            expect(mockS3Client.ensureBucket).toHaveBeenCalled();

            // Check uploaded files have correct prefix
            const uploadCalls = mockS3Client.uploadFileFromPath.mock.calls;
            const uploadedKeys = uploadCalls.map(call => call[0]);

            expect(uploadedKeys.some(k => k.startsWith('workspaces/session-123/'))).toBe(true);
            expect(uploadedKeys.some(k => k.includes('file1.txt'))).toBe(true);
            expect(uploadedKeys.some(k => k.includes('src/main.ts'))).toBe(true);
        });

        it('should exclude .git, node_modules, and .env by default', async () => {
            // Act
            await recorder.syncWorkspaceToS3('session-123', tempWorkspace);

            // Assert
            const uploadCalls = mockS3Client.uploadFileFromPath.mock.calls;
            const uploadedKeys = uploadCalls.map(call => call[0]);

            // Should NOT include excluded paths
            expect(uploadedKeys.some(k => k.includes('.git'))).toBe(false);
            expect(uploadedKeys.some(k => k.includes('node_modules'))).toBe(false);
            expect(uploadedKeys.some(k => k.includes('.env'))).toBe(false);
        });

        it('should write manifest file to S3', async () => {
            // Act
            await recorder.syncWorkspaceToS3('session-123', tempWorkspace);

            // Assert
            const bufferCalls = mockS3Client.uploadBuffer.mock.calls;
            const manifestCall = bufferCalls.find(call => call[0].includes('_manifest.json'));

            expect(manifestCall).toBeDefined();

            // Parse manifest content
            const manifestContent = JSON.parse(manifestCall![1].toString());
            expect(manifestContent.sessionId).toBe('session-123');
            expect(manifestContent.filesUploaded).toBeGreaterThan(0);
            expect(manifestContent.syncedAt).toBeDefined();
        });

        it('should respect maxFiles limit', async () => {
            // Create many files
            for (let i = 0; i < 20; i++) {
                fs.writeFileSync(path.join(tempWorkspace, `extra-${i}.txt`), `content ${i}`);
            }

            // Act
            const result = await recorder.syncWorkspaceToS3('session-123', tempWorkspace, {
                maxFiles: 5,
            });

            // Assert
            expect(result.filesUploaded).toBeLessThanOrEqual(5);
        });

        it('should return error when S3 not configured', async () => {
            // Create recorder without S3
            const localRecorder = new SessionTraceRecorder({ rootDir: tempWorkspace });

            // Act
            const result = await localRecorder.syncWorkspaceToS3('session-123', tempWorkspace);

            // Assert
            expect(result.success).toBe(false);
            expect(result.errors).toContain('S3 not configured');
        });

        it('should handle upload errors gracefully', async () => {
            // Make S3 fail for some files
            mockS3Client.uploadFileFromPath.mockImplementation(async (key: string) => {
                if (key.includes('file1.txt')) {
                    throw new Error('Network error');
                }
                return undefined;
            });

            // Act
            const result = await recorder.syncWorkspaceToS3('session-123', tempWorkspace);

            // Assert
            expect(result.success).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors.some(e => e.includes('Network error'))).toBe(true);

            // Other files should still be uploaded
            expect(result.filesUploaded).toBeGreaterThan(0);
        });
    });

    describe('custom exclude patterns', () => {
        it('should respect custom exclude patterns', async () => {
            // Create a .log file
            fs.writeFileSync(path.join(tempWorkspace, 'debug.log'), 'log content');

            // Act
            await recorder.syncWorkspaceToS3('session-123', tempWorkspace, {
                excludePatterns: ['.git', 'node_modules', '.env', '*.log', '*.txt'],
            });

            // Assert
            const uploadCalls = mockS3Client.uploadFileFromPath.mock.calls;
            const uploadedKeys = uploadCalls.map(call => call[0]);

            expect(uploadedKeys.some(k => k.includes('.log'))).toBe(false);
            expect(uploadedKeys.some(k => k.includes('.txt'))).toBe(false);
            expect(uploadedKeys.some(k => k.includes('.py') || k.includes('.ts'))).toBe(true);
        });
    });
});







