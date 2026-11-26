import { normalizeAndValidatePath, validateShellCommand } from './pathUtils';

/** The mount point used inside sandbox containers. */
const CONTAINER_WORKSPACE_MOUNT = '/workspace';

export class PathGuard {
  constructor(private readonly workspaceDir: string) {}

  ensureInsideWorkspace(targetPath: string): string {
    // Translate container-perspective paths (e.g. /workspace/file.txt)
    // to the actual host workspace path before validation.
    const mapped = this.mapContainerPath(targetPath);
    return normalizeAndValidatePath(mapped, this.workspaceDir);
  }

  private mapContainerPath(targetPath: string): string {
    const normalized = normalizeContainerPath(targetPath);
    if (normalized === CONTAINER_WORKSPACE_MOUNT || normalized.startsWith(CONTAINER_WORKSPACE_MOUNT + '/')) {
      const relative = normalized.slice(CONTAINER_WORKSPACE_MOUNT.length + 1); // strip '/workspace/'
      return relative ? `${this.workspaceDir}/${relative}` : this.workspaceDir;
    }
    return targetPath;
  }
}

export class CmdGuard {
  validate(command: string): void {
    const error = validateShellCommand(command);
    if (error) {
      throw new Error(error);
    }
  }
}

const normalizeContainerPath = (targetPath: string): string => {
  const collapsed = targetPath.replace(/\\/g, '/');
  const segments = collapsed.split('/');
  const normalizedSegments: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      normalizedSegments.pop();
      continue;
    }
    normalizedSegments.push(segment);
  }

  return '/' + normalizedSegments.join('/');
};
