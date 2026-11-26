import { describe, expect, it } from 'vitest';
import type { Message } from '@/domains/agent-brain/domain/types';
import { microcompactToolResults } from '@/domains/agent-brain/application/orchestration/stages/helpers/ToolResultMicrocompactor';

describe('ToolResultMicrocompactor', () => {
  const assistantForTool = (id: string, toolName: string, timestamp: number): Message => ({
    id: `assistant-${id}`,
    role: 'assistant',
    content: `call ${toolName}`,
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name: toolName, arguments: '{}' },
      },
    ],
    timestamp,
  });

  const toolResult = (id: string, payload: Record<string, unknown>, timestamp: number): Message => ({
    id: `tool-${id}`,
    role: 'tool',
    tool_call_id: id,
    content: JSON.stringify(payload),
    timestamp,
  });

  it('preserves managed shell job handles when compacting old shell results', () => {
    const shellPayload = {
      jobId: 'shelljob-real-123',
      status: 'running',
      outcome: 'running',
      nextAction: 'wait_again',
      command: `katana -u https://example.com ${'--depth 2 '.repeat(300)}`,
      stdoutPath: '.artifacts/shell-jobs/shelljob-real-123/stdout.log',
      stderrPath: '.artifacts/shell-jobs/shelljob-real-123/stderr.log',
      filler: 'x'.repeat(4_000),
    };
    const messages: Message[] = [
      assistantForTool('call-shell', 'shell_run', 1),
      toolResult('call-shell', shellPayload, 2),
      assistantForTool('call-recent', 'query_notes', 3),
      toolResult('call-recent', { data: { notes: [] } }, 4),
    ];

    const result = microcompactToolResults(messages, {
      forceReduction: true,
      aggregateToolResultTargetTokens: 0,
      keepLastToolResults: 1,
      maxResultChars: 500,
    });

    const compacted = result.messages[1];
    expect(compacted.content).toContain('tool_result_compacted');
    expect(compacted.content).toContain('shelljob-real-123');
    expect(compacted.content).toContain('wait_again');
    expect(compacted.content).toContain('.artifacts/shell-jobs/shelljob-real-123/stdout.log');
    expect(compacted.content).toContain('.artifacts/shell-jobs/shelljob-real-123/stderr.log');
    expect(result.stats.compactedTools.shell_run).toBe(1);
  });

  it('preserves wait_for_shell_job handles through the same compaction path', () => {
    const messages: Message[] = [
      assistantForTool('call-wait', 'wait_for_shell_job', 1),
      toolResult(
        'call-wait',
        {
          jobId: 'shelljob-wait-123',
          status: 'completed',
          outcome: 'completed_with_results',
          nextAction: 'read_output',
          stdoutPath: '.artifacts/shell-jobs/shelljob-wait-123/stdout.log',
          stderrPath: '.artifacts/shell-jobs/shelljob-wait-123/stderr.log',
          stdout: 'x'.repeat(4_000),
        },
        2,
      ),
      assistantForTool('call-recent', 'query_notes', 3),
      toolResult('call-recent', { data: { notes: [] } }, 4),
    ];

    const result = microcompactToolResults(messages, {
      forceReduction: true,
      aggregateToolResultTargetTokens: 0,
      keepLastToolResults: 1,
      maxResultChars: 500,
    });

    const compacted = result.messages[1];
    expect(compacted.content).toContain('shelljob-wait-123');
    expect(compacted.content).toContain('completed_with_results');
    expect(compacted.content).toContain('read_output');
    expect(compacted.content).toContain('.artifacts/shell-jobs/shelljob-wait-123/stdout.log');
    expect(result.stats.compactedTools.wait_for_shell_job).toBe(1);
  });

  it('compacts multiple shell jobs independently without mixing job ids', () => {
    const messages: Message[] = [
      assistantForTool('call-shell-a', 'shell_run', 1),
      toolResult(
        'call-shell-a',
        {
          jobId: 'shelljob-a',
          status: 'running',
          outcome: 'running',
          stdoutPath: '.artifacts/shell-jobs/shelljob-a/stdout.log',
          stdout: 'a'.repeat(4_000),
        },
        2,
      ),
      assistantForTool('call-shell-b', 'shell_run', 3),
      toolResult(
        'call-shell-b',
        {
          jobId: 'shelljob-b',
          status: 'completed',
          outcome: 'completed_with_results',
          stdoutPath: '.artifacts/shell-jobs/shelljob-b/stdout.log',
          stdout: 'b'.repeat(4_000),
        },
        4,
      ),
      assistantForTool('call-recent', 'query_notes', 5),
      toolResult('call-recent', { data: { notes: [] } }, 6),
    ];

    const result = microcompactToolResults(messages, {
      forceReduction: true,
      aggregateToolResultTargetTokens: 0,
      keepLastToolResults: 1,
      maxResultChars: 500,
    });

    expect(result.messages[1].content).toContain('shelljob-a');
    expect(result.messages[1].content).not.toContain('shelljob-b/stdout.log');
    expect(result.messages[3].content).toContain('shelljob-b');
    expect(result.messages[3].content).not.toContain('shelljob-a/stdout.log');
    expect(result.stats.compactedTools.shell_run).toBe(2);
  });

  it('keeps completed shell artifact paths even when a malformed result lacks jobId', () => {
    const messages: Message[] = [
      assistantForTool('call-shell', 'shell_run', 1),
      toolResult(
        'call-shell',
        {
          status: 'completed',
          outcome: 'completed_with_results',
          nextAction: 'read_output',
          stdoutPath: '.artifacts/shell-jobs/shelljob-missing-id/stdout.log',
          stdout: 'x'.repeat(4_000),
        },
        2,
      ),
      assistantForTool('call-recent', 'query_notes', 3),
      toolResult('call-recent', { data: { notes: [] } }, 4),
    ];

    const result = microcompactToolResults(messages, {
      forceReduction: true,
      aggregateToolResultTargetTokens: 0,
      keepLastToolResults: 1,
      maxResultChars: 500,
    });

    expect(result.messages[1].content).toContain('status=completed');
    expect(result.messages[1].content).toContain('read_output');
    expect(result.messages[1].content).toContain('.artifacts/shell-jobs/shelljob-missing-id/stdout.log');
  });

  it('compacts old http_payload results and preserves response handles', () => {
    const messages: Message[] = [
      assistantForTool('call-http', 'http_payload', 1),
      toolResult(
        'call-http',
        {
          ok: true,
          data: {
            url: 'https://example.com/api/users',
            method: 'GET',
            status_code: 200,
            body_size: 12_000,
            history_entry_id: 'http-history-1',
            body_preview: 'x'.repeat(4_000),
          },
        },
        2,
      ),
      assistantForTool('call-recent', 'query_notes', 3),
      toolResult('call-recent', { data: { notes: [] } }, 4),
    ];

    const result = microcompactToolResults(messages, {
      forceReduction: true,
      aggregateToolResultTargetTokens: 0,
      keepLastToolResults: 1,
      maxResultChars: 500,
    });

    expect(result.messages[1].content).toContain('tool_result_compacted');
    expect(result.messages[1].content).toContain('https://example.com/api/users');
    expect(result.messages[1].content).toContain('historyEntryId=http-history-1');
    expect(result.stats.compactedTools.http_payload).toBe(1);
  });

  it('compacts python_session results while preserving PoC artifacts and replay ids', () => {
    const messages: Message[] = [
      assistantForTool('call-python', 'python_session', 1),
      toolResult(
        'call-python',
        {
          ok: true,
          data: {
            success: true,
            action: 'replay',
            new_exchange_id: 'raw-replayed-1',
            result_repr: "{'matched': True}",
            defined_names: ['token', 'payload'],
            artifacts: {
              stdout: { path: '.artifacts/python-session/run/outputs/call-python-stdout.txt' },
            },
            stdout: 'x'.repeat(4_000),
          },
        },
        2,
      ),
      assistantForTool('call-recent', 'query_notes', 3),
      toolResult('call-recent', { data: { notes: [] } }, 4),
    ];

    const result = microcompactToolResults(messages, {
      forceReduction: true,
      aggregateToolResultTargetTokens: 0,
      keepLastToolResults: 1,
      maxResultChars: 500,
    });

    expect(result.messages[1].content).toContain('tool_result_compacted');
    expect(result.messages[1].content).toContain('action=replay');
    expect(result.messages[1].content).toContain('exchangeId=raw-replayed-1');
    expect(result.messages[1].content).toContain('.artifacts/python-session/run/outputs/call-python-stdout.txt');
    expect(result.stats.compactedTools.python_session).toBe(1);
  });

  it('compacts inventory to confirmation, coverage, and bounded version objectives', () => {
    const messages: Message[] = [
      assistantForTool('call-inventory', 'query_inventory', 1),
      toolResult(
        'call-inventory',
        {
          ok: true,
          data: {
            assets: [
              { id: 'asset-confirmed', isLead: false, needsBroadScan: false },
              { id: 'asset-lead', isLead: true, needsBroadScan: true },
            ],
            leadCount: 1,
            digest: {
              confirmedAssets: 1,
              leadAssets: 1,
              needsBroadScan: 1,
              needsVersionAcquisition: 2,
              versionAcquisitionExhausted: 1,
            },
            filler: 'x'.repeat(4_000),
          },
        },
        2,
      ),
      assistantForTool('call-recent', 'query_notes', 3),
      toolResult('call-recent', { data: { notes: [] } }, 4),
    ];

    const result = microcompactToolResults(messages, {
      forceReduction: true,
      aggregateToolResultTargetTokens: 0,
      keepLastToolResults: 1,
      maxResultChars: 500,
    });

    expect(result.messages[1].content).toContain(
      '2 assets: 1 confirmed, 1 lead; 1 need broad scan; 2 need version acquisition, 1 exhausted',
    );
    expect(result.messages[1].content).not.toMatch(/promotion|track|ignore/i);
  });

  it('uses aggregate tool-result budget pressure to compact otherwise small older results', () => {
    const messages: Message[] = [
      ...Array.from({ length: 5 }, (_entry, index) => [
        assistantForTool(`call-http-${index}`, 'http_payload', index * 2 + 1),
        toolResult(
          `call-http-${index}`,
          {
            ok: true,
            data: {
              url: `https://example.com/api/${index}`,
              status_code: 200,
              body_preview: 'x'.repeat(1_200),
            },
          },
          index * 2 + 2,
        ),
      ]).flat(),
    ];

    const result = microcompactToolResults(messages, {
      forceReduction: true,
      aggregateToolResultTargetTokens: 0,
      keepLastToolResults: 1,
      maxResultChars: 10_000,
      maxResultTokens: 10_000,
      aggregateToolResultBudgetTokens: 900,
    });

    expect(result.stats.aggregateBudgetEnforcements).toBe(1);
    expect(result.stats.aggregateBudgetOverageTokensBefore).toBeGreaterThan(0);
    expect(result.stats.compactedResults).toBeGreaterThan(0);
    expect(result.stats.compactedTools.http_payload).toBeGreaterThan(0);
  });
});
