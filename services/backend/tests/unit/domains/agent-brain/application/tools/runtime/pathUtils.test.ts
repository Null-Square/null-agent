import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { normalizeAndValidatePath, validateShellCommand } from '@/domains/agent-brain/application/tools';

describe('pathUtils', () => {
  it('normalizes paths within the workspace', () => {
    const workspaceDir = path.resolve('workspace-root');
    const result = normalizeAndValidatePath('subdir/file.txt', workspaceDir);

    expect(result).toBe(path.join(workspaceDir, 'subdir', 'file.txt'));
  });

  it('rejects paths outside the workspace', () => {
    const workspaceDir = path.resolve('workspace-root');

    expect(() => normalizeAndValidatePath('../secret.txt', workspaceDir)).toThrow('outside workspace');
  });

  it('rejects null byte paths', () => {
    const workspaceDir = path.resolve('workspace-root');

    expect(() => normalizeAndValidatePath('bad\0path.txt', workspaceDir)).toThrow('null bytes');
  });

  it('validates shell commands for unsafe patterns', () => {
    expect(validateShellCommand('echo \"ok\"')).toBeNull();
    expect(validateShellCommand('echo `whoami`')).toBeNull();
    expect(validateShellCommand('echo first line\n echo second line')).toBeNull();
    expect(validateShellCommand(`grep -ao '/api/[^"'\\\`[:space:]]*' /workspace/js-bundle.js | sort -u`)).toBeNull();
    expect(validateShellCommand('bad\0cmd')).toContain('null bytes');
  });
});
