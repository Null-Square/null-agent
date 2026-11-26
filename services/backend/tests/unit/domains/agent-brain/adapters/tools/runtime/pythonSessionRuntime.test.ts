import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executePythonSession,
  PYTHON_SESSION_SUPERVISOR_SCRIPT,
} from '@/domains/agent-brain/adapters/tools/runtime/pythonSessionRuntime';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';

const execFileAsync = promisify(execFile);

const candidatePythonCommands = (): string[] => [
  ...(process.env.PYTHON ? [process.env.PYTHON] : []),
  'python3',
  'python',
];

const resolvePython = async (): Promise<string> => {
  for (const command of candidatePythonCommands()) {
    try {
      await execFileAsync(command, ['--version'], { timeout: 5_000, windowsHide: true });
      return command;
    } catch {
      continue;
    }
  }
  throw new Error('python3/python is required for python_session supervisor tests');
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type SupervisorHarness = {
  workspaceDir: string;
  sessionDir: string;
  close: () => Promise<void>;
  request: (payload: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, any>>;
};

const readJsonFile = async (target: string): Promise<Record<string, any> | null> => {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8')) as Record<string, any>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const startSupervisor = async (options?: {
  cloudPrivateBlock?: boolean;
  enumerationLocalOnly?: boolean;
}): Promise<SupervisorHarness> => {
  const python = await resolvePython();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nullai-python-session-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const sessionDir = path.join(workspaceDir, '.artifacts', 'python-session', 'test-run');
  const scriptPath = path.join(tempDir, 'python_session_supervisor.py');
  const configPath = path.join(tempDir, 'config.json');
  const enumerationArtifactRoot = path.join(
    workspaceDir,
    '.artifacts',
    'workers',
    'enumeration',
    'task-1',
  );
  await fs.mkdir(path.join(sessionDir, 'requests'), { recursive: true });
  await fs.mkdir(path.join(sessionDir, 'results'), { recursive: true });
  await fs.writeFile(scriptPath, PYTHON_SESSION_SUPERVISOR_SCRIPT, 'utf8');
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        workspace_root: workspaceDir,
        session_dir: sessionDir,
        inline_output_limit_chars: 100,
        cloud_private_block: options?.cloudPrivateBlock === true,
        enumeration_local_only: options?.enumerationLocalOnly === true,
        ...(options?.enumerationLocalOnly === true
          ? { artifact_write_root: enumerationArtifactRoot }
          : {}),
      },
      null,
      2,
    ),
    'utf8',
  );

  const child = execFile(python, [scriptPath, configPath], { cwd: tempDir, windowsHide: true });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const statusPath = path.join(sessionDir, 'status.json');
  for (let i = 0; i < 100; i += 1) {
    if (await readJsonFile(statusPath)) {
      break;
    }
    if (child.exitCode !== null) {
      throw new Error(`python_session supervisor exited early: ${stderr}`);
    }
    await wait(50);
  }
  expect(await readJsonFile(statusPath)).not.toBeNull();

  const request = async (
    payload: Record<string, unknown>,
    timeoutMs: number = 10_000,
  ): Promise<Record<string, any>> => {
    const id = String(payload.id ?? randomUUID());
    const requestPath = path.join(sessionDir, 'requests', `${id}.json`);
    const resultPath = path.join(sessionDir, 'results', `${id}.json`);
    await fs.writeFile(requestPath, JSON.stringify({ id, ...payload }), 'utf8');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await readJsonFile(resultPath);
      if (result) {
        return result;
      }
      if (child.exitCode !== null) {
        throw new Error(`python_session supervisor exited before result: ${stderr}`);
      }
      await wait(50);
    }
    throw new Error(`timed out waiting for python_session result ${id}; stderr=${stderr}`);
  };

  return {
    workspaceDir,
    sessionDir,
    request,
    close: async () => {
      try {
        await request({ action: 'stop' }, 2_000);
      } catch {
        child.kill();
      }
      const exited = await new Promise<boolean>((resolve) => {
        if (child.exitCode !== null) {
          resolve(true);
          return;
        }
        const timer = setTimeout(() => resolve(false), 2_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!exited) {
        child.kill();
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
};

type RawServer = {
  port: number;
  received: () => Buffer[];
  close: () => Promise<void>;
};

const startRawServer = async (): Promise<RawServer> => {
  const received: Buffer[] = [];
  const response = Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK', 'utf8');
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    let responded = false;
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const request = Buffer.concat(chunks);
      if (!responded && request.includes(Buffer.from('\r\n\r\n', 'utf8'))) {
        responded = true;
        received.push(request);
        socket.end(response);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind to a TCP port');
  }
  return {
    port: address.port,
    received: () => received,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

describe('python_session supervisor', () => {
  const harnesses: SupervisorHarness[] = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  it('persists variables across exec calls and reset clears the namespace', async () => {
    const harness = await startSupervisor();
    harnesses.push(harness);

    const first = await harness.request({ action: 'exec', code: 'value = 41\nvalue' });
    expect(first.success).toBe(true);
    expect(first.result_repr).toBe('41');

    const second = await harness.request({ action: 'exec', code: 'value + 1' });
    expect(second.success).toBe(true);
    expect(second.result_repr).toBe('42');

    const status = await harness.request({ action: 'status' });
    expect(status.defined_names).toContain('value');
    expect(status.helpers).toEqual(expect.arrayContaining(['http_history', 'raw_send', 'save_poc', 'replay']));

    const reset = await harness.request({ action: 'reset' });
    expect(reset.success).toBe(true);
    expect(reset.defined_names).not.toContain('value');

    const missing = await harness.request({ action: 'exec', code: 'value' });
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('NameError');
  });

  it('reads HTTP history and saves PoC files under .artifacts/poc', async () => {
    const harness = await startSupervisor();
    harnesses.push(harness);

    await fs.writeFile(
      path.join(harness.workspaceDir, '.http-history.ndjson'),
      JSON.stringify({
        id: 'http-history-1',
        ts: '2026-06-19T00:00:00.000Z',
        request: { method: 'GET', url: 'http://example.test/', headers: {} },
        success: true,
        status_code: 200,
        body_size: 2,
        body_truncated: false,
        body_preview: 'OK',
        response_body: 'OK',
        response_headers: 'content-type: text/plain',
      }) + '\n',
      'utf8',
    );

    const result = await harness.request({
      action: 'exec',
      code: [
        'entry = http_history.get("http-history-1")',
        'poc = save_poc("demo.py", "print(\'demo\')")',
        '(entry["id"], poc["path"])',
      ].join('\n'),
    });

    expect(result.success).toBe(true);
    expect(result.result_repr).toContain('http-history-1');
    expect(result.result_repr).toContain('.artifacts/poc/demo.py');
    await expect(fs.readFile(path.join(harness.workspaceDir, '.artifacts', 'poc', 'demo.py'), 'utf8'))
      .resolves.toContain("print('demo')");
  });

  it('raw_send writes raw HTTP history and replay re-sends the stored bytes', async () => {
    const harness = await startSupervisor();
    harnesses.push(harness);
    const server = await startRawServer();
    const rawRequest = 'GET /raw HTTP/1.1\r\nX-Dupe: one\r\nX-Dupe: two\r\n\r\n';

    try {
      const first = await harness.request({
        action: 'exec',
        code: [
          `exchange = raw_send("http://127.0.0.1:${server.port}/", raw_request=${JSON.stringify(rawRequest)}, read_idle_timeout_ms=100)`,
          'exchange["raw_exchange_id"]',
        ].join('\n'),
      });
      expect(first.success).toBe(true);
      const exchangeId = String(first.result_repr).replace(/^'|'$/g, '');
      expect(exchangeId).toMatch(/[a-f0-9-]{36}/);

      const replay = await harness.request({ action: 'replay', exchange_id: exchangeId });
      expect(replay.success).toBe(true);
      expect(replay.source).toBe('http_raw_send');
      expect(replay.new_exchange_id).toMatch(/[a-f0-9-]{36}/);
      expect(replay.diff.status_code.matched).toBe(true);
      expect(server.received()).toHaveLength(2);
      expect(server.received()[0].toString('utf8')).toBe(rawRequest);
      expect(server.received()[1].toString('utf8')).toBe(rawRequest);

      const rawHistory = await fs.readFile(path.join(harness.workspaceDir, '.raw-http-history.ndjson'), 'utf8');
      expect(rawHistory).toContain(exchangeId);
      expect(rawHistory).toContain(String(replay.new_exchange_id));
    } finally {
      await server.close();
    }
  });

  it('truncates large stdout and result_repr with artifact handles', async () => {
    const harness = await startSupervisor();
    harnesses.push(harness);

    const result = await harness.request({
      action: 'exec',
      code: 'print("x" * 500)\n"y" * 500',
    });

    expect(result.success).toBe(true);
    expect(result.stdout_truncated).toBe(true);
    expect(result.result_truncated).toBe(true);
    expect(result.artifacts.stdout.path).toMatch(/\.artifacts\/python-session\/test-run\/outputs\//);
    expect(result.artifacts.result.path).toMatch(/\.artifacts\/python-session\/test-run\/outputs\//);
    await expect(fs.readFile(path.join(harness.workspaceDir, result.artifacts.stdout.path), 'utf8'))
      .resolves.toContain('x'.repeat(200));
  });

  it('blocks private targets when replaying stored HTTP exchanges in cloud mode', async () => {
    const harness = await startSupervisor({ cloudPrivateBlock: true });
    harnesses.push(harness);

    await fs.writeFile(
      path.join(harness.workspaceDir, '.http-history.ndjson'),
      JSON.stringify({
        id: 'private-http-history',
        ts: '2026-06-19T00:00:00.000Z',
        request: { method: 'GET', url: 'http://127.0.0.1/admin', headers: {} },
        success: true,
        status_code: 200,
        body_size: 2,
        body_truncated: false,
        response_body: 'OK',
        response_headers: 'content-type: text/plain',
      }) + '\n',
      'utf8',
    );

    const result = await harness.request({ action: 'replay', exchange_id: 'private-http-history' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cloud execution cannot target private or reserved network addresses');
  });

  it('blocks saved PoC files with private target literals in cloud mode', async () => {
    const harness = await startSupervisor({ cloudPrivateBlock: true });
    harnesses.push(harness);

    const pocPath = path.join(harness.workspaceDir, '.artifacts', 'poc', 'private.py');
    await fs.mkdir(path.dirname(pocPath), { recursive: true });
    await fs.writeFile(
      pocPath,
      'import urllib.request\nurllib.request.urlopen("http://127.0.0.1/admin")\n',
      'utf8',
    );

    const result = await harness.request({
      action: 'replay_poc',
      poc_path: '.artifacts/poc/private.py',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cloud execution cannot target private or reserved network addresses');
  });

  it('restricts enumeration sessions to local parsing and task-scoped artifact writes', async () => {
    const harness = await startSupervisor({ enumerationLocalOnly: true });
    harnesses.push(harness);

    const local = await harness.request({
      action: 'exec',
      code: [
        'import json',
        'workspace.write_text("parsed.json", json.dumps({"ok": True}))',
      ].join('\n'),
    });
    expect(local.success).toBe(true);
    await expect(fs.readFile(path.join(
      harness.workspaceDir,
      '.artifacts',
      'workers',
      'enumeration',
      'task-1',
      'parsed.json',
    ), 'utf8')).resolves.toContain('"ok": true');

    const networkImport = await harness.request({
      action: 'exec',
      code: 'import socket\nsocket.create_connection(("example.com", 443))',
    });
    expect(networkImport.success).toBe(false);
    expect(networkImport.error).toContain('Python import denied: socket');

    const escape = await harness.request({
      action: 'exec',
      code: 'workspace.write_text("../escape.txt", "denied")',
    });
    expect(escape.success).toBe(false);
    expect(escape.error).toContain('write path escapes');

    const status = await harness.request({ action: 'status' });
    expect(status.helpers).toEqual(['workspace', 'http_history']);
  });
});

describe('executePythonSession guards', () => {
  it('blocks private targets in cloud sessions before starting the supervisor', async () => {
    const writeFile = vi.fn();
    const exec = vi.fn();
    const readFile = vi.fn();
    const session = {
      id: 'session-python-cloud',
      workspaceDir: 'C:/tmp/nullai-test',
      flags: {
        securityops: {
          executionTarget: 'cloud',
        },
      },
    };
    const ctx = {
      sessionId: session.id,
      workspaceDir: session.workspaceDir,
      sessionStore: { get: () => session },
      sandbox: { writeFile, exec, readFile },
      abortSignal: new AbortController().signal,
      flags: session.flags,
    } as unknown as ToolContext;

    const result = await executePythonSession(
      {
        action: 'exec',
        code: 'import urllib.request\nurllib.request.urlopen("http://127.0.0.1/admin")',
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('Cloud execution cannot target private or reserved network addresses'),
      }),
    );
    expect(writeFile).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });
});
