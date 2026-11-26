import { describe, it, expect, vi, afterEach } from 'vitest';
import { FileRead, FileWrite } from '@/domains/agent-brain/adapters/tools/builtins';
import type { ToolContext } from '@/domains/agent-brain/application/tools';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const makeContext = (workspaceDir: string, overrides: Partial<ToolContext> = {}): ToolContext => {
  const session = {
    id: 'session-1',
    workspaceDir,
    flags: {},
    currentPlanStepId: 'task-2',
    turn: 4,
  };
  return ({
    sessionId: 'session-1',
    workspaceDir,
    sandbox: {
      readFile: vi.fn(async (_session: unknown, targetPath: string, maxBytes?: number) => {
        const data = await fs.readFile(path.join(workspaceDir, targetPath));
        return typeof maxBytes === 'number' && maxBytes >= 0 ? data.subarray(0, maxBytes) : data;
      }),
      statFile: vi.fn(async (_session: unknown, targetPath: string) => {
        const stat = await fs.stat(path.join(workspaceDir, targetPath));
        return {
          exists: true,
          isFile: stat.isFile(),
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      }),
      writeFile: vi.fn(async (_session: unknown, targetPath: string, content: string) => {
        const fullPath = path.join(workspaceDir, targetPath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, 'utf-8');
      }),
    } as any,
    sessionStore: {
      get: vi.fn(() => session),
      setAsync: vi.fn(async (_sessionId: string, updated: unknown) => Object.assign(session, updated)),
    } as any,
    streamBroker: { emit: vi.fn() } as any,
    trace: undefined,
    approvals: { require: vi.fn().mockResolvedValue(undefined) },
    checkpoints: undefined,
    guards: {
      pathGuard: {
        ensureInsideWorkspace: vi.fn((requested: string) => path.join(workspaceDir, requested)),
      } as any,
      cmdGuard: { validate: vi.fn() } as any,
    },
    policies: { requireApproval: false, maxStdoutBytes: 0, timeoutMs: 0 },
    flags: {},
    planRuntime: {} as any,
    abortSignal: new AbortController().signal,
    ...overrides,
  }) as ToolContext;
};

let tempRoot: string | undefined;

async function setupWorkspace(): Promise<string> {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-file-'));
  const workspaceDir = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspaceDir, { recursive: true });
  return workspaceDir;
}

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe('File builtins', () => {
  it('rejects missing path for read', async () => {
    const workspaceDir = await setupWorkspace();
    const ctx = makeContext(workspaceDir);

    const result = await FileRead.run({} as any, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toEqual({ error: 'path is required' });
  });

  it('reads content from a workspace file', async () => {
    const workspaceDir = await setupWorkspace();
    const ctx = makeContext(workspaceDir);
    const target = path.join(workspaceDir, 'notes.txt');
    await fs.writeFile(target, 'hello', 'utf-8');

    const result = await FileRead.run({ path: 'notes.txt' }, ctx);

    expect(ctx.guards.pathGuard.ensureInsideWorkspace).toHaveBeenCalledWith('notes.txt');
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        path: 'notes.txt',
        content: 'hello',
        totalChars: 5,
        totalLines: 1,
        startLine: 1,
        endLine: 1,
        returnedChars: 5,
        truncated: false,
        contentHash: expect.any(String),
      }),
    });
  });

  it.each(['reporting', 'review_reporting'])('denies credential reads in %s sessions', async (activePhaseKey) => {
    const workspaceDir = await setupWorkspace();
    const ctx = makeContext(workspaceDir);
    const session = ctx.sessionStore.get(ctx.sessionId) as any;
    session.flags = { securityops: { activePhaseKey } };
    await fs.writeFile(path.join(workspaceDir, '.credentials'), 'API_TOKEN=secret', 'utf-8');

    const result = await FileRead.run({ path: '.credentials' }, ctx);

    expect(result).toEqual({
      ok: false,
      data: {
        error: 'credential files are not available to reporting sessions',
        path: '.credentials',
      },
    });
    expect(ctx.sandbox.readFile).not.toHaveBeenCalled();
  });

  it('supports bounded reads with offset, line limit, and maxChars', async () => {
    const workspaceDir = await setupWorkspace();
    const ctx = makeContext(workspaceDir);
    await fs.writeFile(path.join(workspaceDir, 'notes.txt'), 'one\ntwo\nthree\nfour', 'utf-8');

    const result = await FileRead.run(
      { path: 'notes.txt', offset: 2, limit: 2, maxChars: 20 },
      ctx,
    );

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        path: 'notes.txt',
        content: 'two\nthree',
        totalLines: 4,
        startLine: 2,
        endLine: 3,
        truncated: true,
        truncatedByLines: true,
        truncatedByChars: false,
        nextOffset: 4,
      }),
    });
  });

  it('passes a byte cap to the sandbox before slicing large reads', async () => {
    const workspaceDir = await setupWorkspace();
    const ctx = makeContext(workspaceDir);
    const readFile = vi.fn(async (_session: unknown, _targetPath: string, maxBytes?: number) =>
      Buffer.from('a'.repeat(Math.min(maxBytes ?? 2_000_000, 2_000_000))),
    );
    (ctx.sandbox as any).readFile = readFile;
    (ctx.sandbox as any).statFile = vi.fn(async () => ({
      exists: true,
      isFile: true,
      sizeBytes: 2_000_000,
      mtimeMs: Date.now(),
    }));

    const result = await FileRead.run({ path: 'huge-katana.jsonl', limit: 30 }, ctx);

    expect(readFile).toHaveBeenCalledWith(expect.anything(), 'huge-katana.jsonl', expect.any(Number));
    expect(readFile.mock.calls[0][2]).toBeLessThan(100_000);
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        path: 'huge-katana.jsonl',
        truncated: true,
        truncatedByBytes: true,
        fileSizeBytes: 2_000_000,
      }),
    });
  });

  it('adds a digest-first hint to large raw scanner artifact reads without blocking the read', async () => {
    const workspaceDir = await setupWorkspace();
    await fs.mkdir(path.join(workspaceDir, '.artifacts', 'scans', 'ffuf'), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, 'scans'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, '.artifacts', 'scans', 'ffuf', 'result.json'), 'x'.repeat(80_000), 'utf-8');
    await fs.writeFile(path.join(workspaceDir, 'scans', 'digest.md'), '# scan digest', 'utf-8');
    const trace = { write: vi.fn().mockResolvedValue(undefined) } as any;
    const ctx = makeContext(workspaceDir, { trace });

    const result = await FileRead.run({ path: '.artifacts/scans/ffuf/result.json' }, ctx);

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        path: '.artifacts/scans/ffuf/result.json',
        content: expect.stringContaining('x'),
        returnedChars: expect.any(Number),
        truncated: true,
        digestFirst: expect.objectContaining({
          digestPath: '/workspace/scans/digest.md',
          digestAvailable: true,
          rawPath: '/workspace/.artifacts/scans/ffuf/result.json',
          reason: 'large_raw_scanner_artifact_read',
        }),
      }),
    });
    expect(trace.write).toHaveBeenCalledWith(
      'session-1',
      5,
      expect.objectContaining({
        event: 'file_read.raw_artifact_digest_hint',
      }),
    );
  });

  it('suppresses duplicate reads of the same unchanged range', async () => {
    const workspaceDir = await setupWorkspace();
    const ctx = makeContext(workspaceDir);
    await fs.writeFile(path.join(workspaceDir, 'notes.txt'), 'repeat me', 'utf-8');

    await FileRead.run({ path: 'notes.txt' }, ctx);
    const second = await FileRead.run({ path: 'notes.txt' }, ctx);

    expect(second).toEqual({
      ok: true,
      data: expect.objectContaining({
        status: 'file_unchanged',
        path: 'notes.txt',
        content: '',
        unchanged: true,
        returnedChars: 0,
        contentHash: expect.any(String),
      }),
    });
  });

  it('records methodology reads by skill and active plan step', async () => {
    const workspaceDir = await setupWorkspace();
    const session: any = {
      id: 'session-1',
      workspaceDir,
      flags: {
        activeMethodologyRequirement: {
          stepId: 'task-2',
          skills: ['js-surface-analysis'],
          paths: ['/workspace/.skills/js-surface-analysis/methodology.md'],
        },
      },
      currentPlanStepId: 'task-2',
      turn: 4,
    };
    const ctx = makeContext(workspaceDir, {
      turnNumber: 4,
      sessionStore: {
        get: vi.fn(() => session),
        setAsync: vi.fn(async (_sessionId: string, updated: unknown) => Object.assign(session, updated)),
      } as any,
      trace: { write: vi.fn().mockResolvedValue(undefined) } as any,
    });
    const target = path.join(workspaceDir, '.skills', 'js-surface-analysis', 'methodology.md');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '# JS surface methodology', 'utf-8');

    const result = await FileRead.run({ path: '.skills/js-surface-analysis/methodology.md' }, ctx);

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        content: '# JS surface methodology',
        path: '.skills/js-surface-analysis/methodology.md',
      }),
    });
    expect(session.flags.skillMethodologyReads).toEqual({
      'js-surface-analysis': expect.objectContaining({
        byPlanStepId: 'task-2',
        path: '/workspace/.skills/js-surface-analysis/methodology.md',
      }),
    });
    expect(session.flags.activeMethodologyRequirement).toBeUndefined();
    expect(ctx.sessionStore.setAsync).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        flags: expect.objectContaining({
          skillMethodologyReads: expect.objectContaining({
            'js-surface-analysis': expect.any(Object),
          }),
        }),
      }),
      'file_read.skill_methodology_read',
    );
    expect(ctx.trace?.write).toHaveBeenCalledWith(
      'session-1',
      4,
      expect.objectContaining({
        event: 'skill.methodology.read',
        payload: expect.objectContaining({
          skill: 'js-surface-analysis',
          stepId: 'task-2',
          remainingRequiredSkills: [],
        }),
      }),
    );
  });

  it('writes content to a workspace file', async () => {
    const workspaceDir = await setupWorkspace();
    const ctx = makeContext(workspaceDir);

    const result = await FileWrite.run({ path: 'dir/output.txt', content: 'payload' }, ctx);

    expect(ctx.guards.pathGuard.ensureInsideWorkspace).toHaveBeenCalledWith('dir/output.txt');
    expect(result).toEqual({ ok: true, data: { success: true, path: 'dir/output.txt' } });
    expect(await fs.readFile(path.join(workspaceDir, 'dir', 'output.txt'), 'utf-8')).toBe('payload');
  });

  it('rejects non-string content for write', async () => {
    const workspaceDir = await setupWorkspace();
    const ctx = makeContext(workspaceDir);

    const result = await FileWrite.run({ path: 'out.txt', content: 42 } as any, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toEqual({ error: 'content must be a string' });
  });

  it('allows report.md writes while background sidecar workers are still active', async () => {
    const workspaceDir = await setupWorkspace();
    const ctx = makeContext(workspaceDir, {
      sessionStore: {
        get: vi.fn(() => ({
          id: 'session-1',
          workspaceDir,
          mode: 'automated',
          agentType: 'executor',
          coordination: { role: 'direct' },
          workerTasks: [
            {
              taskId: 'task-sidecar',
              status: 'running',
              executionMode: 'background',
              dependencyMode: 'sidecar',
            },
          ],
          flags: {},
        })),
      } as any,
    });

    const result = await FileWrite.run({ path: 'report.md', content: '# report' }, ctx);

    expect(result).toEqual({ ok: true, data: { success: true, path: 'report.md' } });
    expect(await fs.readFile(path.join(workspaceDir, 'report.md'), 'utf-8')).toBe('# report');
  });
});
