import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { PathGuard as SandboxPathGuard } from '@/domains/agent-brain/adapters/sandbox';

describe('Sandbox PathGuard contract', () => {
  const workspace = path.resolve('/tmp/ws/session-1');
  const artifacts = path.resolve('/tmp/artifacts/session-1');

  it('resolves workspace-relative paths safely', () => {
    const guard = new SandboxPathGuard(workspace, artifacts);
    const resolved = guard.workspacePath('nested/file.txt');

    expect(resolved).toBe(path.join(workspace, 'nested', 'file.txt'));
  });

  it('rejects attempts to escape the workspace', () => {
    const guard = new SandboxPathGuard(workspace, artifacts);

    expect(() => guard.workspacePath('../etc/passwd')).toThrow('policy.path_outside_workspace');
    expect(() => guard.workspacePath('/etc/passwd')).toThrow('policy.path_outside_workspace');
  });

  it('enforces artifact paths inside the artifacts root', () => {
    const guard = new SandboxPathGuard(workspace, artifacts);
    const resolved = guard.artifactPath('stdout.log');

    expect(resolved).toBe(path.join(artifacts, 'stdout.log'));
    expect(() => guard.artifactPath('../escape.log')).toThrow('policy.path_outside_workspace');
  });
});






