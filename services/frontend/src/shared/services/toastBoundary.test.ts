import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = path.join(process.cwd(), 'src');
const allowedSonnerImports = new Set([
  path.normalize('shared/services/toastService.ts'),
  path.normalize('shared/services/toastService.test.ts'),
  path.normalize('shared/ui/AppToaster.tsx'),
]);

const collectSourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const fullPath = path.join(directory, entry);
    const relativePath = path.relative(srcRoot, fullPath);

    if (entry === 'dist' || entry === 'node_modules') {
      return [];
    }

    if (statSync(fullPath).isDirectory()) {
      return collectSourceFiles(fullPath);
    }

    return /\.(ts|tsx)$/.test(relativePath) ? [fullPath] : [];
  });

describe('toast boundary', () => {
  it('keeps Sonner behind the shared toast boundary', () => {
    const directImportPattern = /\b(?:import|export)\b[\s\S]*?\bfrom\s+['"]sonner['"]/;
    const offenders = collectSourceFiles(srcRoot)
      .filter((filePath) => !allowedSonnerImports.has(path.normalize(path.relative(srcRoot, filePath))))
      .filter((filePath) => directImportPattern.test(readFileSync(filePath, 'utf8')))
      .map((filePath) => path.relative(srcRoot, filePath));

    expect(offenders).toEqual([]);
  });

  it('does not leave the removed custom toast renderers in source', () => {
    expect(existsSync(path.join(srcRoot, 'shared/providers/ToastProvider.tsx'))).toBe(false);
    expect(existsSync(path.join(srcRoot, 'modules/chat/ui/Toast.tsx'))).toBe(false);
    expect(existsSync(path.join(srcRoot, 'modules/chat/ui/ErrorToastRetry.tsx'))).toBe(false);
  });
});
