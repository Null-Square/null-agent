const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const {
  cleanupSession,
  performBrowserAction,
  shutdownBrowserSessions,
} = require('./browserSessionManager');

const TOKEN = process.env.TOKEN;
const API_URL = process.env.API_URL;
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 30_000);
const RECONNECT_INITIAL_DELAY_MS = Number(process.env.RECONNECT_INITIAL_DELAY_MS || 2_000);
const RECONNECT_MAX_DELAY_MS = Number(process.env.RECONNECT_MAX_DELAY_MS || 60_000);
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/workspace';
const WORKSPACE_TTL_MS = Number(process.env.WORKSPACE_TTL_MS || 604_800_000);
const RUNNER_PROTOCOL_VERSION = Number(process.env.RUNNER_PROTOCOL_VERSION || 2);
const RUNNER_CAPABILITIES = [
  'exec',
  'file_read',
  'file_write',
  'artifact_request',
  'session_init',
  'session_destroy',
  'file_stat',
  'browser_action',
  'browser_screenshot',
  'browser_network',
  'browser_state',
  'browser_evidence_bundle',
  'browser_trace',
  'workspace_key',
];

if (!TOKEN || !API_URL) {
  console.error(JSON.stringify({ level: 'error', message: 'TOKEN and API_URL are required' }));
  process.exit(1);
}

const wsUrl = (() => {
  const base = API_URL.replace(/\/+$/, '');
  if (base.startsWith('https://')) {
    return `wss://${base.slice('https://'.length)}/api/app/runner-agent/connect`;
  }
  if (base.startsWith('http://')) {
    return `ws://${base.slice('http://'.length)}/api/app/runner-agent/connect`;
  }
  return `${base}/api/app/runner-agent/connect`;
})();

const inflight = new Map();
let ws = null;
let reconnectDelay = RECONNECT_INITIAL_DELAY_MS;
let reconnectTimer = null;
let heartbeatTimer = null;
let cleanupTimer = null;
let isShuttingDown = false;

const log = (level, message, fields = {}) => {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  console.log(JSON.stringify(payload));
};

const netmaskToPrefix = (netmask) => {
  if (!netmask || typeof netmask !== 'string') return null;
  const octets = netmask.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  const binary = octets.map((part) => part.toString(2).padStart(8, '0')).join('');
  const firstZero = binary.indexOf('0');
  const prefix = firstZero === -1 ? 32 : firstZero;
  return /^1*0*$/.test(binary) ? prefix : null;
};

const collectRunnerNetworkAddresses = () => {
  const entries = [];
  const interfaces = os.networkInterfaces();
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) {
        continue;
      }
      const prefix = netmaskToPrefix(address.netmask);
      entries.push(`${name}:${address.address}${prefix === null ? '' : `/${prefix}`}`);
    }
  }
  return entries.slice(0, 16).join(',');
};

const safeSend = (payload) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(payload));
};

const normalizeWorkspaceKey = (value, fallback) => {
  const raw = String(value || fallback || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || raw === '.' || raw === '..' || raw.includes('/')) {
    throw new Error('Invalid workspace key');
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(raw)) {
    throw new Error('Invalid workspace key');
  }
  return raw;
};

const workspaceKeyForMessage = (message) => normalizeWorkspaceKey(message.workspaceKey, message.sessionId);

const ensureSessionDir = async (sessionId, workspaceKey = sessionId) => {
  const sessionDir = path.join(WORKSPACE_ROOT, normalizeWorkspaceKey(workspaceKey, sessionId));
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(path.join(sessionDir, '.artifacts'), { recursive: true });
  return sessionDir;
};

const resolveWorkspacePath = async (sessionId, requestedPath, workspaceKey = sessionId) => {
  const baseDir = await ensureSessionDir(sessionId, workspaceKey);
  const relativePath = normalizeRelativePath(requestedPath);
  if (!relativePath) {
    throw new Error('path is required');
  }
  const root = path.resolve(baseDir);
  const fullPath = path.resolve(root, relativePath);
  if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) {
    throw new Error('Path escapes workspace');
  }
  return { baseDir, relativePath, fullPath };
};

const cleanupExpiredWorkspaces = async () => {
  try {
    const entries = await fs.readdir(WORKSPACE_ROOT, { withFileTypes: true });
    const cutoff = Date.now() - WORKSPACE_TTL_MS;
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const dirPath = path.join(WORKSPACE_ROOT, entry.name);
          const stat = await fs.stat(dirPath);
          if (stat.mtimeMs < cutoff) {
            await fs.rm(dirPath, { recursive: true, force: true });
          }
        }),
    );
  } catch (error) {
    log('warn', 'workspace_cleanup_failed', { error: String(error) });
  }
};

