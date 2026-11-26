import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { CmdGuard, PathGuard } from '@/domains/agent-brain/application/tools';

describe('PathGuard', () => {
  const workspace = path.join(os.tmpdir(), 'guard-workspace');

  it('normalizes paths inside the workspace', () => {
    const guard = new PathGuard(workspace);
    const resolved = guard.ensureInsideWorkspace('nested/file.txt');

    expect(resolved.startsWith(workspace)).toBe(true);
    expect(resolved.endsWith(path.normalize('nested/file.txt'))).toBe(true);
  });

  it('rejects paths that escape the workspace', () => {
    const guard = new PathGuard(workspace);
    expect(() => guard.ensureInsideWorkspace('../outside.txt')).toThrow(/outside workspace/i);
  });

  it('rejects paths containing null bytes', () => {
    const guard = new PathGuard(workspace);
    expect(() => guard.ensureInsideWorkspace('bad\u0000path')).toThrow(/null bytes/i);
  });
});

describe('CmdGuard', () => {
  it('allows simple commands and multiline scripts', () => {
    const guard = new CmdGuard();

    expect(() => guard.validate(`echo "hello world"`)).not.toThrow();
    expect(() => guard.validate('echo first line\n echo second line')).not.toThrow();
  });

  it('rejects risky shell constructs', () => {
    const guard = new CmdGuard();

    expect(() => guard.validate('echo $(whoami)')).not.toThrow();
    expect(() => guard.validate('echo `whoami`')).not.toThrow();
    expect(() => guard.validate('echo line1\n echo line2')).not.toThrow();
    expect(() => guard.validate("echo 'unbalanced quote")).not.toThrow();
    expect(() => guard.validate('bad\u0000cmd')).toThrow(/null bytes/i);
  });
});







