import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ResolvedConfig } from '@/config/configTypes';
import type { SessionState } from '@/domains/agent-brain/domain/types';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

import { COMMAND_TIMEOUT_MS, SMOKE_IMAGE } from './constants';

export const buildSmokeConfig = (): ResolvedConfig =>
  ({
    sandbox: {
      image: SMOKE_IMAGE,
      network: 'bridge',
      devUnsafe: false,
      user: 'root',
      stdoutLimitBytes: 2_000_000,
    },
    runtime: {
      turnTimeoutMs: COMMAND_TIMEOUT_MS,
      maxToolCallsPerTurn: 200,
      shellTimeoutMs: COMMAND_TIMEOUT_MS,
      webTimeoutMs: 30_000,
      webMaxBytes: 1_000_000,
      sessionTTLMinutes: 30,
    },
    policy: { verboseLogging: false },
    automation: {
      maxGuardRetries: 0,
      requireReport: false,
      turnTimeoutMs: COMMAND_TIMEOUT_MS,
      checkpointIntervalToolCalls: 0,
      reportMinLength: 0,
      workspaceBackupEnabled: false,
    },
    accessControl: { enabled: true },
    trace: {
      traceInlineLimit: 4000,
      stdoutChunkSize: 8000,
      traceCompressOverBytes: 1_000_000,
      traceRetentionDays: 1,
      traceLogsRoot: path.join(tmpdir(), 'nullai-smoke-traces'),
      artifactDirName: '.artifacts',
      artifactMaxChars: 80_000,
      s3FlushIntervalMs: 5_000,
      s3FlushMaxEvents: 25,
    },
    auth: {
      agentApiKey: 'smoke',
      internalToken: 'smoke',
    },
    network: {
      corsAllowedOrigins: [],
      allowOutbound: false,
      outboundAllowlist: [],
    },
    workspace: {
      rootDir: path.join(tmpdir(), 'nullai-smoke-workspaces'),
      objectStoreRoot: path.join(tmpdir(), 'nullai-smoke-object-store'),
      artifactStorageRoot: path.join(tmpdir(), 'nullai-smoke-artifacts'),
    },
    manifests: {
      toolsDir: 'config/tools',
      toolDevWatch: false,
    },
    webSearch: {
      duckBaseUrl: 'https://duckduckgo.com/html',
      duckLiteBaseUrl: 'https://lite.duckduckgo.com/lite',
      tavilyBaseUrl: 'https://api.tavily.com/search',
      provider: 'duck',
      maxResults: 5,
      timeoutMs: 10_000,
      maxBytes: 100_000,
    },
    http: {
      logSlowMs: 1000,
      logDebugSampleRate: 0,
      logQuietPaths: [],
      uploadsMaxBytes: 1_000_000,
    },
    sessionLifecycle: {
      maxAgeDays: 1,
      maxCountPerUser: 0,
      retentionEnabled: false,
    },
    tokenGuard: {
      perSessionLimit: 0,
      perUserDailyLimit: 0,
      warningThresholdPct: 80,
    },
    oob: {
      pollIntervalSeconds: 30,
      tokenDefaultTtlSeconds: 600,
      tokenMaxTtlSeconds: 3600,
    },
  }) as ResolvedConfig;

export const buildSession = (workspaceDir: string): SessionState =>
  ({
    id: `smoke-${randomUUID()}`,
    userId: 'tool-smoke',
    messages: [],
    plan: [],
    memory: createEmptyMemory(),
    flags: {},
    workspaceDir,
    status: 'idle',
    createdAt: Date.now(),
    lastActive: Date.now(),
    turn: 0,
    checkpoints: {},
    sandboxProfile: 'tool-smoke',
    sandboxImage: SMOKE_IMAGE,
    mode: 'automated',
    executionMode: 'discovery',
  }) as SessionState;

export const assertDockerReady = (): void => {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      stdio: 'pipe',
    });
  } catch (error) {
    throw new Error(
      `RUN_SANDBOX_TOOL_SMOKE requires a running Docker daemon. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    execFileSync('docker', ['image', 'inspect', SMOKE_IMAGE], {
      stdio: 'pipe',
    });
  } catch (error) {
    throw new Error(
      `Sandbox smoke image '${SMOKE_IMAGE}' is not available locally. Build it with services/sandbox/test/verify-local.sh or pull the image before running npm run test:smoke -w services/backend. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
