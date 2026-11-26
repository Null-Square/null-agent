import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { TurnToolExecutor } from '@/domains/agent-brain/application/orchestration/execution/TurnToolExecutor';
import { microcompactToolResults } from '@/domains/agent-brain/application/orchestration/stages/helpers/ToolResultMicrocompactor';
import type { Message } from '@/domains/agent-brain/domain/types';

describe('tool result policy integration', () => {
  it('persists an oversized result once and keeps the stable reference through prompt compaction', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-result-integration-'));
    try {
      const sessionStore = {
        get: vi.fn().mockReturnValue({ id: 's1', userId: 'u1', workspaceDir }),
        heartbeat: vi.fn(),
      };
      const toolsRegistry = {
        execute: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            success: true,
            stdout: 'scan-line\n'.repeat(4_000),
            stderr: '',
          },
        }),
        executeWithReceipt: vi.fn().mockResolvedValue({
          result: {
            ok: true,
            data: {
              success: true,
              stdout: 'scan-line\n'.repeat(4_000),
              stderr: '',
            },
          },
          receipt: {
            schema: 'tool-execution-receipt/v1',
            toolName: 'shell_run',
            toolCallId: 'tc-shell-large',
            outcome: 'succeeded',
          },
        }),
      };
      const stream = {
        message: vi.fn(),
        done: vi.fn(),
        raw: vi.fn(),
      };
      const executor = new TurnToolExecutor({
        sessionStore: sessionStore as any,
        toolsRegistry: toolsRegistry as any,
      });

      const result = await executor.run({
        sessionId: 's1',
        abortSignal: new AbortController().signal,
        toolCalls: [{ id: 'tc-shell-large', function: { name: 'shell_run', arguments: '{}' } }] as any,
        stream: stream as any,
      });

      const content = result.collectedToolResults[0]?.content ?? '';
      expect(result.collectedToolResults[0]?.metadata?.toolExecution).toEqual({
        schema: 'tool-execution-receipt/v1',
        toolName: 'shell_run',
        toolCallId: 'tc-shell-large',
        outcome: 'succeeded',
      });
      const payload = JSON.parse(content) as Record<string, any>;
      expect(payload.status).toBe('tool_result_persisted');
      expect(payload.artifact.path).toMatch(/^\/workspace\/\.artifacts\/tool-results\/tc-shell-large-/);
      await expect(
        fs.readFile(path.join(workspaceDir, payload.artifact.path.replace('/workspace/', '')), 'utf8'),
      ).resolves.toContain('scan-line');

      const messages: Message[] = [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '',
          timestamp: 1,
          tool_calls: [
            {
              id: 'tc-shell-large',
              type: 'function',
              function: { name: 'shell_run', arguments: '{}' },
            },
          ],
        },
        result.collectedToolResults[0]!,
        {
          id: 'assistant-2',
          role: 'assistant',
          content: '',
          timestamp: 2,
          tool_calls: [
            {
              id: 'tc-recent',
              type: 'function',
              function: { name: 'query_notes', arguments: '{}' },
            },
          ],
        },
        {
          id: 'tool-recent',
          role: 'tool',
          tool_call_id: 'tc-recent',
          content: JSON.stringify({ ok: true, data: { notes: [] } }),
          timestamp: 3,
        },
      ];

      const compacted = microcompactToolResults(messages, {
        forceReduction: true,
        aggregateToolResultTargetTokens: 0,
        keepLastToolResults: 1,
        maxResultChars: 20,
      });

      expect(compacted.messages[1].content).toBe(content);
      expect(compacted.messages[1].metadata?.toolExecution?.outcome).toBe('succeeded');
      expect(compacted.stats.compactedTools.shell_run).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

