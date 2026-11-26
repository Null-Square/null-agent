import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

const TRACKED_INPUTS = [
  'src',
  'tests',
  'scripts',
  'drizzle',
  'package.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'config/skills/catalog.yaml',
  'config/skills/coverage.yaml',
  'config/skills/tool-ownership.yaml',
];

export const computeB1ReleaseCodeDigest = async (
  backendRoot = path.resolve(__dirname, '../..'),
): Promise<string> => {
  const output = execFileSync(
    'git',
    [
      'ls-files',
      '-co',
      '--exclude-standard',
      '-z',
      '--',
      ...TRACKED_INPUTS,
    ],
    {
      cwd: backendRoot,
      encoding: 'buffer',
    },
  );
  const relativePaths = output
    .toString('utf8')
    .split('\0')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();
  const digest = createHash('sha256');
  for (const relativePath of relativePaths) {
    const absolutePath = path.resolve(backendRoot, relativePath);
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) continue;
    digest.update(relativePath.replace(/\\/g, '/'), 'utf8');
    digest.update('\0', 'utf8');
    digest.update(await fs.readFile(absolutePath));
    digest.update('\0', 'utf8');
  }
  return digest.digest('hex');
};
