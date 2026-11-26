import { afterEach, describe, expect, it } from 'vitest';
import { runnerCommandInternals } from '@/domains/security-ops/runners/RunnerService';

const ENV_KEYS = [
  'RUNNER_IMAGE',
  'RUNNER_FORCE_REMOTE_IMAGE',
  'RUNNER_LOCAL_BUILD_CONTEXT',
  'RUNNER_SOURCE_REPO_URL',
  'RUNNER_SOURCE_REF',
  'NODE_ENV',
] as const;

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = originalEnv[key];
  }
});

describe('runner install command generation', () => {
  it('prefers an explicit host build context for local backend URLs', () => {
    process.env.NODE_ENV = 'development';
    process.env.RUNNER_IMAGE = 'registry.example.com/null-ai-sandbox:1';
    process.env.RUNNER_LOCAL_BUILD_CONTEXT = 'C:\\Projects\\Null-Ai';

    const command = runnerCommandInternals.buildInstallCommand(
      'runner-b7bae0ae',
      'token-123',
      'http://localhost:3001',
    );

    expect(command).toContain('docker build -f "C:\\Projects\\Null-Ai\\services\\sandbox\\Dockerfile"');
    expect(command).toContain('"C:\\Projects\\Null-Ai"');
    expect(command).toContain('nullsquare-runner-local:latest');
    expect(command).not.toContain('registry.example.com/null-ai-sandbox:1');
  });

  it('falls back to a git source build for local backend URLs when no host path is configured', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.RUNNER_LOCAL_BUILD_CONTEXT;
    process.env.RUNNER_SOURCE_REPO_URL = 'https://github.com/null-square/null-ai.git';
    process.env.RUNNER_SOURCE_REF = 'abc123';

    const command = runnerCommandInternals.buildInstallCommand(
      'runner-b7bae0ae',
      'token-123',
      'http://localhost:3001',
    );

    expect(command).toContain('docker build --pull -f "services/sandbox/Dockerfile"');
    expect(command).toContain('"https://github.com/null-square/null-ai.git#abc123"');
    expect(command).toContain('nullsquare-runner-local:latest');
    expect(command).not.toContain('registry.example.com/null-ai-sandbox:1');
  });

  it('allows forcing the remote image path explicitly', () => {
    process.env.RUNNER_FORCE_REMOTE_IMAGE = '1';
    process.env.RUNNER_IMAGE = 'registry.example.com/null-ai-sandbox:1';
    process.env.RUNNER_LOCAL_BUILD_CONTEXT = 'C:\\Projects\\Null-Ai';

    const command = runnerCommandInternals.buildInstallCommand(
      'runner-b7bae0ae',
      'token-123',
      'http://localhost:3001',
    );

    expect(command).toContain('docker run -d --pull always');
    expect(command).toContain('registry.example.com/null-ai-sandbox:1');
    expect(command).not.toContain('docker build -f');
  });

  it('runs the image this repository builds by default, without pulling it from a registry', () => {
    process.env.RUNNER_FORCE_REMOTE_IMAGE = '1';
    delete process.env.RUNNER_IMAGE;

    const command = runnerCommandInternals.buildInstallCommand(
      'runner-b7bae0ae',
      'token-123',
      'http://localhost:3001',
    );

    expect(command).toMatch(/ null-ai-sandbox:local$/);
    expect(command).not.toContain('--pull');
  });
});
