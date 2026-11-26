import { describe, expect, it, vi } from 'vitest';
import { RemoteExecAdapter, RunnerTimeoutError, RunnerDisconnectedError } from '@/domains/security-ops/runners/RemoteExecAdapter';
import { RunnerConnectionRegistry } from '@/domains/security-ops/runners/RunnerConnectionRegistry';
import { EventEmitter } from 'events';

class FakeWs extends EventEmitter {
  static OPEN = 1;
  OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  send(payload: string): void { this.sent.push(payload); }
  close(): void { this.readyState = 3; }
}

const makeRegistry = () => new RunnerConnectionRegistry();

const setupRunner = (registry: RunnerConnectionRegistry) => {
  const ws = new FakeWs() as any;
  registry.register('runner-1', ws);
  return { ws: ws as unknown as FakeWs, registry };
};

const lastSent = (ws: FakeWs) => JSON.parse(ws.sent[ws.sent.length - 1] || '{}');

describe('RemoteExecAdapter.exec()', () => {
  it('resolves with stdout/stderr/exitCode on clean exit', async () => {
    const registry = makeRegistry();
    const { ws } = setupRunner(registry);
    const adapter = new RemoteExecAdapter(registry);

    const promise = adapter.exec({ runnerId: 'runner-1', sessionId: 's1', cmd: 'echo hi' });
    const { requestId } = lastSent(ws);

    registry.handleIncomingMessage('runner-1', JSON.stringify({ type: 'stdout', requestId, sessionId: 's1', data: 'hi\n' }));
    registry.handleIncomingMessage('runner-1', JSON.stringify({ type: 'exit', requestId, sessionId: 's1', code: 0 }));

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hi\n');
    expect(result.stderr).toBe('');
  });

  it('accumulates multiple stdout chunks', async () => {
    const registry = makeRegistry();
    const { ws } = setupRunner(registry);
    const adapter = new RemoteExecAdapter(registry);

    const promise = adapter.exec({ runnerId: 'runner-1', sessionId: 's1', cmd: 'cat file' });
    const { requestId } = lastSent(ws);

    registry.handleIncomingMessage('runner-1', JSON.stringify({ type: 'stdout', requestId, data: 'part1' }));
    registry.handleIncomingMessage('runner-1', JSON.stringify({ type: 'stdout', requestId, data: 'part2' }));
    registry.handleIncomingMessage('runner-1', JSON.stringify({ type: 'exit', requestId, code: 0 }));

    const result = await promise;
    expect(result.stdout).toBe('part1part2');
  });

  it('calls onStdout/onStderr callbacks per chunk', async () => {
    const registry = makeRegistry();
    const { ws } = setupRunner(registry);
    const adapter = new RemoteExecAdapter(registry);

    const chunks: string[] = [];
    const errChunks: string[] = [];

    const promise = adapter.exec({
      runnerId: 'runner-1', sessionId: 's1', cmd: 'cmd',
      onStdout: (c) => chunks.push(c),
      onStderr: (c) => errChunks.push(c),
    });
    const { requestId } = lastSent(ws);

    registry.handleIncomingMessage('runner-1', JSON.stringify({ type: 'stdout', requestId, data: 'a' }));
    registry.handleIncomingMessage('runner-1', JSON.stringify({ type: 'stderr', requestId, data: 'e' }));
    registry.handleIncomingMessage('runner-1', JSON.stringify({ type: 'exit', requestId, code: 0 }));

    await promise;
    expect(chunks).toEqual(['a']);
    expect(errChunks).toEqual(['e']);
  });

  it('rejects with RunnerTimeoutError after timeoutMs', async () => {
    vi.useFakeTimers();
    const registry = makeRegistry();
    setupRunner(registry);
    const adapter = new RemoteExecAdapter(registry);

    const promise = adapter.exec({ runnerId: 'runner-1', sessionId: 's1', cmd: 'sleep', timeoutMs: 1000 });
    vi.advanceTimersByTime(1001);

    await expect(promise).rejects.toThrow(RunnerTimeoutError);
    vi.useRealTimers();
  });

  it('rejects with RunnerDisconnectedError when runner disconnects mid-exec', async () => {
    const registry = makeRegistry();
    const { ws } = setupRunner(registry);
    const adapter = new RemoteExecAdapter(registry);

    const promise = adapter.exec({ runnerId: 'runner-1', sessionId: 's1', cmd: 'slow', timeoutMs: 30_000 });
    registry.unregister('runner-1', ws as any);

    await expect(promise).rejects.toThrow(RunnerDisconnectedError);
  });

  it('rejects with error message on error type message', async () => {
    const registry = makeRegistry();
    const { ws } = setupRunner(registry);
    const adapter = new RemoteExecAdapter(registry);

    const promise = adapter.exec({ runnerId: 'runner-1', sessionId: 's1', cmd: 'bad' });
    const { requestId } = lastSent(ws);

    registry.handleIncomingMessage('runner-1', JSON.stringify({ type: 'error', requestId, message: 'disk full' }));

    await expect(promise).rejects.toThrow('disk full');
  });

  it('sends timeoutMs in exec message to runner', async () => {
    const registry = makeRegistry();
    const { ws } = setupRunner(registry);
    const adapter = new RemoteExecAdapter(registry);

    const promise = adapter.exec({ runnerId: 'runner-1', sessionId: 's1', cmd: 'nmap', timeoutMs: 5000 });
    const sent = lastSent(ws);

    expect(sent.type).toBe('exec');
    expect(sent.timeoutMs).toBe(5000);
    expect(sent.command).toBe('nmap');

    // Settle the promise
    registry.handleIncomingMessage('runner-1', JSON.stringify({ type: 'exit', requestId: sent.requestId, code: 0 }));
    await promise;
  });

  it('sends a run-scoped workspaceKey without replacing session identity', async () => {
    const registry = makeRegistry();
    const { ws } = setupRunner(registry);
    const adapter = new RemoteExecAdapter(registry);

    const promise = adapter.exec({
      runnerId: 'runner-1',
      sessionId: 'phase-session-1',
      workspaceKey: 'run-run-1',
      cmd: 'pwd',
      timeoutMs: 5000,
    });
    const sent = lastSent(ws);

    expect(sent.type).toBe('exec');
    expect(sent.sessionId).toBe('phase-session-1');
    expect(sent.workspaceKey).toBe('run-run-1');

    registry.handleIncomingMessage('runner-1', JSON.stringify({ type: 'exit', requestId: sent.requestId, code: 0 }));
    await promise;
  });

  it('isolates concurrent exec requests by requestId', async () => {
    const registry = makeRegistry();
    const { ws } = setupRunner(registry);
    const adapter = new RemoteExecAdapter(registry);

    const p1 = adapter.exec({ runnerId: 'runner-1', sessionId: 's1', cmd: 'cmd1', timeoutMs: 30_000 });
    const req1 = lastSent(ws).requestId;
    const p2 = adapter.exec({ runnerId: 'runner-1', sessionId: 's1', cmd: 'cmd2', timeoutMs: 30_000 });
    const req2 = lastSent(ws).requestId;

    expect(req1).not.toBe(req2);

    registry.handleIncomingMessage('runner-1', JSON.stringify({ type: 'stdout', requestId: req2, data: 'two' }));
    registry.handleIncomingMessage('runner-1', JSON.stringify({ type: 'exit', requestId: req2, code: 0 }));
    registry.handleIncomingMessage('runner-1', JSON.stringify({ type: 'stdout', requestId: req1, data: 'one' }));
    registry.handleIncomingMessage('runner-1', JSON.stringify({ type: 'exit', requestId: req1, code: 0 }));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.stdout).toBe('one');
    expect(r2.stdout).toBe('two');
  });

  it('rejects when abort signal fires', async () => {
    const registry = makeRegistry();
    setupRunner(registry);
    const adapter = new RemoteExecAdapter(registry);
    const controller = new AbortController();

    const promise = adapter.exec({
      runnerId: 'runner-1', sessionId: 's1', cmd: 'slow',
      timeoutMs: 30_000, signal: controller.signal,
    });

    controller.abort('cancelled');
    await expect(promise).rejects.toThrow();
  });
});

