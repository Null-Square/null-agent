import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

import { appendHttpHistoryEntry, readHttpHistoryEntries } from '@/domains/agent-brain/adapters/tools/runtime/httpHistory';
import { AuthzReplay } from '@/domains/agent-brain/adapters/tools/builtins/securityops/personas';
import type { ToolContext } from '@/domains/agent-brain/application/tools';

const personaService = {
  resolveHttpAuth: vi.fn(),
  updatePersonaSecret: vi.fn(),
};

vi.mock('@/domains/agent-brain/adapters/tools/builtins/securityopsServiceRegistry', () => ({
  getPersonaService: () => personaService,
}));

const makeContext = (
  workspaceDir: string,
  sandbox: ToolContext['sandbox'],
  securityOpsFlags: Record<string, unknown> = {},
): ToolContext => {
  const securityops = {
    organizationId: 'org-1',
    scopeId: 'scope-1',
    ...securityOpsFlags,
  };
  return ({
    sessionId: 'session-1',
    workspaceDir,
    sandbox,
    sessionStore: {
      get: vi.fn().mockReturnValue({
        id: 'session-1',
        userId: 'user-1',
        scopeId: 'scope-1',
        turn: 1,
        workspaceDir,
        flags: {
          securityops,
        },
      }),
      mergeFlagNamespaceAsync: vi.fn().mockResolvedValue(true),
    } as any,
    streamBroker: { emit: vi.fn() } as any,
    trace: undefined,
    approvals: { require: vi.fn().mockResolvedValue(undefined) },
    checkpoints: undefined,
    guards: {
      pathGuard: { ensureInsideWorkspace: vi.fn() } as any,
      cmdGuard: { validate: vi.fn() } as any,
    },
    policies: { requireApproval: false, maxStdoutBytes: 2, timeoutMs: 5000 },
    flags: {
      securityops,
    },
    planRuntime: { appendProvenanceSnippet: vi.fn() } as any,
    abortSignal: new AbortController().signal,
    config: { trace: { stdoutChunkSize: 4096 } } as any,
  }) as ToolContext;
};

