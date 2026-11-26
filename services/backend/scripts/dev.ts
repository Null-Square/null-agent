/**
 * `npm run dev` (from the repository root, or here): Postgres and storage in Docker, the backend on
 * this computer with reload.
 *
 *   1. docker compose up -d --wait dev-ports sandbox-gateway
 *                                              db and storage on 127.0.0.1:25432 and 127.0.0.1:29000, and
 *                                              the sealed network the agent's sandboxes join
 *   2. npm run db:migrate, then npm run db:seed
 *   3. tsx watch src/index.ts                  prints the link that opens Null AI as you
 *
 * The app runs beside it (`npm run dev` at the root starts both). For everything in Docker, use
 * `docker compose up` at the root instead.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const backendDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(backendDir, '..', '..');
const shell = process.platform === 'win32';

const run = (command: string, args: string[], cwd: string): void => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

// The agent's tools run in sandboxes on the sealed network, here as under docker compose: its only way
// out is sandbox-gateway (the internet and the lab, nothing on this computer or your network).
const sandboxImage = process.env.SANDBOX_IMAGE?.trim() || 'null-ai-sandbox:local';
if (spawnSync('docker', ['image', 'inspect', sandboxImage], { stdio: 'ignore', shell }).status !== 0) {
  console.log(`[dev] Building the sandbox image ${sandboxImage} (the first time takes a while)...`);
  run('docker', ['compose', 'build', 'sandbox-image'], repoRoot);
}

console.log('[dev] Starting the database, storage and the sandbox gateway (docker compose)...');
run('docker', ['compose', 'up', '-d', '--wait', 'dev-ports', 'sandbox-gateway'], repoRoot);
process.env.SANDBOX_NETWORK ||= 'null-ai-sandbox';

console.log('[dev] Migrating and seeding...');
run('npm', ['run', 'db:migrate'], backendDir);
run('npm', ['run', 'db:seed'], backendDir);

console.log('[dev] Starting the backend...');
const server = spawn('npx', ['tsx', 'watch', 'src/index.ts'], { cwd: backendDir, stdio: 'inherit', shell });
const stop = () => server.kill('SIGINT');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => process.exit(code ?? 0));
