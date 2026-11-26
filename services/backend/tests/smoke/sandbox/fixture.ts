import type { SandboxManager } from '@/domains/agent-brain/adapters/sandbox/SandboxManager';
import type { SessionState } from '@/domains/agent-brain/domain/types';

import { FIXTURE_PORT } from './constants';

export const makeWorkspaceRemovable = async (
  manager: SandboxManager,
  session: SessionState,
): Promise<void> => {
  await manager.exec({
    session,
    cmd: [
      'set +e',
      // The smoke container runs as root, so files created on the bind mount can
      // be non-removable by the host CI user unless permissions are relaxed first.
      'chmod -R a+rwX /workspace 2>/dev/null || true',
      'sync /workspace 2>/dev/null || true',
      'exit 0',
    ].join('\n'),
    timeoutMs: 30_000,
  });
};

export const startLocalFixture = async (
  manager: SandboxManager,
  session: SessionState,
): Promise<void> => {
  const script = [
    'set -eu',
    'mkdir -p /workspace/.artifacts/smoke/site/api',
    'printf "ok\\n" > /workspace/.artifacts/smoke/site/health',
    'cat > /workspace/.artifacts/smoke/site/index.html <<\'HTML\'',
    '<!doctype html>',
    '<html>',
    '<body>',
    '<a href="/health">health</a>',
    '<a href="/api/openapi.json">openapi</a>',
    '<script src="/app.js"></script>',
    '</body>',
    '</html>',
    'HTML',
    'cat > /workspace/.artifacts/smoke/site/api/openapi.json <<\'JSON\'',
    '{"openapi":"3.0.0","info":{"title":"smoke","version":"1.0.0"},"paths":{"/health":{"get":{"responses":{"200":{"description":"ok"}}}}}}',
    'JSON',
    'cat > /workspace/.artifacts/smoke/site/app.js <<\'JS\'',
    'fetch("/api/openapi.json");',
    'JS',
    `python3 -m http.server ${FIXTURE_PORT} --bind 127.0.0.1 --directory /workspace/.artifacts/smoke/site > /workspace/.artifacts/smoke/http-server.log 2>&1 &`,
    'echo $! > /workspace/.artifacts/smoke/http-server.pid',
    `for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS http://127.0.0.1:${FIXTURE_PORT}/health && exit 0; sleep 0.2; done`,
    'cat /workspace/.artifacts/smoke/http-server.log 2>/dev/null || true',
    'exit 1',
  ].join('\n');

  const result = await manager.exec({
    session,
    cmd: script,
    timeoutMs: 30_000,
  });

  if (result.exitCode !== 0) {
    throw new Error(`failed to start sandbox HTTP fixture\n${result.stdout}\n${result.stderr}`);
  }
};
