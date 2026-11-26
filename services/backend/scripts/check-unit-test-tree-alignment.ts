import fs from 'node:fs';
import path from 'node:path';

type AlignmentMismatch = {
  test: string;
  checkedSubjects: string[];
};

const root = path.resolve(__dirname, '..');
const testsRoot = path.join(root, 'tests/unit');
const srcRoot = path.join(root, 'src');

const toPosix = (value: string): string => value.split(path.sep).join('/');

const walkTestFiles = (directory: string, files: string[] = []): string[] => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkTestFiles(fullPath, files);
      continue;
    }
    if (entry.isFile() && /\.test\.ts$/u.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
};

const fileExists = (pathname: string): boolean => {
  if (!fs.existsSync(pathname)) {
    return false;
  }

  const relativePath = path.relative(srcRoot, pathname);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return false;
  }

  let currentDirectory = srcRoot;
  for (const segment of relativePath.split(path.sep)) {
    const entries = fs.readdirSync(currentDirectory, { withFileTypes: true });
    const matchingEntry = entries.find((entry) => entry.name === segment);
    if (!matchingEntry) {
      return false;
    }
    currentDirectory = path.join(currentDirectory, segment);
  }

  return fs.statSync(currentDirectory).isFile();
};

const subjectCandidates = (testStem: string): string[] => {
  const candidates = [testStem];
  const firstDot = testStem.indexOf('.');
  if (firstDot > 0) {
    candidates.push(testStem.slice(0, firstDot));
  }
  return Array.from(new Set(candidates));
};

const hasSubjectInSameDirectory = (testDir: string, candidates: string[]): boolean =>
  candidates.some((candidate) =>
    fileExists(path.join(srcRoot, testDir, `${candidate}.ts`)) ||
    fileExists(path.join(srcRoot, testDir, `${candidate}.tsx`)),
  );

const hasBarrelInSameDirectory = (testDir: string): boolean =>
  fileExists(path.join(srcRoot, testDir, 'index.ts')) ||
  fileExists(path.join(srcRoot, testDir, 'index.tsx'));

const testFiles = walkTestFiles(testsRoot);
const mismatches: AlignmentMismatch[] = [];

for (const file of testFiles) {
  const relativeTestPath = toPosix(path.relative(testsRoot, file));

  // Script tests mirror scripts/, not src/. The PRD alignment invariant only covers tests for src modules.
  if (relativeTestPath.startsWith('scripts/')) {
    continue;
  }

  const testDir = path.posix.dirname(relativeTestPath);
  const testStem = path.posix.basename(relativeTestPath, '.test.ts');
  const candidates = subjectCandidates(testStem);

  if (hasSubjectInSameDirectory(testDir, candidates) || hasBarrelInSameDirectory(testDir)) {
    continue;
  }

  mismatches.push({
    test: relativeTestPath,
    checkedSubjects: candidates.map((candidate) => `${testDir}/${candidate}.ts`),
  });
}

if (mismatches.length > 0) {
  console.error(`Unit test tree alignment failed: ${mismatches.length} mismatch(es).`);
  console.error(JSON.stringify(mismatches.slice(0, 80), null, 2));
  process.exit(1);
}

console.log(`UNIT_TEST_COUNT=${testFiles.length}`);
console.log('ALIGNMENT_MISMATCH_COUNT=0');
