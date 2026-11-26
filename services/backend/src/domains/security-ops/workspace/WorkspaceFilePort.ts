import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import type { SessionState } from '@/domains/agent-brain/domain/types';

export type WorkspaceTargetKind = 'local' | 'runner';

export interface WorkspaceFilePort {
  ensureDir(relativePath: string): Promise<void>;
  writeFileAtomic(relativePath: string, content: string | Buffer): Promise<void>;
  readFile(relativePath: string): Promise<string>;
  exists(relativePath: string): Promise<boolean>;
}

export interface WorkspaceTarget {
  runId: string;
  workspacePath: string;
  kind: WorkspaceTargetKind;
  filePort: WorkspaceFilePort;
}

export interface WorkspaceSandboxWriter {
  writeFile(session: SessionState, targetPath: string, content: string | Buffer): Promise<void>;
  readFile?(session: SessionState, targetPath: string, maxBytes?: number): Promise<Buffer>;
  exec?(options: {
    session?: SessionState;
    sessionId?: string;
    cmd: string;
    cwd?: string;
    timeoutMs?: number;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export const normalizeWorkspaceRelativePath = (value: string): string => {
  const trimmed = value.trim().replace(/\\/g, '/');
  const withoutWorkspace = trimmed.startsWith('/workspace/')
    ? trimmed.slice('/workspace/'.length)
    : trimmed === '/workspace'
      ? ''
      : trimmed.replace(/^\/+/, '');
  const normalized = path.posix.normalize(withoutWorkspace);
  if (!normalized || normalized === '.') {
    return '';
  }
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error(`workspace_path_outside_root:${value}`);
  }
  return normalized;
};

const resolveWithinRoot = (workspacePath: string, relativePath: string): string => {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const root = path.resolve(workspacePath);
  const absolute = path.resolve(root, normalized);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(`workspace_path_outside_root:${relativePath}`);
  }
  return absolute;
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

const workspaceAbsolutePath = (relativePath: string): string =>
  relativePath ? `/workspace/${relativePath}` : '/workspace';

export class LocalWorkspaceFilePort implements WorkspaceFilePort {
  constructor(private readonly workspacePath: string) {}

  async ensureDir(relativePath: string): Promise<void> {
    const absolute = resolveWithinRoot(this.workspacePath, relativePath);
    await fs.mkdir(absolute, { recursive: true });
  }

  async writeFileAtomic(relativePath: string, content: string | Buffer): Promise<void> {
    const normalized = normalizeWorkspaceRelativePath(relativePath);
    if (!normalized) {
      throw new Error('workspace_file_path_required');
    }

    const absolute = resolveWithinRoot(this.workspacePath, normalized);
    const directory = path.dirname(absolute);
    const basename = path.basename(absolute);
    const tempPath = path.join(directory, `.${basename}.tmp-${process.pid}-${randomUUID()}`);

    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(tempPath, content);
      await fs.rename(tempPath, absolute);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async readFile(relativePath: string): Promise<string> {
    return fs.readFile(resolveWithinRoot(this.workspacePath, relativePath), 'utf8');
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(resolveWithinRoot(this.workspacePath, relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async removeFile(relativePath: string): Promise<void> {
    await fs.rm(resolveWithinRoot(this.workspacePath, relativePath), { force: true });
  }
}

export class SandboxWorkspaceFilePort implements WorkspaceFilePort {
  private readonly local: LocalWorkspaceFilePort;

  constructor(
    workspacePath: string,
    private readonly session: SessionState,
    private readonly sandbox: WorkspaceSandboxWriter,
  ) {
    this.local = new LocalWorkspaceFilePort(workspacePath);
  }

  async ensureDir(relativePath: string): Promise<void> {
    await this.local.ensureDir(relativePath);
  }

  async writeFileAtomic(relativePath: string, content: string | Buffer): Promise<void> {
    const normalized = normalizeWorkspaceRelativePath(relativePath);
    if (!normalized) {
      throw new Error('workspace_file_path_required');
    }
    if (!this.sandbox.exec) {
      await this.local.writeFileAtomic(normalized, content);
      await this.sandbox.writeFile(this.session, normalized, content);
      return;
    }

    const directory = path.posix.dirname(normalized);
    const basename = path.posix.basename(normalized);
    const tempRelativePath = path.posix.join(
      directory === '.' ? '' : directory,
      `.${basename}.tmp-${process.pid}-${randomUUID()}`,
    );

    await this.sandbox.writeFile(this.session, tempRelativePath, content);
    const workspaceDir = directory === '.' ? '' : directory;
    const result = await this.sandbox.exec({
      session: this.session,
      cmd: [
        `mkdir -p ${shellQuote(workspaceAbsolutePath(workspaceDir))}`,
        `mv -f ${shellQuote(workspaceAbsolutePath(tempRelativePath))} ${shellQuote(workspaceAbsolutePath(normalized))}`,
      ].join(' && '),
      timeoutMs: 10_000,
    });

    if (result.exitCode !== 0) {
      throw new Error(`workspace_remote_atomic_replace_failed:${result.stderr || result.stdout || result.exitCode}`);
    }

    await this.local.writeFileAtomic(normalized, content);
    await this.local.removeFile(tempRelativePath).catch(() => undefined);
  }

  async readFile(relativePath: string): Promise<string> {
    if (this.sandbox.readFile) {
      try {
        return (await this.sandbox.readFile(this.session, relativePath)).toString('utf8');
      } catch {
        // Fall back to the local mirror kept by writeFileAtomic.
      }
    }
    return this.local.readFile(relativePath);
  }

  async exists(relativePath: string): Promise<boolean> {
    return this.local.exists(relativePath);
  }
}

export const createLocalWorkspaceTarget = (params: {
  runId: string;
  workspacePath: string;
}): WorkspaceTarget => ({
  runId: params.runId,
  workspacePath: params.workspacePath,
  kind: 'local',
  filePort: new LocalWorkspaceFilePort(params.workspacePath),
});

export const createSandboxWorkspaceTarget = (params: {
  runId: string;
  session: SessionState;
  sandbox: WorkspaceSandboxWriter;
}): WorkspaceTarget => ({
  runId: params.runId,
  workspacePath: params.session.workspaceDir,
  kind: 'runner',
  filePort: new SandboxWorkspaceFilePort(params.session.workspaceDir, params.session, params.sandbox),
});
