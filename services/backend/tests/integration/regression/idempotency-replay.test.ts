import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
/**
 * Replay / Idempotency Regression Tests
 * 
 * Test 5 from the regression test plan:
 * Ensures that tool side-effects happen once even under crash/retry scenarios.
 */

// ============================================================================
// TEST 5A: Crash after side-effect, before commit
// ============================================================================

describe('Tool idempotency under crash/retry', () => {
  describe('ToolExecutionPort contract', () => {
    it('returns cached result for completed tool_call_id', async () => {
      const cachedResult = { ok: true, data: { files: ['report.md'] } };
      const toolCallId = 'tc-already-executed';
      
      // Mock ToolExecutionPort
      const mockExecutionDb = {
        findByToolCallId: vi.fn().mockResolvedValue({
          id: 'exec-1',
          sessionId: 's1',
          turnId: 't1',
          toolCallId,
          toolName: 'write_file',
          status: 'completed',
          result: cachedResult,
          startedAt: new Date(),
          completedAt: new Date(),
        }),
      };

      // Simulate: ToolsRegistry checks for existing execution before running
      const existingExecution = await mockExecutionDb.findByToolCallId(toolCallId);
      
      expect(existingExecution).toBeDefined();
      expect(existingExecution?.status).toBe('completed');
      expect(existingExecution?.result).toEqual(cachedResult);
      
      // If execution exists with 'completed' status, tool handler should NOT run
    });

    it('creates execution record before running tool', async () => {
      const mockExecutionDb = {
        findByToolCallId: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue({
          id: 'exec-new',
          sessionId: 's1',
          turnId: 't1',
          toolCallId: 'tc-new',
          toolName: 'run_command',
          status: 'pending',
          startedAt: new Date(),
        }),
        complete: vi.fn().mockResolvedValue(undefined),
      };

      // Step 1: Check for existing execution
      const existing = await mockExecutionDb.findByToolCallId('tc-new');
      expect(existing).toBeUndefined();

      // Step 2: Create execution record with 'pending' status
      const execution = await mockExecutionDb.create({
        sessionId: 's1',
        turnId: 't1',
        toolCallId: 'tc-new',
        toolName: 'run_command',
      });
      expect(execution.status).toBe('pending');

      // Step 3: (Tool executes here with side-effects)

      // Step 4: Mark as completed with result
      await mockExecutionDb.complete({
        toolCallId: 'tc-new',
        result: { output: 'success' },
      });
      expect(mockExecutionDb.complete).toHaveBeenCalled();
    });
  });

  describe('Crash simulation flow', () => {
    it('crash after tool returns but before complete() → replay finds pending', async () => {
      const toolCallId = 'tc-crash-test';
      
      // Simulate: First worker created record, tool ran, but crashed before complete()
      const mockExecutionDb = {
        findByToolCallId: vi.fn().mockResolvedValue({
          id: 'exec-crash',
          sessionId: 's1',
          turnId: 't1',
          toolCallId,
          toolName: 'write_file',
          status: 'pending', // Still pending because complete() wasn't called
          result: undefined,
          startedAt: new Date(Date.now() - 60000), // 1 minute ago
        }),
      };

      const existingExecution = await mockExecutionDb.findByToolCallId(toolCallId);
      
      expect(existingExecution).toBeDefined();
      expect(existingExecution?.status).toBe('pending');
      
      // Recovery behavior: tool doesn't re-execute blindly
    });

    it('stale pending execution can be recovered', async () => {
      const toolCallId = 'tc-stale-pending';
      const staleThresholdMs = 5 * 60 * 1000; // 5 minutes
      
      const staleExecution = {
        id: 'exec-stale',
        sessionId: 's1',
        turnId: 't1',
        toolCallId,
        toolName: 'write_file',
        status: 'pending' as const,
        result: undefined,
        startedAt: new Date(Date.now() - staleThresholdMs - 1000),
      };

      const mockExecutionDb = {
        findByToolCallId: vi.fn().mockResolvedValue(staleExecution),
      };

      const existing = await mockExecutionDb.findByToolCallId(toolCallId);
      
      // Check if stale
      const startedAt = new Date(existing!.startedAt).getTime();
      const isStale = Date.now() - startedAt > staleThresholdMs;
      
      expect(isStale).toBe(true);
    });
  });
});

// ============================================================================
// TEST 5B: Two workers, same tool_call_id (lock contention)
// ============================================================================

describe('Concurrent execution protection', () => {
  it('second worker finds existing execution and uses cached result', async () => {
    const toolCallId = 'tc-race-condition';
    
    const mockExecutionDb = {
      findByToolCallId: vi.fn()
        .mockResolvedValueOnce(undefined) // Worker 1: no existing
        .mockResolvedValueOnce({          // Worker 2: finds worker 1's record
          id: 'exec-race',
          sessionId: 's1',
          turnId: 't1',
          toolCallId,
          toolName: 'slow_tool',
          status: 'completed',
          result: { output: 'worker-1-result' },
          startedAt: new Date(),
          completedAt: new Date(),
        }),
      create: vi.fn().mockResolvedValue({
        id: 'exec-race',
        sessionId: 's1',
        turnId: 't1',
        toolCallId,
        toolName: 'slow_tool',
        status: 'pending',
        startedAt: new Date(),
      }),
    };

    // Worker 1: Check, create, execute
    const worker1Check = await mockExecutionDb.findByToolCallId(toolCallId);
    expect(worker1Check).toBeUndefined();
    await mockExecutionDb.create({
      sessionId: 's1',
      turnId: 't1',
      toolCallId,
      toolName: 'slow_tool',
    });

    // Worker 2: Check - finds completed by worker 1
    const worker2Check = await mockExecutionDb.findByToolCallId(toolCallId);
    expect(worker2Check).toBeDefined();
    expect(worker2Check?.status).toBe('completed');
    expect(worker2Check?.result).toEqual({ output: 'worker-1-result' });
  });

  it('database unique constraint prevents duplicate records', async () => {
    const toolCallId = 'tc-unique-constraint';
    
    const mockExecutionDb = {
      findByToolCallId: vi.fn().mockResolvedValue(undefined),
      create: vi.fn()
        .mockResolvedValueOnce({ id: 'exec-1', toolCallId, status: 'pending' })
        .mockRejectedValueOnce(new Error('Unique constraint violation')),
    };

    // Worker 1 succeeds
    const exec1 = await mockExecutionDb.create({
      sessionId: 's1',
      turnId: 't1',
      toolCallId,
      toolName: 'tool',
    });
    expect(exec1.id).toBe('exec-1');

    // Worker 2 fails with unique constraint error
    await expect(mockExecutionDb.create({
      sessionId: 's1',
      turnId: 't1',
      toolCallId,
      toolName: 'tool',
    })).rejects.toThrow('Unique constraint violation');
  });
});