describe('RemoteExecAdapter.readFile()', () => {
  it('returns buffer from base64 encoded content', async () => {
    const registry = makeRegistry();
    const { ws } = setupRunner(registry);
    const adapter = new RemoteExecAdapter(registry);

    const promise = adapter.readFile({ runnerId: 'runner-1', sessionId: 's1', path: 'report.txt', timeoutMs: 5000 });
    const sent = lastSent(ws);

    expect(sent.type).toBe('file_read');
    expect(sent.path).toBe('report.txt');

    registry.handleIncomingMessage('runner-1', JSON.stringify({
      type: 'file_read_result',
      requestId: sent.requestId,
      contentBase64: Buffer.from('hello').toString('base64'),
    }));

    const buf = await promise;
    expect(buf.toString('utf-8')).toBe('hello');
  });

  it('throws on error response', async () => {
    const registry = makeRegistry();
    const { ws } = setupRunner(registry);
    const adapter = new RemoteExecAdapter(registry);

    const promise = adapter.readFile({ runnerId: 'runner-1', sessionId: 's1', path: 'missing.txt', timeoutMs: 5000 });
    const { requestId } = lastSent(ws);

    registry.handleIncomingMessage('runner-1', JSON.stringify({ type: 'error', requestId, message: 'file not found' }));
    await expect(promise).rejects.toThrow('file not found');
  });
});

