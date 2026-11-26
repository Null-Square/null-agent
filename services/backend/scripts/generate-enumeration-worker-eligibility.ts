import { readFile, writeFile } from 'fs/promises';
import path from 'path';

import { EnumerationWorkerSkillResolver } from '@/domains/security-ops/skills/EnumerationWorkerSkillResolver';

const outputPath = path.resolve(
  __dirname,
  '../../../services/evaluation-lab/catalog/baselines/b1/enumeration-worker-v1-eligibility.json',
);
const normalizeLineEndings = (value: string): string => value.replace(/\r\n?/gu, '\n');

const main = async (): Promise<void> => {
  const report = await new EnumerationWorkerSkillResolver().assertAcceptedCatalog();
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.argv.includes('--write')) {
    await writeFile(outputPath, serialized, 'utf8');
    process.stdout.write(`wrote ${path.relative(process.cwd(), outputPath)}\n`);
    return;
  }
  const current = await readFile(outputPath, 'utf8').catch(() => '');
  if (normalizeLineEndings(current) !== serialized) {
    throw new Error(
      'enumeration worker eligibility report is stale; run npm run skills:enumeration-eligibility:write',
    );
  }
  process.stdout.write('enumeration worker eligibility report is current\n');
};

void main();
