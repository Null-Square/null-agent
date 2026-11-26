import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { SessionState } from '../../domain/types';
import { PathGuard } from './PathGuard';

export type FileStat = {
  size: number;
  mode: number;
  mtimeMs: number;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

type GuardContext = {
  guard: PathGuard;
  workspaceDir: string;
  artifactsDir: string;
};

type ArtifactOptions = {
  prefix: string;
  extension?: string;
  content: string | Buffer;
};

export type FSDependencies = {
  resolveRoots(session: SessionState): {
    workspaceDir: string;
    artifactsDir: string;
  };
};

export class FSService {
  constructor(private readonly deps: FSDependencies) {}

  private createContext(session: SessionState): GuardContext {
    const roots = this.deps.resolveRoots(session);
    if (!roots?.workspaceDir) {
      throw new Error('Session workspace directory is not configured.');
    }
    const workspaceDir = path.resolve(roots.workspaceDir);
    const artifactsDir = roots.artifactsDir
      ? path.resolve(roots.artifactsDir)
      : workspaceDir;
    return {
      guard: new PathGuard(workspaceDir, artifactsDir),
      workspaceDir,
      artifactsDir,
    };
  }

  private normalizeContent(content: string | Buffer): Buffer {
    return typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  }

  async writeFile(
    session: SessionState,
    targetPath: string,
    content: string | Buffer,
  ): Promise<void> {
    const { guard } = this.createContext(session);
    const absolute = guard.workspacePath(targetPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, this.normalizeContent(content));
  }

  async readFile(
    session: SessionState,
    targetPath: string,
    maxBytes?: number,
  ): Promise<Buffer> {
    const { guard } = this.createContext(session);
    const absolute = guard.workspacePath(targetPath);
    if (typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes >= 0) {
      if (maxBytes <= 0) {
        return Buffer.alloc(0);
      }
      const handle = await fs.open(absolute, 'r');
      try {
        const stats = await handle.stat();
        const length = Math.min(stats.size, Math.floor(maxBytes));
        const buffer = Buffer.alloc(length);
        const read = await handle.read(buffer, 0, length, 0);
        return read.bytesRead === length ? buffer : buffer.subarray(0, read.bytesRead);
      } finally {
        await handle.close();
      }
    }
    return fs.readFile(absolute);
  }

  async readFileTail(
    session: SessionState,
    targetPath: string,
    maxBytes: number,
  ): Promise<Buffer> {
    if (maxBytes <= 0) {
      return Buffer.alloc(0);
    }
    const { guard } = this.createContext(session);
    const absolute = guard.workspacePath(targetPath);
    const handle = await fs.open(absolute, 'r');
    try {
      const stats = await handle.stat();
      const size = stats.size;
      const start = Math.max(0, size - maxBytes);
      const length = size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return buffer;
    } finally {
      await handle.close();
    }
  }

  async stat(session: SessionState, targetPath: string): Promise<FileStat> {
    const { guard } = this.createContext(session);
    const absolute = guard.workspacePath(targetPath);
    const stats = await fs.lstat(absolute);
    return {
      size: stats.size,
      mode: stats.mode,
      mtimeMs: stats.mtimeMs,
      isDirectory: stats.isDirectory(),
      isSymbolicLink: stats.isSymbolicLink(),
    };
  }

  async copyIn(
    session: SessionState,
    srcHostPath: string,
    destPath: string,
  ): Promise<void> {
    const { guard } = this.createContext(session);
    const absoluteDest = guard.workspacePath(destPath);
    await fs.mkdir(path.dirname(absoluteDest), { recursive: true });
    await fs.copyFile(srcHostPath, absoluteDest);
  }

  async copyOut(
    session: SessionState,
    srcPath: string,
    destHostPath: string,
  ): Promise<void> {
    const { guard } = this.createContext(session);
    const absoluteSrc = guard.workspacePath(srcPath);
    await fs.mkdir(path.dirname(destHostPath), { recursive: true });
    await fs.copyFile(absoluteSrc, destHostPath);
  }

  async writeArtifact(
    session: SessionState,
    options: ArtifactOptions,
  ): Promise<{ absolutePath: string; relativePath: string }> {
    const { guard, artifactsDir, workspaceDir } = this.createContext(session);
    await fs.mkdir(artifactsDir, { recursive: true });

    const safeName = this.buildArtifactName(options.prefix, options.extension);
    const absolute = guard.artifactPath(safeName);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, this.normalizeContent(options.content));

    return {
      absolutePath: absolute,
      relativePath: path.relative(workspaceDir, absolute),
    };
  }

  private buildArtifactName(prefix: string, extension?: string): string {
    const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '-');
    const ext = extension ? extension.replace(/^\./, '') : 'log';
    return `${safePrefix}-${Date.now()}-${randomUUID()}.${ext}`;
  }
}

