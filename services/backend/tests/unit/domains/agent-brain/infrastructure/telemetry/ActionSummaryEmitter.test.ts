import { describe, expect, it } from 'vitest';
import { ActionSummaryEmitter } from '@/domains/agent-brain/infrastructure/telemetry/ActionSummaryEmitter';

describe('ActionSummaryEmitter', () => {
  it('skips finding detection for trusted internal skill reads', () => {
    const result = ActionSummaryEmitter.summarize({
      toolName: 'file_read',
      toolCallId: 'tc-skill-read',
      args: { path: 'C:\\Projects\\Null-Ai\\.skills\\js-surface-analysis\\methodology.md' },
      result: {
        ok: true,
        data: {
          content: '../etc/passwd\npassword=secret',
        },
      } as any,
      durationMs: 12,
    });

    expect(result.summary.finding).toBeUndefined();
    expect(result.discoveries).toEqual([]);
  });

  it('skips finding detection for internal plan files', () => {
    const result = ActionSummaryEmitter.summarize({
      toolName: 'file_read',
      toolCallId: 'tc-plan-read',
      args: { path: '/workspace/.plan' },
      result: {
        ok: true,
        data: {
          content: 'password=secret',
        },
      } as any,
      durationMs: 8,
    });

    expect(result.summary.finding).toBeUndefined();
    expect(result.discoveries).toEqual([]);
  });

  it('skips discovery detection for generated reporting artifacts', () => {
    const result = ActionSummaryEmitter.summarize({
      toolName: 'file_read',
      toolCallId: 'tc-report-artifact-read',
      args: { path: '/workspace/.artifacts/report/brief.md' },
      result: {
        ok: true,
        data: {
          content: 'Compliance readiness framework: soc2\nusername: success password: success',
        },
      } as any,
      durationMs: 6,
    });

    expect(result.summary.finding).toBeUndefined();
    expect(result.discoveries).toEqual([]);
  });

  it('still detects findings for ordinary file reads', () => {
    const result = ActionSummaryEmitter.summarize({
      toolName: 'file_read',
      toolCallId: 'tc-user-file',
      args: { path: '/workspace/output.txt' },
      result: {
        ok: true,
        data: {
          content: '../etc/passwd',
        },
      } as any,
      durationMs: 5,
    });

    expect(result.summary.finding).toBe('Path traversal pattern detected');
  });

  it('reports policy-denied file reads as blocked instead of failures', () => {
    const result = ActionSummaryEmitter.summarize({
      toolName: 'file_read',
      toolCallId: 'tc-denied-read',
      args: { path: '/workspace/.artifacts/result.txt' },
      result: {
        ok: false,
        message: 'Tool file_read is outside the policy allowlist.',
        data: {
          forbidden: true,
          error: 'Tool file_read is outside the policy allowlist.',
        },
      } as any,
      durationMs: 1,
    });

    expect(result.summary.outcome).toBe('blocked');
    expect(result.summary.outcomeReason).toContain('outside the policy allowlist');
  });

  it('reports policy-denied file writes as blocked instead of failures', () => {
    const result = ActionSummaryEmitter.summarize({
      toolName: 'file_write',
      toolCallId: 'tc-denied-write',
      args: { path: '/workspace/summary.md', content: '# Summary' },
      result: {
        ok: false,
        message: 'Tool file_write is outside the policy allowlist.',
        data: {
          forbidden: true,
          error: 'Tool file_write is outside the policy allowlist.',
        },
      } as any,
      durationMs: 1,
    });

    expect(result.summary.outcome).toBe('blocked');
    expect(result.summary.outcomeReason).toContain('outside the policy allowlist');
  });

  it('treats generic tool payloads with success=false as failures', () => {
    const result = ActionSummaryEmitter.summarize({
      toolName: 'http_repeat',
      toolCallId: 'tc-http-repeat',
      args: { entry_id: 'abc123' },
      result: {
        ok: true,
        data: {
          success: false,
          error: 'HTTP capture entry abc123 not found',
        },
      } as any,
      durationMs: 7,
    });

    expect(result.summary.outcome).toBe('failure');
    expect(result.summary.outcomeReason).toBe('HTTP capture entry abc123 not found');
  });

  it('summarizes http_payload results from compact preview fields', () => {
    const result = ActionSummaryEmitter.summarize({
      toolName: 'http_payload',
      toolCallId: 'tc-http-preview',
      args: { method: 'GET', url: 'https://example.com/admin' },
      result: {
        ok: true,
        data: {
          success: true,
          status_code: 200,
          body_preview: '<html><!-- admin:secret --></html>',
          interesting_headers: {
            'content-type': 'text/html; charset=utf-8',
          },
        },
      } as any,
      durationMs: 14,
    });

    expect(result.summary.outcome).toBe('success');
    expect(result.summary.contentType).toBe('text/html');
    expect(result.summary.finding).toBe('HTML comment contains sensitive keywords');
    expect(result.discoveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'credential',
        }),
      ]),
    );
  });
});
