import fs from 'node:fs';
import path from 'node:path';

import type { ManifestTool, PhaseSmokeGroup, SmokeCheck } from './types';

export const findRepoRoot = (): string => {
  let current = process.cwd();
  while (true) {
    const packagePath = path.join(current, 'package.json');
    if (fs.existsSync(packagePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { name?: string };
        if (parsed.name === 'null-ai') {
          return current;
        }
      } catch {
        // Keep walking; a malformed package file will be surfaced elsewhere.
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error('Could not locate repo root from current working directory.');
    }
    current = parent;
  }
};

export const readToolManifest = (): ManifestTool[] => {
  const repoRoot = findRepoRoot();
  const manifestPath = path.join(repoRoot, 'services', 'sandbox', 'tools-manifest.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ManifestTool[];
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export const buildPhaseScript = (phase: PhaseSmokeGroup, manifestByName: Map<string, ManifestTool>): string => {
  const checks: SmokeCheck[] = [
    ...phase.tools.map((name) => {
      const manifestCheck = manifestByName.get(name);
      if (!manifestCheck) {
        throw new Error(`Missing sandbox tool manifest entry for ${name}`);
      }
      return manifestCheck;
    }),
    ...(phase.extraChecks ?? []),
  ];

  return [
    'set -u',
    'PASS=0',
    'FAIL=0',
    'emit_phase_smoke_result() {',
    '  status="$?"',
    `  echo "NULLAI_PHASE_SMOKE ${phase.phase} passed=$PASS failed=$FAIL exit=$status"`,
    '  exit "$status"',
    '}',
    'trap emit_phase_smoke_result EXIT',
    'check_output() {',
    '  label="$1"',
    '  expected="$2"',
    '  command_text="$3"',
    '  output="$(sh -lc "$command_text" 2>&1 || true)"',
    '  if printf "%s" "$output" | grep -Eiq "$expected"; then',
    '    echo "[PASS] $label"',
    '    PASS=$((PASS + 1))',
    '  else',
    '    echo "[FAIL] $label [$command_text] expected /$expected/"',
    '    printf "%s\\n" "$output" | tail -c 1200',
    '    echo',
    '    FAIL=$((FAIL + 1))',
    '  fi',
    '}',
    ...checks.map((check) =>
      `check_output ${shellQuote(check.name)} ${shellQuote(check.expect)} ${shellQuote(check.command)}`,
    ),
    'test "$FAIL" -eq 0',
  ].join('\n');
};
