const { spawnSync } = require('node:child_process');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '..');
const vitestBin = require.resolve('vitest/vitest.mjs');
const args = [
  vitestBin,
  'run',
  'tests/smoke',
  ...process.argv.slice(2),
];

const result = spawnSync(process.execPath, args, {
  cwd: backendRoot,
  env: {
    ...process.env,
    RUN_SANDBOX_TOOL_SMOKE: '1',
  },
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