describe('RemoteExecAdapter.writeFile()', () => {
  it('sends utf8 content and resolves on ack', async () => {
    const registry = makeRegistry();
    const { ws } = setupRunner(registry);
    const adapter = new RemoteExecAdapter(registry);

    const promise = adapter.writeFile({ runnerId: 'runner-1', sessionId: 's1', path: 'out.txt', content: 'data', timeoutMs: 5000 });
    const sent = lastSent(ws);

    expect(sent.type).toBe('file_write');
    expect(sent.contentEncoding).toBe('utf8');

    registry.handleIncomingMessage('runner-1', JSON.stringify({ type: 'file_write_ack', requestId: sent.requestId }));
    await expect(promise).resolves.toBeUndefined();
  });

  it('sends Buffer as base64', async () => {
    const registry = makeRegistry();
    const { ws } = setupRunner(registry);
    const adapter = new RemoteExecAdapter(registry);

    const buf = Buffer.from('binary');
    const promise = adapter.writeFile({ runnerId: 'runner-1', sessionId: 's1', path: 'bin.bin', content: buf, timeoutMs: 5000 });
    const sent = lastSent(ws);

    expect(sent.contentEncoding).toBe('base64');
    expect(sent.content).toBe(buf.toString('base64'));

    registry.handleIncomingMessage('runner-1', JSON.stringify({ type: 'file_write_ack', requestId: sent.requestId }));
    await promise;
  });
});

describe('RemoteExecAdapter.browserAction()', () => {
  it('sends browser_action requests and returns data payloads', async () => {
    const registry = makeRegistry();
    const { ws } = setupRunner(registry);
    const adapter = new RemoteExecAdapter(registry);

    const promise = adapter.browserAction({
      runnerId: 'runner-1',
      sessionId: 's1',
      workspaceKey: 'run-1',
      action: 'screenshot',
      payload: { action: 'screenshot', label: 'proof' },
      scopeBoundary: {
        rulesDigest: 'a'.repeat(64),
        roots: [{ type: 'domain', value: 'example.com' }],
        exclusions: [{ type: 'domain', value: 'billing.example.com' }],
      },
      timeoutMs: 5000,
    });
    const sent = lastSent(ws);

    expect(sent).toEqual(expect.objectContaining({
      type: 'browser_action',
      sessionId: 's1',
      workspaceKey: 'run-1',
      action: 'screenshot',
      payload: { action: 'screenshot', label: 'proof' },
      scopeBoundary: {
        rulesDigest: 'a'.repeat(64),
        roots: [{ type: 'domain', value: 'example.com' }],
        exclusions: [{ type: 'domain', value: 'billing.example.com' }],
      },
    }));

    registry.handleIncomingMessage('runner-1', JSON.stringify({
      type: 'browser_action_result',
      requestId: sent.requestId,
      data: {
        success: true,
        action: 'screenshot',
        artifact_path: '/workspace/.artifacts/browser/screenshots/proof.png',
      },
    }));

    await expect(promise).resolves.toEqual(expect.objectContaining({
      success: true,
      action: 'screenshot',
      artifact_path: expect.stringContaining('/workspace/.artifacts/browser/screenshots/'),
    }));
  });
});

describe('RemoteExecAdapter.fetchArtifacts()', () => {
  it('accumulates artifact messages and resolves on artifact_done', async () => {
    const registry = makeRegistry();
    const { ws } = setupRunner(registry);
    const adapter = new RemoteExecAdapter(registry);

    const promise = adapter.fetchArtifacts({ runnerId: 'runner-1', sessionId: 's1', paths: ['.artifacts'], timeoutMs: 5000 });
    const sent = lastSent(ws);

    expect(sent.type).toBe('artifact_request');

    const file1 = Buffer.from('report content');
    registry.handleIncomingMessage('runner-1', JSON.stringify({
      type: 'artifact', requestId: sent.requestId,
      path: 'report.txt', content: file1.toString('base64'), contentEncoding: 'base64',
    }));
    registry.handleIncomingMessage('runner-1', JSON.stringify({
      type: 'artifact_done', requestId: sent.requestId,
    }));

    const files = await promise;
    expect(files.size).toBe(1);
    expect(files.get('report.txt')?.toString('utf-8')).toBe('report content');
  });

  it('sends workspaceKey on artifact fetches', async () => {
    const registry = makeRegistry();
    const { ws } = setupRunner(registry);
    const adapter = new RemoteExecAdapter(registry);

    const promise = adapter.fetchArtifacts({
      runnerId: 'runner-1',
      sessionId: 'reporting-session',
      workspaceKey: 'run-run-1',
      paths: ['.artifacts'],
      timeoutMs: 5000,
    });
    const sent = lastSent(ws);

    expect(sent.type).toBe('artifact_request');
    expect(sent.sessionId).toBe('reporting-session');
    expect(sent.workspaceKey).toBe('run-run-1');

    registry.handleIncomingMessage('runner-1', JSON.stringify({
      type: 'artifact_done',
      requestId: sent.requestId,
    }));
    await expect(promise).resolves.toBeInstanceOf(Map);
  });

  it('rejects on runner disconnect during fetch', async () => {
    const registry = makeRegistry();
    const { ws } = setupRunner(registry);
    const adapter = new RemoteExecAdapter(registry);

    const promise = adapter.fetchArtifacts({ runnerId: 'runner-1', sessionId: 's1', paths: ['.artifacts'], timeoutMs: 30_000 });
    registry.unregister('runner-1', ws as any);

    await expect(promise).rejects.toThrow(RunnerDisconnectedError);
  });
});
