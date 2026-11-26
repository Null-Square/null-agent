import { describe, expect, it, vi } from 'vitest';
import { LlmFindingDuplicateJudge } from '@/domains/security-ops/tools/FindingDuplicateJudge';

describe('LlmFindingDuplicateJudge', () => {
  it('uses the caller ModelRuntime and accepts only an existing finding id', async () => {
    const executeModelCall = vi.fn(async () => ({
      content: [
        '<dedupe_result>',
        '<is_duplicate>true</is_duplicate>',
        '<duplicate_id>finding-1</duplicate_id>',
        '<confidence>0.94</confidence>',
        '<reason>Same endpoint and root cause</reason>',
        '</dedupe_result>',
      ].join(''),
    })) as any;

    const result = await new LlmFindingDuplicateJudge().checkDuplicate(
      { title: 'Candidate', endpoint: '/admin' },
      [{ id: 'finding-1', title: 'Existing', endpoint: '/admin' }],
      {
        sessionId: 'session-1',
        turnNumber: 2,
        abortSignal: new AbortController().signal,
        executeModelCall,
      },
    );

    expect(result).toEqual(expect.objectContaining({
      isDuplicate: true,
      duplicateId: 'finding-1',
      confidence: 0.94,
    }));
    expect(executeModelCall).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      turnNumber: 2,
      routeReason: 'finding_duplicate_judge',
    }));
  });

  it('fails safely when the runtime is absent', async () => {
    const result = await new LlmFindingDuplicateJudge().checkDuplicate(
      { title: 'Candidate' },
      [{ id: 'finding-1', title: 'Existing' }],
    );

    expect(result.isDuplicate).toBe(false);
    expect(result.error).toContain('ModelRuntime is unavailable');
  });
});
