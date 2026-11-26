import fs from 'fs/promises';
import path from 'path';

import {
  RUNTIME_CATALOG_SNAPSHOT_FILE,
  SkillLoader,
  resolveDefaultSkillsDir,
} from '../src/domains/security-ops/skills/SkillLoader';

const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const normalizeLineEndings = (value: string): string => value.replace(/\r\n?/gu, '\n');

const main = async (): Promise<void> => {
  const write = process.argv.includes('--write');
  const skillsDir = resolveDefaultSkillsDir();
  const outputPath = path.resolve(skillsDir, RUNTIME_CATALOG_SNAPSHOT_FILE);
  const loader = new SkillLoader(skillsDir, {
    mode: 'evaluation',
    runtimeSnapshotPolicy: 'ignore',
  });
  const expected = serialize(await loader.createRuntimeCatalogSnapshot());

  if (write) {
    await fs.writeFile(outputPath, expected, 'utf8');
    process.stdout.write(`Wrote ${outputPath}\n`);
    return;
  }

  let actual = '';
  try {
    actual = await fs.readFile(outputPath, 'utf8');
  } catch {
    // Report the same actionable command for a missing or unreadable snapshot.
  }
  if (normalizeLineEndings(actual) !== expected) {
    throw new Error(
      `${RUNTIME_CATALOG_SNAPSHOT_FILE} is stale; run npm run skills:runtime-snapshot:write -w services/backend`,
    );
  }
  process.stdout.write(`${RUNTIME_CATALOG_SNAPSHOT_FILE} is current\n`);
};

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
