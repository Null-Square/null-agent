import { describe, it, expect } from 'vitest';
import path from 'path';
import { normalizeAndValidatePath, validateShellCommand } from '@/shared/utils/path-utils';

describe('normalizeAndValidatePath', () => {
  it('returns normalized paths within the workspace', () => {
    const workspaceDir = path.join(process.cwd(), 'workspace');
    const result = normalizeAndValidatePath('notes/report.md', workspaceDir);

    expect(result).toBe(path.normalize(path.resolve(workspaceDir, 'notes/report.md')));
  });

  it('rejects paths that escape the workspace', () => {
    const workspaceDir = path.join(process.cwd(), 'workspace');

    expect(() => normalizeAndValidatePath('../secret.txt', workspaceDir)).toThrow(
      'resolves outside workspace',
    );
  });

  it('rejects null bytes and allows dotted filenames', () => {
    const workspaceDir = path.join(process.cwd(), 'workspace');

    expect(() => normalizeAndValidatePath('evil\x00.txt', workspaceDir)).toThrow('null bytes');
    const safe = normalizeAndValidatePath('report..txt', workspaceDir);
    expect(safe.endsWith('report..txt')).toBe(true);
  });
});

describe('validateShellCommand', () => {
  it('returns null for safe commands', () => {
    expect(validateShellCommand('echo "hello"')).toBeNull();
  });

  it('rejects null bytes only', () => {
    expect(validateShellCommand('bad\x00cmd')).toMatch(/Security:/);
  });

  it('allows multi-line commands', () => {
    expect(validateShellCommand('echo first line\n echo second line')).toBeNull();
  });

  it('allows complex quoting used in security tooling', () => {
    expect(validateShellCommand(`grep -ao '/api/[^"'\\\`[:space:]]*' /workspace/js-bundle.js | sort -u`)).toBeNull();
    expect(validateShellCommand(`python3 -c "print('nested quotes are fine')"`)).toBeNull();
  });
});