describe('AuthzReplay', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'authz-replay-'));
    personaService.resolveHttpAuth.mockReset();
    personaService.updatePersonaSecret.mockReset();
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('replays a request as personas, strips stored redacted auth, and reports an authz anomaly matrix', async () => {
    await appendHttpHistoryEntry(workspaceDir, {
      id: 'req-idor',
      ts: '2026-03-08T10:00:00.000Z',
      request: {
        method: 'GET',
        url: 'https://example.com/api/accounts/123',
        headers: {
          Authorization: '[REDACTED]',
          Accept: 'application/json',
        },
      },
      success: true,
      status_code: 200,
      response_time_ms: 111,
      body_size: 28,
      body_truncated: false,
      body_preview: '{"id":"123","owner":"alice"}',
      response_body: '{"id":"123","owner":"alice"}',
      response_headers: 'HTTP/2 200',
    });

    personaService.resolveHttpAuth.mockImplementation(async ({ persona }: { persona: string }) => {
      if (persona === 'owner') {
        return {
          personaId: 'owner-id',
          label: 'owner',
          roleLabel: 'owner',
          kind: 'bearer_token',
          username: 'alice',
          targetHost: 'example.com',
          headers: { Authorization: 'Bearer owner-token' },
          appliedHeaderNames: ['Authorization'],
          refreshProcedure: {},
        };
      }
      return {
        personaId: 'viewer-id',
        label: 'viewer',
        roleLabel: 'viewer',
        kind: 'bearer_token',
        username: 'bob',
        targetHost: 'example.com',
        headers: { Authorization: 'Bearer viewer-token' },
        appliedHeaderNames: ['Authorization'],
        refreshProcedure: {},
      };
    });

    const sandbox = {
      exec: vi.fn(async ({ cmd }: { cmd: string }) => {
        if (cmd.includes('Bearer owner-token') || cmd.includes('Bearer viewer-token')) {
          return {
            stdout: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"id":"123","owner":"alice"}',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            aborted: false,
            abortReason: undefined,
            artifacts: [],
          };
        }
        return {
          stdout: 'HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\n\r\n{"error":"forbidden"}',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          aborted: false,
          abortReason: undefined,
          artifacts: [],
        };
      }),
    } as any;
    const ctx = makeContext(workspaceDir, sandbox);

    const result = await AuthzReplay.run(
      {
        request_id: 'req-idor',
        baselinePersona: 'owner',
        personas: ['viewer'],
        includeAnonymous: true,
        modifications: {
          headers: {
            Authorization: 'Bearer attacker-controlled-override',
            'X-Test-Case': 'authz-replay',
          },
        },
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        verdict: 'likely_access_control_anomaly',
        baselinePersona: 'owner',
      }),
    );
    expect((result.data as any).matrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ persona: 'owner', status_code: 200 }),
        expect.objectContaining({ persona: 'viewer', status_code: 200, same_as_baseline: true }),
        expect.objectContaining({ persona: 'anonymous', status_code: 403, blocked_like: true }),
      ]),
    );

    expect(sandbox.exec).toHaveBeenCalledTimes(3);
    const commands: string[] = sandbox.exec.mock.calls.map((call: any[]) => call[0].cmd as string);
    expect(commands.join('\n')).not.toContain('[REDACTED]');
    expect(commands.join('\n')).not.toContain('attacker-controlled-override');
    expect(commands[0]).toContain('Authorization: Bearer owner-token');
    expect(commands[1]).toContain('Authorization: Bearer viewer-token');
    expect(commands[2]).not.toContain('Authorization:');
    expect(commands.every((command) => command.includes('X-Test-Case: authz-replay'))).toBe(true);

    const history = await readHttpHistoryEntries(workspaceDir);
    expect(history).toHaveLength(4);
    expect(history.slice(1).every((entry) => entry.replayed_from === 'req-idor')).toBe(true);
    expect(history.slice(1).map((entry) => entry.request.headers.Authorization)).toEqual([
      '[REDACTED]',
      '[REDACTED]',
      undefined,
    ]);
  });

  it('refuses state-changing captures unless explicitly allowed', async () => {
    await appendHttpHistoryEntry(workspaceDir, {
      id: 'req-delete',
      ts: '2026-03-08T10:00:00.000Z',
      request: {
        method: 'DELETE',
        url: 'https://example.com/api/accounts/123',
        headers: {},
      },
      success: true,
      status_code: 204,
      response_time_ms: 111,
      body_size: 0,
      body_truncated: false,
      body_preview: '',
      response_body: '',
      response_headers: 'HTTP/2 204',
    });

    const sandbox = { exec: vi.fn() } as any;
    const ctx = makeContext(workspaceDir, sandbox);

    const result = await AuthzReplay.run(
      {
        request_id: 'req-delete',
        personas: ['owner'],
        includeAnonymous: false,
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('Refusing to replay state-changing DELETE request'),
      }),
    );
    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(personaService.resolveHttpAuth).not.toHaveBeenCalled();
  });

  it('reports no access-control anomaly when challengers are blocked', async () => {
    await appendHttpHistoryEntry(workspaceDir, {
      id: 'req-owned',
      ts: '2026-03-08T10:00:00.000Z',
      request: {
        method: 'GET',
        url: 'https://example.com/api/accounts/123',
        headers: { Authorization: '[REDACTED]' },
      },
      success: true,
      status_code: 200,
      response_time_ms: 111,
      body_size: 28,
      body_truncated: false,
      body_preview: '{"id":"123","owner":"alice"}',
      response_body: '{"id":"123","owner":"alice"}',
      response_headers: 'HTTP/2 200',
    });

    personaService.resolveHttpAuth.mockImplementation(async ({ persona }: { persona: string }) => ({
      personaId: `${persona}-id`,
      label: persona,
      roleLabel: 'user',
      kind: 'bearer_token',
      username: persona,
      targetHost: 'example.com',
      headers: { Authorization: `Bearer ${persona}-token` },
      appliedHeaderNames: ['Authorization'],
      refreshProcedure: {},
    }));

    const sandbox = {
      exec: vi.fn(async ({ cmd }: { cmd: string }) => {
        if (cmd.includes('Bearer owner-token')) {
          return {
            stdout: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"id":"123","owner":"alice"}',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            aborted: false,
            abortReason: undefined,
            artifacts: [],
          };
        }
        return {
          stdout: 'HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\n\r\n{"error":"forbidden"}',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          aborted: false,
          abortReason: undefined,
          artifacts: [],
        };
      }),
    } as any;

    const result = await AuthzReplay.run(
      {
        request_id: 'req-owned',
        baselinePersona: 'owner',
        personas: ['viewer'],
        includeAnonymous: true,
      },
      makeContext(workspaceDir, sandbox),
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({
      verdict: 'no_access_control_anomaly',
      reason: expect.stringContaining('blocked'),
    }));
    expect((result.data as any).matrix).toEqual(expect.arrayContaining([
      expect.objectContaining({ persona: 'viewer', status_code: 403, blocked_like: true, same_as_baseline: false }),
      expect.objectContaining({ persona: 'anonymous', status_code: 403, blocked_like: true, same_as_baseline: false }),
    ]));
  });

  it('refreshes an expired persona once and retries with the replacement secret', async () => {
    await appendHttpHistoryEntry(workspaceDir, {
      id: 'req-refresh',
      ts: '2026-03-08T10:00:00.000Z',
      request: {
        method: 'GET',
        url: 'https://example.com/api/accounts/123',
        headers: { Authorization: '[REDACTED]' },
      },
      success: true,
      status_code: 200,
      response_time_ms: 111,
      body_size: 28,
      body_truncated: false,
      body_preview: '{"id":"123","owner":"alice"}',
      response_body: '{"id":"123","owner":"alice"}',
      response_headers: 'HTTP/2 200',
    });

    personaService.resolveHttpAuth.mockImplementation(async ({ persona }: { persona: string }) => {
      if (persona === 'owner-id') {
        return {
          personaId: 'owner-id',
          label: 'owner',
          roleLabel: 'owner',
          kind: 'bearer_token',
          username: 'alice',
          targetHost: 'example.com',
          headers: { Authorization: 'Bearer new-token' },
          appliedHeaderNames: ['Authorization'],
          refreshProcedure: {},
        };
      }
      return {
        personaId: 'owner-id',
        label: 'owner',
        roleLabel: 'owner',
        kind: 'bearer_token',
        username: 'alice',
        targetHost: 'example.com',
        headers: { Authorization: 'Bearer old-token' },
        appliedHeaderNames: ['Authorization'],
        refreshProcedure: {
          type: 'http_request',
          url: 'https://example.com/oauth/token',
          method: 'POST',
          body: 'refresh_token=abc',
          tokenJsonPath: 'access_token',
        },
      };
    });

    const sandbox = {
      exec: vi.fn(async ({ cmd }: { cmd: string }) => {
        if (cmd.includes('/oauth/token')) {
          return {
            stdout: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"access_token":"new-token"}',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            aborted: false,
            abortReason: undefined,
            artifacts: [],
          };
        }
        if (cmd.includes('Bearer new-token')) {
          return {
            stdout: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"id":"123","owner":"alice"}',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            aborted: false,
            abortReason: undefined,
            artifacts: [],
          };
        }
        return {
          stdout: 'HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n{"error":"expired"}',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          aborted: false,
          abortReason: undefined,
          artifacts: [],
        };
      }),
    } as any;

    const result = await AuthzReplay.run(
      {
        request_id: 'req-refresh',
        baselinePersona: 'owner',
        includeAnonymous: false,
      },
      makeContext(workspaceDir, sandbox),
    );

    expect(result.ok).toBe(true);
    expect(personaService.updatePersonaSecret).toHaveBeenCalledWith({
      orgId: 'org-1',
      scopeId: 'scope-1',
      personaId: 'owner-id',
      secret: 'new-token',
    });
    expect(personaService.resolveHttpAuth).toHaveBeenCalledWith(expect.objectContaining({
      persona: 'owner-id',
    }));
    expect((result.data as any).matrix).toEqual(expect.arrayContaining([
      expect.objectContaining({
        persona: 'owner',
        status_code: 200,
        refresh: expect.objectContaining({ attempted: true, succeeded: true }),
      }),
    ]));
  });

  it('surfaces a broken refresh procedure instead of silently trusting an expired response', async () => {
    await appendHttpHistoryEntry(workspaceDir, {
      id: 'req-broken-refresh',
      ts: '2026-03-08T10:00:00.000Z',
      request: {
        method: 'GET',
        url: 'https://example.com/api/accounts/123',
        headers: { Authorization: '[REDACTED]' },
      },
      success: true,
      status_code: 200,
      response_time_ms: 111,
      body_size: 28,
      body_truncated: false,
      body_preview: '{"id":"123","owner":"alice"}',
      response_body: '{"id":"123","owner":"alice"}',
      response_headers: 'HTTP/2 200',
    });

    personaService.resolveHttpAuth.mockResolvedValue({
      personaId: 'owner-id',
      label: 'owner',
      roleLabel: 'owner',
      kind: 'bearer_token',
      username: 'alice',
      targetHost: 'example.com',
      headers: { Authorization: 'Bearer old-token' },
      appliedHeaderNames: ['Authorization'],
      refreshProcedure: {
        type: 'http_request',
        url: 'https://example.com/oauth/token',
        method: 'POST',
        tokenJsonPath: 'access_token',
      },
    });

    const sandbox = {
      exec: vi.fn(async ({ cmd }: { cmd: string }) => {
        if (cmd.includes('/oauth/token')) {
          return {
            stdout: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"token_missing":"no replacement"}',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            aborted: false,
            abortReason: undefined,
            artifacts: [],
          };
        }
        return {
          stdout: 'HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n{"error":"expired"}',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          aborted: false,
          abortReason: undefined,
          artifacts: [],
        };
      }),
    } as any;

    const result = await AuthzReplay.run(
      {
        request_id: 'req-broken-refresh',
        baselinePersona: 'owner',
        includeAnonymous: false,
      },
      makeContext(workspaceDir, sandbox),
    );

    expect(result.ok).toBe(true);
    expect(personaService.updatePersonaSecret).not.toHaveBeenCalled();
    expect((result.data as any).matrix).toEqual(expect.arrayContaining([
      expect.objectContaining({
        persona: 'owner',
        status_code: 401,
        refresh: expect.objectContaining({
          attempted: true,
          succeeded: false,
          error: expect.stringContaining('replacement secret'),
        }),
      }),
    ]));
  });

  it('propagates cloud private-network replay blocks', async () => {
    await appendHttpHistoryEntry(workspaceDir, {
      id: 'req-private',
      ts: '2026-03-08T10:00:00.000Z',
      request: {
        method: 'GET',
        url: 'http://127.0.0.1/admin',
        headers: {},
      },
      success: true,
      status_code: 200,
      response_time_ms: 111,
      body_size: 2,
      body_truncated: false,
      body_preview: 'ok',
      response_body: 'ok',
      response_headers: 'HTTP/1.1 200',
    });

    personaService.resolveHttpAuth.mockResolvedValue({
      personaId: 'owner-id',
      label: 'owner',
      roleLabel: 'owner',
      kind: 'bearer_token',
      username: 'alice',
      targetHost: '127.0.0.1',
      headers: { Authorization: 'Bearer owner-token' },
      appliedHeaderNames: ['Authorization'],
      refreshProcedure: {},
    });

    const sandbox = { exec: vi.fn() } as any;
    const result = await AuthzReplay.run(
      {
        request_id: 'req-private',
        baselinePersona: 'owner',
        includeAnonymous: false,
      },
      makeContext(workspaceDir, sandbox, { executionTarget: 'cloud' }),
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(expect.objectContaining({
      error: expect.stringContaining('private runner'),
    }));
    expect(sandbox.exec).not.toHaveBeenCalled();
  });
});
