import fs from 'fs';
import path from 'path';

const ROOTS = [
  path.resolve(__dirname, '..', 'src', 'interfaces'),
  path.resolve(__dirname, '..', 'src', 'shared', 'middleware'),
];

const DISALLOWED = ['process.env', 'loadAppConfig('];
const ALLOW_DIR_PATTERNS = [path.sep + 'config' + path.sep];

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip config folder; it is allowed to read env there.
      if (ALLOW_DIR_PATTERNS.some((pattern) => full.includes(pattern))) {
        continue;
      }
      files.push(...(await walk(full)));
    } else if (entry.isFile() && full.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

async function main(): Promise<void> {
  const files = (await Promise.all(ROOTS.map((dir) => walk(dir)))).flat();
  const violations: Array<{ file: string; token: string }> = [];

  for (const file of files) {
    const content = await fs.promises.readFile(file, 'utf8');
    for (const token of DISALLOWED) {
      if (content.includes(token)) {
        violations.push({ file, token });
      }
    }
  }

  if (violations.length > 0) {
    // Group by file for clarity
    const grouped = violations.reduce<Record<string, Set<string>>>((acc, cur) => {
      acc[cur.file] = acc[cur.file] ?? new Set<string>();
      acc[cur.file].add(cur.token);
      return acc;
    }, {});

    console.error('[lint-config-usage] Detected direct env access in HTTP/middleware files:');
    for (const [file, tokens] of Object.entries(grouped)) {
      console.error(` - ${path.relative(path.resolve(__dirname, '..'), file)} => ${Array.from(tokens).join(', ')}`);
    }
    process.exit(1);
  }
}

void main();
