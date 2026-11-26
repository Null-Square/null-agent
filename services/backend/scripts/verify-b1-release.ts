import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { SkillLoader } from '../src/domains/security-ops/skills/SkillLoader';
import { computeB1ReleaseCodeDigest } from './lib/b1ReleaseDigest';

type CommandResult = {
  name: string;
  command: string;
  passed: boolean;
  exitCode: number;
};

type VitestJson = {
  success?: boolean;
  numTotalTestSuites?: number;
  numPassedTestSuites?: number;
  numFailedTestSuites?: number;
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
};

const BACKEND_ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.resolve(BACKEND_ROOT, '../../services/evaluation-lab/catalog/baselines/b1');
const JSON_PATH = path.resolve(REPORTS_DIR, 'verification-report.json');
const MARKDOWN_PATH = path.resolve(REPORTS_DIR, 'verification-report.md');

const run = (name: string, executable: string, args: string[]): CommandResult => {
  const command = [executable, ...args].join(' ');
  const result = spawnSync(executable, args, {
    cwd: BACKEND_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return {
    name,
    command,
    passed: result.status === 0,
    exitCode: result.status ?? 1,
  };
};

const catalogDigest = async (): Promise<{
  catalogVersion: string;
  digest: string;
}> => {
  const loader = new SkillLoader(undefined, { mode: 'evaluation' });
  const manifest = await loader.getCatalogManifest();
  const skills = (await loader.loadSkillCatalog())
    .filter((skill) => skill.releaseTrack === 'b1');
  return {
    catalogVersion: manifest.catalogVersion,
    digest: createHash('sha256')
      .update(
        skills
          .map((skill) => `${skill.slug}:${skill.versionHash}`)
          .sort()
          .join('\n'),
        'utf8',
      )
      .digest('hex'),
  };
};

const main = async (): Promise<void> => {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nullai-b1-vitest-'));
  const vitestJsonPath = path.resolve(temporaryDir, 'vitest.json');
  const commands: CommandResult[] = [];
  try {
    commands.push(
      run('unit-test-tree-alignment', 'npx', ['tsx', './scripts/check-unit-test-tree-alignment.ts']),
    );
    if (commands.every((entry) => entry.passed)) {
      commands.push(run('typescript', 'npx', ['tsc', '--noEmit', '--pretty', 'false']));
    }
    if (commands.every((entry) => entry.passed)) {
      commands.push(
        run('vitest', 'npx', [
          'vitest',
          'run',
          '--reporter=json',
          `--outputFile=${vitestJsonPath}`,
        ]),
      );
    }

    let vitest: VitestJson = {};
    try {
      vitest = JSON.parse(await fs.readFile(vitestJsonPath, 'utf8')) as VitestJson;
    } catch {
      // The command result remains the authoritative failure when no JSON exists.
    }
    const catalog = await catalogDigest();
    const releaseCodeDigest = await computeB1ReleaseCodeDigest(BACKEND_ROOT);
    const passed = commands.length === 3
      && commands.every((entry) => entry.passed)
      && vitest.success === true
      && (vitest.numFailedTests ?? 0) === 0
      && (vitest.numFailedTestSuites ?? 0) === 0;
    const report = {
      schemaVersion: 1,
      reportKind: 'b1-release-verification',
      completedAt: new Date().toISOString(),
      catalogVersion: catalog.catalogVersion,
      catalogDigest: catalog.digest,
      releaseCodeDigest,
      passed,
      commands,
      vitest: {
        totalSuites: vitest.numTotalTestSuites ?? 0,
        passedSuites: vitest.numPassedTestSuites ?? 0,
        failedSuites: vitest.numFailedTestSuites ?? 0,
        totalTests: vitest.numTotalTests ?? 0,
        passedTests: vitest.numPassedTests ?? 0,
        failedTests: vitest.numFailedTests ?? 0,
        pendingTests: vitest.numPendingTests ?? 0,
      },
      environment: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
      },
    };
    const markdown = [
      '# B1 Release Verification',
      '',
      `- Result: **${passed ? 'PASS' : 'FAIL'}**`,
      `- Catalog: \`${catalog.catalogVersion}\``,
      `- Catalog digest: \`${catalog.digest}\``,
      `- Release code digest: \`${releaseCodeDigest}\``,
      `- Test suites passed/total: ${report.vitest.passedSuites}/${report.vitest.totalSuites}`,
      `- Tests passed/total: ${report.vitest.passedTests}/${report.vitest.totalTests}`,
      '',
      '| Gate | Result | Command |',
      '|---|---:|---|',
      ...commands.map((entry) =>
        `| ${entry.name} | ${entry.passed ? 'PASS' : 'FAIL'} | \`${entry.command}\` |`),
      '',
    ].join('\n');
    await Promise.all([
      fs.writeFile(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
      fs.writeFile(MARKDOWN_PATH, markdown, 'utf8'),
    ]);
    process.stdout.write(markdown);
    if (!passed) process.exitCode = 1;
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
};

void main();
