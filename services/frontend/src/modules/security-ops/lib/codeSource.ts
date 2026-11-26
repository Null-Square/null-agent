import type { CodeSource } from '../types';

/** The last part of a folder path or a git URL, without `.git`: `juice-shop`. */
export const codeSourceName = (codeSource: Pick<CodeSource, 'location'>): string => {
  const parts = codeSource.location.trim().replace(/[\\/]+$/u, '').split(/[\\/:]/u);
  const last = parts[parts.length - 1] ?? '';
  return last.replace(/\.git$/iu, '') || codeSource.location;
};

/** The commit (a clone) or content hash (a folder) a Code Review pins, shortened. */
export const shortCommit = (headCommit: string | null): string | null =>
  headCommit ? headCommit.slice(0, 7) : null;

/** `juice-shop · 3f9c2a1`, or the name alone while no commit is known. */
export const describeCodeSource = (codeSource: Pick<CodeSource, 'location' | 'headCommit'>): string => {
  const commit = shortCommit(codeSource.headCommit);
  const name = codeSourceName(codeSource);
  return commit ? `${name} · ${commit}` : name;
};
