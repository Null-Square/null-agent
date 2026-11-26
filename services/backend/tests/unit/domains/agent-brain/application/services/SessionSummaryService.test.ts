import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { SessionSummaryService } from '@/domains/agent-brain/application/services/SessionSummaryService';

describe('SessionSummaryService', () => {
    let sessionSummaryService: SessionSummaryService;

    beforeEach(() => {
        sessionSummaryService = new SessionSummaryService();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('generateSummary', () => {
        it('returns agent-authored summary when present on the session', async () => {
            const session: any = {
                id: 'session1',
                summary: 'agent authored summary',
                artifacts: [],
            };

            const summary = await sessionSummaryService.generateSummary(session);

            expect(summary).toBe('agent authored summary');
        });

        it('prefers artifact content when available', async () => {
            const session: any = {
                id: 'session1',
                summary: undefined,
                artifacts: [{ id: 'a1', originalName: 'summary.md' }],
            };

            const mockArtifactService = {
                getArtifactContent: vi.fn().mockResolvedValue('artifact summary'),
            } as any;
            sessionSummaryService = new SessionSummaryService(mockArtifactService);

            const summary = await sessionSummaryService.generateSummary(session);

            expect(summary).toBe('artifact summary');
            expect(mockArtifactService.getArtifactContent).toHaveBeenCalledWith(
                'session1',
                'summary.md',
            );
        });

        it('returns null when no summary is available', async () => {
            const session: any = {
                id: 'session1',
                artifacts: [],
                summary: undefined,
            };

            const summary = await sessionSummaryService.generateSummary(session);

            expect(summary).toBeNull();
        });
    });
});







