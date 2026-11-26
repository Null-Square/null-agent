import path from 'path';

export class PathGuard {
  constructor(
    private readonly workspaceHostDir: string,
    private readonly artifactsHostDir: string,
  ) {}

  private resolveSafe(root: string, target: string): string {
    const normalized = target.replace(/^~\//, '');
    const absolute = path.resolve(root, normalized);

    if (!absolute.startsWith(root)) {
      throw new Error('policy.path_outside_workspace');
    }

    return absolute;
  }

  workspacePath(relativePath: string): string {
    return this.resolveSafe(this.workspaceHostDir, relativePath);
  }

  artifactPath(name: string): string {
    return this.resolveSafe(this.artifactsHostDir, name);
  }
}

