import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ToolResultPolicy } from '@/domains/agent-brain/application/orchestration/tool-results/ToolResultPolicy';
import { projectToolResultForPrompt } from '@/domains/agent-brain/application/orchestration/tool-results/ToolResultStore';

describe('ToolResultPolicy', () => {
  it('caps long HTTP body previews and summarizes long headers', () => {
    const policy = new ToolResultPolicy();
    const longCsp = "default-src 'self'; ".repeat(100);

    const normalized = policy.normalizeResult('http_payload', {
      ok: true,
      data: {
        success: true,
        url: 'https://example.com',
        method: 'GET',
        status_code: 200,
        body_preview: 'a'.repeat(3_000),
        interesting_headers: {
          'content-type': 'text/html',
          'content-security-policy': longCsp,
          server: 'nginx',
        },
      },
    });

    expect(normalized.persistRecommended).toBe(true);
    const result = normalized.result as { data: Record<string, any> };
    expect(result.data.body_preview.length).toBeLessThan(1_700);
    expect(result.data.interesting_headers['content-security-policy'].length).toBeLessThan(340);
    expect(result.data.interesting_headers_policy.summarized).toContain('content-security-policy');
  });

  it('caps headers inline without forcing persistence when the body is small', async () => {
    const policy = new ToolResultPolicy();
    const longCsp = "default-src 'self'; ".repeat(100);

    const normalized = policy.normalizeResult('http_payload', {
      ok: true,
      data: {
        success: true,
        url: 'https://example.com',
        method: 'GET',
        status_code: 200,
        body_preview: 'small body',
        interesting_headers: {
          'content-security-policy': longCsp,
        },
      },
    });

    // Header capping alone must not trigger a disk round-trip for an otherwise-small result.
    expect(normalized.persistRecommended).toBe(false);
    const result = normalized.result as { data: Record<string, any> };
    expect(result.data.interesting_headers['content-security-policy'].length).toBeLessThan(340);

    // And the projection must keep it inline (not persisted) even with a workspace available.
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-result-policy-hdr-'));
    try {
      const projection = await projectToolResultForPrompt({
        workspaceDir,
        toolName: 'http_payload',
        toolCallId: 'tc-hdr-small',
        result: {
          ok: true,
          data: {
            success: true,
            url: 'https://example.com',
            status_code: 200,
            body_preview: 'small body',
            interesting_headers: { 'content-security-policy': longCsp },
          },
        },
      });
      expect(projection.stats.persisted).toBe(false);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('caps raw HTTP request and response previews', () => {
    const policy = new ToolResultPolicy();

    const normalized = policy.normalizeResult('http_raw_send', {
      ok: true,
      data: {
        success: true,
        url: 'https://example.com',
        raw_exchange_id: 'raw-1',
        request_preview: `GET / HTTP/1.1\r\n${'X-A: b\r\n'.repeat(1_000)}`,
        response_preview: `HTTP/1.1 200 OK\r\n\r\n${'body'.repeat(1_000)}`,
        artifacts: {
          manifest_path: '.artifacts/raw-http/raw-1/manifest.json',
        },
      },
    });

    expect(normalized.persistRecommended).toBe(true);
    const result = normalized.result as { data: Record<string, any> };
    expect(result.data.request_preview.length).toBeLessThan(1_700);
    expect(result.data.response_preview.length).toBeLessThan(1_700);
    expect(result.data.artifacts.manifest_path).toBe('.artifacts/raw-http/raw-1/manifest.json');
  });

  it('replaces large browser source with a preview field', () => {
    const policy = new ToolResultPolicy();

    const normalized = policy.normalizeResult('browser_action', {
      ok: true,
      data: {
        success: true,
        action: 'get_source',
        source: `<html>${'x'.repeat(10_000)}</html>`,
        text_preview: 'loaded',
      },
    });

    expect(normalized.persistRecommended).toBe(true);
    const result = normalized.result as { data: Record<string, any> };
    expect(result.data.source).toBeUndefined();
    expect(result.data.source_preview).toContain('[source truncated by tool result policy]');
    expect(result.data.source_original_chars).toBeGreaterThan(10_000);
  });

  it('keeps browser screenshot artifacts as metadata without forcing persistence', () => {
    const policy = new ToolResultPolicy();

    const normalized = policy.normalizeResult('browser_action', {
      ok: true,
      data: {
        success: true,
        action: 'screenshot',
        artifact_path: '/workspace/.artifacts/browser/screenshots/example.png',
        mime_type: 'image/png',
        sha256: 'a'.repeat(64),
        bytes: 512,
        width: 1280,
        height: 720,
      },
    });

    expect(normalized.persistRecommended).toBe(false);
    const result = normalized.result as { data: Record<string, any> };
    expect(result.data.artifact_path).toContain('/workspace/.artifacts/browser/screenshots/');
    expect(JSON.stringify(result)).not.toContain('data:image/png;base64');
  });

  it('omits completed wait_for_shell_job output when artifact paths are available', () => {
    const policy = new ToolResultPolicy();

    const normalized = policy.normalizeResult('wait_for_shell_job', {
      ok: true,
      data: {
        jobId: 'shelljob-1',
        status: 'completed',
        stdoutPath: '/workspace/.artifacts/shell/stdout.log',
        stderrPath: '/workspace/.artifacts/shell/stderr.log',
        stdout: 'stdout '.repeat(1_000),
        stderr: 'stderr '.repeat(1_000),
      },
    });

    expect(normalized.persistRecommended).toBe(true);
    const result = normalized.result as { data: Record<string, any> };
    expect(result.data.stdout).toContain('omitted by tool result policy');
    expect(result.data.stdout).toContain('/workspace/.artifacts/shell/stdout.log');
    expect(result.data.stdoutSha256).toHaveLength(64);
  });

  it('caps python_session stdout, stderr, and result repr output', () => {
    const policy = new ToolResultPolicy();

    const normalized = policy.normalizeResult('python_session', {
      ok: true,
      data: {
        success: true,
        action: 'exec',
        stdout: 'out'.repeat(2_000),
        stderr: 'err'.repeat(2_000),
        result_repr: 'result'.repeat(2_000),
      },
    });

    expect(normalized.persistRecommended).toBe(true);
    const result = normalized.result as { data: Record<string, any> };
    expect(result.data.stdout).toContain('output truncated by tool result policy');
    expect(result.data.stderr).toContain('output truncated by tool result policy');
    expect(result.data.result_repr).toContain('output truncated by tool result policy');
    expect(result.data.stdout_sha256).toHaveLength(64);
    expect(result.data.result_repr_original_chars).toBeGreaterThan(3_000);
  });

  it('persists the raw result and returns one stable artifact reference shape', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-result-policy-'));
    try {
      const projection = await projectToolResultForPrompt({
        workspaceDir,
        toolName: 'shell_run',
        toolCallId: 'tc-raw-large',
        result: {
          ok: true,
          data: {
            success: true,
            stdout: 'x'.repeat(30_000),
            stderr: '',
          },
        },
      });

      expect(projection.stats.persisted).toBe(true);
      const promptPayload = JSON.parse(projection.content) as Record<string, any>;
      expect(promptPayload.status).toBe('tool_result_persisted');
      expect(promptPayload.artifact.path).toMatch(/^\/workspace\/\.artifacts\/tool-results\/tc-raw-large-/);
      expect(promptPayload.policy.savedApproxTokens).toBeGreaterThan(0);

      const relative = promptPayload.artifact.path.replace('/workspace/', '');
      const saved = await fs.readFile(path.join(workspaceDir, relative), 'utf8');
      expect(saved).toContain('"toolName": "shell_run"');
      expect(saved).toContain('"stdout"');
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

