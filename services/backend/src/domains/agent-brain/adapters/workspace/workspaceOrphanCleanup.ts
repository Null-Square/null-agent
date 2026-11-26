import fs from 'fs/promises';
import path from 'path';
import type {
  WorkspaceOrphanCleanupOptions,
  WorkspaceOrphanCleanupResult,
  WorkspaceOwner,
} from './WorkspaceManager';

type LoggerLike = {
  warn(payload: Record<string, unknown>, message: string): void;
};

type ReapLocalWorkspaceOrphansParams = WorkspaceOrphanCleanupOptions & {
  root: string;
  cleanupWorkspace(workspaceDir: string, owner: WorkspaceOwner): Promise<void>;
  log: LoggerLike;
};

type WorkspaceDirent = {
  name: string;
  isDirectory(): boolean;
};

const DEFAULT_MIN_AGE_MS = 10 * 60 * 1000;

const emptyResult = (): WorkspaceOrphanCleanupResult => ({
  found: 0,
  reaped: 0,
  skippedActive: 0,
  skippedYoung: 0,
  errors: 0,
  reapedWorkspaces: [],
});

const parseWorkspaceOwner = (name: string): WorkspaceOwner | null => {
  if (name.startsWith('ns-agent-')) {
    const id = name.slice('ns-agent-'.length).trim();
    return id ? { kind: 'session', id } : null;
  }
  if (name.startsWith('ns-run-')) {
    const id = name.slice('ns-run-'.length).trim();
    return id ? { kind: 'run', id } : null;
  }
  return null;
};

export const reapLocalWorkspaceOrphans = async (
  params: ReapLocalWorkspaceOrphansParams,
): Promise<WorkspaceOrphanCleanupResult> => {
  const result = emptyResult();
  const minAgeMs = params.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const root = path.resolve(params.root);
  const now = Date.now();

  let entries: WorkspaceDirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true }) as WorkspaceDirent[];
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === 'ENOENT') {
      return result;
    }
    params.log.warn({ err: error, root }, 'Failed to enumerate workspace root for orphan cleanup');
    result.errors += 1;
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const owner = parseWorkspaceOwner(entry.name);
    if (!owner) {
      continue;
    }

    result.found += 1;
    const workspaceDir = path.resolve(root, entry.name);
    if (workspaceDir !== root && !workspaceDir.startsWith(`${root}${path.sep}`)) {
      result.errors += 1;
      params.log.warn({ root, workspaceDir }, 'Skipping workspace outside configured root');
      continue;
    }

    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stats = await fs.stat(workspaceDir);
    } catch (error) {
      result.errors += 1;
      params.log.warn({ err: error, workspaceDir, owner }, 'Failed to stat candidate orphan workspace');
      continue;
    }

    const ageMs = now - Math.max(stats.mtimeMs, stats.ctimeMs);
    if (minAgeMs > 0 && ageMs < minAgeMs) {
      result.skippedYoung += 1;
      continue;
    }

    let active = true;
    try {
      active = await params.isOwnerActive(owner);
    } catch (error) {
      result.errors += 1;
      params.log.warn({ err: error, workspaceDir, owner }, 'Failed to check workspace owner activity');
      continue;
    }

    if (active) {
      result.skippedActive += 1;
      continue;
    }

    try {
      await params.cleanupWorkspace(workspaceDir, owner);
      result.reaped += 1;
      result.reapedWorkspaces.push(workspaceDir);
    } catch (error) {
      result.errors += 1;
      params.log.warn({ err: error, workspaceDir, owner }, 'Failed to cleanup orphan workspace');
    }
  }

  return result;
};
