import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  open: vi.fn(),
  stat: vi.fn(),
  copyFile: vi.fn(),
}));

vi.mock('fs', () => ({
  promises: {
    mkdir: (...args: any[]) => fsMocks.mkdir(...args),
    writeFile: (...args: any[]) => fsMocks.writeFile(...args),
    readFile: (...args: any[]) => fsMocks.readFile(...args),
    open: (...args: any[]) => fsMocks.open(...args),
    stat: (...args: any[]) => fsMocks.stat(...args),
    copyFile: (...args: any[]) => fsMocks.copyFile(...args),
  },
}));

const cryptoMocks = vi.hoisted(() => ({
  randomUUID: vi.fn(),
}));

vi.mock('crypto', () => ({
  randomUUID: cryptoMocks.randomUUID,
}));

describe('FSService', () => {
  let FSService: typeof import('@/domains/agent-brain/adapters/sandbox').FSService;

  beforeEach(async () => {
    vi.resetModules();
    fsMocks.mkdir.mockReset();
    fsMocks.writeFile.mockReset();
    fsMocks.readFile.mockReset();
    fsMocks.open.mockReset();
    fsMocks.stat.mockReset();
    fsMocks.copyFile.mockReset();
    cryptoMocks.randomUUID.mockReturnValue('uuid-1');
    ({ FSService } = await import('@/domains/agent-brain/adapters/sandbox'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when workspace directory is missing', async () => {
    const service = new FSService({
      resolveRoots: () => ({ workspaceDir: '' as any, artifactsDir: '' as any }),
    });

    await expect(service.writeFile({} as any, 'note.txt', 'data')).rejects.toThrow(
      'Session workspace directory is not configured.',
    );
  });

  it('writes files inside the workspace directory', async () => {
    const workspaceDir = path.join(process.cwd(), 'workspace');
    const artifactsDir = path.join(workspaceDir, 'artifacts');
    const service = new FSService({
      resolveRoots: () => ({ workspaceDir, artifactsDir }),
    });

    await service.writeFile({} as any, 'notes/report.txt', 'hello');

    const expectedPath = path.resolve(workspaceDir, 'notes/report.txt');
    expect(fsMocks.mkdir).toHaveBeenCalledWith(path.dirname(expectedPath), { recursive: true });
    expect(fsMocks.writeFile).toHaveBeenCalledWith(expectedPath, expect.any(Buffer));
    const written = fsMocks.writeFile.mock.calls[0][1] as Buffer;
    expect(written.toString('utf8')).toBe('hello');
  });

  it('rejects paths outside the workspace', async () => {
    const workspaceDir = path.join(process.cwd(), 'workspace');
    const artifactsDir = path.join(workspaceDir, 'artifacts');
    const service = new FSService({
      resolveRoots: () => ({ workspaceDir, artifactsDir }),
    });

    await expect(service.readFile({} as any, '../secret.txt')).rejects.toThrow(
      'policy.path_outside_workspace',
    );
    expect(fsMocks.readFile).not.toHaveBeenCalled();
  });

  it('uses a bounded prefix read when maxBytes is provided', async () => {
    const workspaceDir = path.join(process.cwd(), 'workspace');
    const artifactsDir = path.join(workspaceDir, 'artifacts');
    const close = vi.fn();
    const read = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
      Buffer.from('abcdef').copy(buffer, offset, 0, length);
      return { bytesRead: length, buffer };
    });
    fsMocks.open.mockResolvedValue({
      stat: vi.fn(async () => ({ size: 100 })),
      read,
      close,
    });
    const service = new FSService({
      resolveRoots: () => ({ workspaceDir, artifactsDir }),
    });

    const result = await service.readFile({} as any, 'large.jsonl', 4);

    expect(fsMocks.readFile).not.toHaveBeenCalled();
    expect(fsMocks.open).toHaveBeenCalledWith(path.resolve(workspaceDir, 'large.jsonl'), 'r');
    expect(read).toHaveBeenCalledWith(expect.any(Buffer), 0, 4, 0);
    expect(close).toHaveBeenCalled();
    expect(result.toString('utf8')).toBe('abcd');
  });

  it('writes artifacts with sanitized names', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123456);
    const workspaceDir = path.join(process.cwd(), 'workspace');
    const artifactsDir = path.join(workspaceDir, 'artifacts');
    const service = new FSService({
      resolveRoots: () => ({ workspaceDir, artifactsDir }),
    });

    const result = await service.writeArtifact({} as any, {
      prefix: 'my report!',
      extension: '.txt',
      content: 'data',
    });

    expect(result.absolutePath.startsWith(artifactsDir)).toBe(true);
    expect(result.relativePath.startsWith('artifacts')).toBe(true);
    const writtenPath = fsMocks.writeFile.mock.calls[0][0] as string;
    const basename = path.basename(writtenPath);
    expect(basename.startsWith('my-report-')).toBe(true);
    expect(basename.endsWith('.txt')).toBe(true);
  });
});
