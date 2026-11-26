import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const drizzleDirectory = path.resolve(process.cwd(), 'drizzle');

describe('Null AI migration baseline', () => {
  it('ships exactly one baseline migration', () => {
    const migrationFiles = readdirSync(drizzleDirectory)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    expect(migrationFiles).toEqual(['0000_baseline.sql']);
  });

  it('keeps the journal and the generated snapshot aligned to the baseline', () => {
    const journal = JSON.parse(
      readFileSync(path.join(drizzleDirectory, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const snapshotFiles = readdirSync(path.join(drizzleDirectory, 'meta'))
      .filter((file) => file.endsWith('_snapshot.json'))
      .sort();

    expect(journal.entries.map(({ idx, tag }) => ({ idx, tag }))).toEqual([
      { idx: 0, tag: '0000_baseline' },
    ]);
    expect(snapshotFiles).toEqual(['0000_snapshot.json']);
  });

  it('keeps the database-owned finding lifecycle trigger in the baseline', () => {
    const baseline = readFileSync(path.join(drizzleDirectory, '0000_baseline.sql'), 'utf8');
    expect(baseline).toContain('CREATE TRIGGER findings_lifecycle_version_trigger');
  });
});
