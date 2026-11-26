const { spawnSync } = require('node:child_process');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '..');
const vitestBin = require.resolve('vitest/vitest.mjs');

const result = spawnSync(process.execPath, [
  vitestBin,
  'run',
  'tests/smoke/oob-dev-parity.smoke.test.ts',
  ...process.argv.slice(2),
], {
  cwd: backendRoot,
  env: {
    ...process.env,
    RUN_OOB_DEV_PARITY_SMOKE: '1',
  },
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