const normalizeRelativePath = (value) =>
  String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');

const MIN_DISK_FREE_MB = 500;

const checkDiskSpace = async () => {
  try {
    const child = spawn('df', ['-m', WORKSPACE_ROOT], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    return await new Promise((resolve) => {
      child.on('close', () => {
        const output = Buffer.concat(chunks).toString('utf-8').trim();
        const lines = output.split('\n');
        const dataLine = lines[lines.length - 1] || '';
        const parts = dataLine.split(/\s+/);
        const avail = parseInt(parts[3], 10);
        resolve(Number.isFinite(avail) ? avail : Infinity);
      });
      child.on('error', () => resolve(Infinity));
    });
  } catch {
    return Infinity;
  }
};

const listArtifactFiles = async (baseDir, requestedPath) => {
  const relativePath = normalizeRelativePath(requestedPath);
  if (!relativePath) {
    return [];
  }

  const root = path.resolve(baseDir);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    return [];
  }

  const stat = await fs.stat(target).catch(() => null);
  if (!stat) {
    return [];
  }

  if (stat.isFile()) {
    return [{ relativePath, fullPath: target }];
  }

  if (!stat.isDirectory()) {
    return [];
  }

  const entries = await fs.readdir(target, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const childRelative = `${relativePath}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listArtifactFiles(baseDir, childRelative)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    files.push({
      relativePath: normalizeRelativePath(childRelative),
      fullPath: path.resolve(root, childRelative),
    });
  }

  return files;
};

const handleExec = async (message) => {
  const requestId = message.requestId;
  const sessionId = message.sessionId;
  const workspaceKey = workspaceKeyForMessage(message);
  const command = String(message.command || '').trim();
  const env = message.env && typeof message.env === 'object' ? message.env : {};
  const timeoutMs =
    typeof message.timeoutMs === 'number' && message.timeoutMs > 0 ? message.timeoutMs : null;

  if (!requestId || !sessionId || !command) {
    safeSend({
      type: 'error',
      requestId,
      sessionId,
      message: 'exec requires requestId, sessionId, and command',
    });
    return;
  }

  const availMB = await checkDiskSpace();
  if (availMB < MIN_DISK_FREE_MB) {
    safeSend({
      type: 'error',
      requestId,
      sessionId,
      message: `Insufficient disk space: ${availMB}MB available, ${MIN_DISK_FREE_MB}MB required`,
    });
    return;
  }

  const cwd = await ensureSessionDir(sessionId, workspaceKey);
  const child = spawn('/bin/sh', ['-lc', command], {
    cwd,
    env: { ...process.env, ...env },
  });
  inflight.set(requestId, child);

  let cmdTimeoutHandle = null;
  if (timeoutMs) {
    cmdTimeoutHandle = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }, 5_000);
    }, timeoutMs);
  }

  child.stdout.on('data', (chunk) => {
    safeSend({
      type: 'stdout',
      requestId,
      sessionId,
      workspaceKey,
      data: chunk.toString('utf-8'),
    });
  });

  child.stderr.on('data', (chunk) => {
    safeSend({
      type: 'stderr',
      requestId,
      sessionId,
      workspaceKey,
      data: chunk.toString('utf-8'),
    });
  });

  child.on('error', (error) => {
    if (cmdTimeoutHandle) clearTimeout(cmdTimeoutHandle);
    inflight.delete(requestId);
    safeSend({
      type: 'error',
      requestId,
      sessionId,
      workspaceKey,
      message: String(error),
    });
  });

  child.on('close', (code) => {
    if (cmdTimeoutHandle) clearTimeout(cmdTimeoutHandle);
    inflight.delete(requestId);
    safeSend({
      type: 'exit',
      requestId,
      sessionId,
      workspaceKey,
      code: Number.isFinite(code) ? code : 1,
    });
  });
};

const handleFileRead = async (message) => {
  const requestId = message.requestId;
  const sessionId = message.sessionId;
  const workspaceKey = workspaceKeyForMessage(message);
  const relativePath = String(message.path || '').trim();

  if (!requestId || !sessionId || !relativePath) {
    safeSend({
      type: 'error',
      requestId,
      sessionId,
      message: 'file_read requires requestId, sessionId, and path',
    });
    return;
  }

  try {
    const { fullPath } = await resolveWorkspacePath(sessionId, relativePath, workspaceKey);
    const content = await fs.readFile(fullPath);
    safeSend({
      type: 'file_read_result',
      requestId,
      sessionId,
      workspaceKey,
      contentBase64: content.toString('base64'),
    });
  } catch (error) {
    safeSend({
      type: 'error',
      requestId,
      sessionId,
      message: String(error),
    });
  }
};

const handleFileWrite = async (message) => {
  const requestId = message.requestId;
  const sessionId = message.sessionId;
  const workspaceKey = workspaceKeyForMessage(message);
  const relativePath = String(message.path || '').trim();
  const encoding = String(message.contentEncoding || 'utf8').toLowerCase();

  if (!requestId || !sessionId || !relativePath) {
    safeSend({
      type: 'error',
      requestId,
      sessionId,
      message: 'file_write requires requestId, sessionId, and path',
    });
    return;
  }

  try {
    const { fullPath } = await resolveWorkspacePath(sessionId, relativePath, workspaceKey);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    const payload = String(message.content || '');
    const data =
      encoding === 'base64' ? Buffer.from(payload, 'base64') : Buffer.from(payload, 'utf-8');

    await fs.writeFile(fullPath, data);
    safeSend({
      type: 'file_write_ack',
      requestId,
      sessionId,
      workspaceKey,
    });
  } catch (error) {
    safeSend({
      type: 'error',
      requestId,
      sessionId,
      message: String(error),
    });
  }
};

const handleFileStat = async (message) => {
  const requestId = message.requestId;
  const sessionId = message.sessionId;
  const workspaceKey = workspaceKeyForMessage(message);
  const relativePath = String(message.path || '').trim();

  if (!requestId || !sessionId || !relativePath) {
    safeSend({
      type: 'error',
      requestId,
      sessionId,
      message: 'file_stat requires requestId, sessionId, and path',
    });
    return;
  }

  try {
    const { fullPath } = await resolveWorkspacePath(sessionId, relativePath, workspaceKey);
    const stat = await fs.stat(fullPath).catch(() => null);
    safeSend({
      type: 'file_stat_result',
      requestId,
      sessionId,
      workspaceKey,
      exists: Boolean(stat),
      isFile: stat ? stat.isFile() : false,
      sizeBytes: stat ? stat.size : 0,
      mtimeMs: stat ? stat.mtimeMs : null,
    });
  } catch (error) {
    safeSend({
      type: 'error',
      requestId,
      sessionId,
      message: String(error),
    });
  }
};

const handleSessionInit = async (message) => {
  const requestId = message.requestId;
  const sessionId = message.sessionId;
  const workspaceKey = workspaceKeyForMessage(message);
  if (!requestId || !sessionId) {
    safeSend({
      type: 'error',
      requestId,
      sessionId,
      message: 'session_init requires requestId and sessionId',
    });
    return;
  }

  try {
    await ensureSessionDir(sessionId, workspaceKey);
    safeSend({
      type: 'session_init_ack',
      requestId,
      sessionId,
      workspaceKey,
    });
  } catch (error) {
    safeSend({
      type: 'error',
      requestId,
      sessionId,
      message: String(error),
    });
  }
};

const handleSessionDestroy = async (message) => {
  const requestId = message.requestId;
  const sessionId = message.sessionId;
  const workspaceKey = workspaceKeyForMessage(message);
  if (!requestId || !sessionId) {
    safeSend({
      type: 'error',
      requestId,
      sessionId,
      message: 'session_destroy requires requestId and sessionId',
    });
    return;
  }

  try {
    await cleanupSession(sessionId).catch(() => undefined);
    if (workspaceKey === sessionId) {
      await fs.rm(path.join(WORKSPACE_ROOT, sessionId), { recursive: true, force: true });
    }
    safeSend({
      type: 'session_destroy_ack',
      requestId,
      sessionId,
      workspaceKey,
    });
  } catch (error) {
    safeSend({
      type: 'error',
      requestId,
      sessionId,
      message: String(error),
    });
  }
};

const handleArtifactRequest = async (message) => {
  const requestId = message.requestId;
  const sessionId = message.sessionId;
  const workspaceKey = workspaceKeyForMessage(message);
  const paths = Array.isArray(message.paths) ? message.paths : [];

  if (!requestId || !sessionId) {
    safeSend({
      type: 'error',
      requestId,
      sessionId,
      message: 'artifact_request requires requestId and sessionId',
    });
    return;
  }

  try {
    const baseDir = await ensureSessionDir(sessionId, workspaceKey);
    const seenPaths = new Set();
    const filesToSend = [];

    for (const rawPath of paths) {
      const discovered = await listArtifactFiles(baseDir, rawPath);
      for (const file of discovered) {
        if (seenPaths.has(file.relativePath)) {
          continue;
        }
        seenPaths.add(file.relativePath);
        filesToSend.push(file);
      }
    }

    for (const file of filesToSend) {
      const content = await fs.readFile(file.fullPath);
      safeSend({
        type: 'artifact',
        requestId,
        sessionId,
        workspaceKey,
        path: file.relativePath,
        content: content.toString('base64'),
        contentEncoding: 'base64',
      });
    }

    safeSend({
      type: 'artifact_done',
      requestId,
      sessionId,
      workspaceKey,
    });
  } catch (error) {
    safeSend({
      type: 'error',
      requestId,
      sessionId,
      message: String(error),
    });
  }
};

const handleBrowserAction = async (message) => {
  const requestId = message.requestId;
  const sessionId = message.sessionId;
  const workspaceKey = workspaceKeyForMessage(message);
  const action = String(message.action || '').trim();
  const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};

  if (!requestId || !sessionId || !action) {
    safeSend({
      type: 'error',
      requestId,
      sessionId,
      message: 'browser_action requires requestId, sessionId, and action',
    });
    return;
  }

  try {
    const workspaceDir = await ensureSessionDir(sessionId, workspaceKey);
    const data = await performBrowserAction(sessionId, action, payload, {
      workspaceDir,
      scopePolicy: message.scopeBoundary,
    });
    safeSend({
      type: 'browser_action_result',
      requestId,
      sessionId,
      workspaceKey,
      data,
    });
  } catch (error) {
    safeSend({
      type: 'error',
      requestId,
      sessionId,
      message: String(error),
    });
  }
};

const handleMessage = async (raw) => {
  let message;
  try {
    message = JSON.parse(raw.toString('utf-8'));
  } catch {
    return;
  }

  if (!message || typeof message !== 'object') {
    return;
  }

  const requestId = message.requestId;
  const sessionId = message.sessionId;

  try {
    switch (message.type) {
      case 'exec':
        await handleExec(message);
        return;
      case 'session_init':
        await handleSessionInit(message);
        return;
      case 'session_destroy':
        await handleSessionDestroy(message);
        return;
      case 'file_read':
        await handleFileRead(message);
        return;
      case 'file_write':
        await handleFileWrite(message);
        return;
      case 'file_stat':
        await handleFileStat(message);
        return;
      case 'artifact_request':
        await handleArtifactRequest(message);
        return;
      case 'browser_action':
        await handleBrowserAction(message);
        return;
      default:
        return;
    }
  } catch (error) {
    log('error', 'message_handler_threw', { type: message.type, error: String(error) });
    safeSend({ type: 'error', requestId, sessionId, message: String(error) });
  }
};

const scheduleReconnect = () => {
  if (isShuttingDown || reconnectTimer) {
    return;
  }
  const jitter = Math.floor(Math.random() * 500);
  const delay = Math.min(RECONNECT_MAX_DELAY_MS, reconnectDelay + jitter);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
  reconnectDelay = Math.min(RECONNECT_MAX_DELAY_MS, reconnectDelay * 2);
};

const clearTimers = () => {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
};

const connect = () => {
  if (isShuttingDown) return;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  ws = new WebSocket(wsUrl, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'x-runner-version': 'shell-server/1.0.0',
      'x-runner-protocol-version': String(RUNNER_PROTOCOL_VERSION),
      'x-runner-capabilities': RUNNER_CAPABILITIES.join(','),
      'x-runner-platform': process.platform,
      'x-runner-network-addresses': collectRunnerNetworkAddresses(),
    },
  });

  ws.on('open', () => {
    reconnectDelay = RECONNECT_INITIAL_DELAY_MS;
    log('info', 'runner_connected', { wsUrl });

    heartbeatTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        ws.ping();
      } catch (error) {
        log('warn', 'runner_ping_failed', { error: String(error) });
      }
    }, HEARTBEAT_INTERVAL_MS);
  });

  ws.on('message', (raw) => {
    void handleMessage(raw);
  });

  ws.on('close', () => {
    clearTimers();
    log('warn', 'runner_disconnected');
    scheduleReconnect();
  });

  ws.on('error', (error) => {
    log('warn', 'runner_socket_error', { error: String(error) });
  });
};

const shutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  clearTimers();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  for (const [, child] of inflight) {
    child.kill('SIGTERM');
  }
  inflight.clear();
  await shutdownBrowserSessions().catch(() => undefined);

  if (ws) {
    try {
      ws.close(1000, 'shutdown');
    } catch {
      // no-op
    }
  }
  process.exit(0);
};

void fs.mkdir(WORKSPACE_ROOT, { recursive: true }).catch((error) => {
  log('error', 'workspace_init_failed', { error: String(error) });
  process.exit(1);
});

cleanupTimer = setInterval(() => {
  void cleanupExpiredWorkspaces();
}, Math.max(60_000, Math.floor(WORKSPACE_TTL_MS / 4)));

process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});

connect();
