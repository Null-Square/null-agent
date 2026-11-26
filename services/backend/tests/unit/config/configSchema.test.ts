import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAppConfig, localSettings, workspaceRootDir } from '@/config/configSchema';

const testEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  ...overrides,
});

describe('loadAppConfig optional URLs', () => {
  it('treats blank optional URLs as unconfigured', () => {
    const config = loadAppConfig(testEnv({
      TEST_DATABASE_URL: '',
      WEB_SEARCH_BASE_URL: '  ',
      PROMETHEUS_URL: '',
    }));

    expect(config.TEST_DATABASE_URL).toBeUndefined();
    expect(config.WEB_SEARCH_BASE_URL).toBeUndefined();
    expect(config.PROMETHEUS_URL).toBeUndefined();
  });

  it('rejects a configured optional URL when it is malformed', () => {
    expect(() => loadAppConfig(testEnv({
      PROMETHEUS_URL: 'not-a-url',
    }))).toThrow(/PROMETHEUS_URL: Invalid url/);
  });

  it('needs no billing, email or sign-in settings: Null AI starts without them', () => {
    const config = loadAppConfig(testEnv({}));
    expect(config).not.toHaveProperty('PADDLE_ENVIRONMENT');
    expect(config).not.toHaveProperty('STRIPE_SECRET_KEY');
    expect(config).not.toHaveProperty('JWT_SECRET');
  });
});

describe('loadAppConfig optional enums', () => {
  it('treats a blank optional Interactsh callback scheme as unconfigured', () => {
    const config = loadAppConfig(testEnv({
      INTERACTSH_CALLBACK_SCHEME: '',
    }));

    expect(config.INTERACTSH_CALLBACK_SCHEME).toBeUndefined();
  });

  it('rejects malformed Interactsh callback schemes', () => {
    expect(() => loadAppConfig(testEnv({
      INTERACTSH_CALLBACK_SCHEME: 'ftp',
    }))).toThrow(/INTERACTSH_CALLBACK_SCHEME: Invalid enum value/);
  });
});

describe('Null AI local settings', () => {
  it('declares each with its default, read without a database', () => {
    expect(localSettings({})).toEqual({
      NULL_AI_BIND_HOST: '127.0.0.1',
      NULL_AI_ALLOWED_HOSTS: [],
      NULL_AI_APP_URL: 'http://localhost:8081',
      NULL_AI_HOME: path.join(homedir(), '.null-ai'),
      NULL_AI_OWNER_KEY_FILE: undefined,
      NULL_AI_LAB_TARGETS: [],
      NULL_AI_CODE_ROOT: undefined,
      WORKSPACE_ROOT: undefined,
    });
  });

  it('treats a blank value as unset, so its default applies', () => {
    const settings = localSettings({
      NULL_AI_BIND_HOST: '  ',
      NULL_AI_APP_URL: '',
      NULL_AI_HOME: ' ',
      NULL_AI_CODE_ROOT: '',
      WORKSPACE_ROOT: ' ',
    });
    expect(settings.NULL_AI_BIND_HOST).toBe('127.0.0.1');
    expect(settings.NULL_AI_APP_URL).toBe('http://localhost:8081');
    expect(settings.NULL_AI_HOME).toBe(path.join(homedir(), '.null-ai'));
    expect(settings.NULL_AI_CODE_ROOT).toBeUndefined();
    expect(settings.WORKSPACE_ROOT).toBeUndefined();
  });

  it('reads host lists as trimmed lower-case names and the app URL without a trailing slash', () => {
    const settings = localSettings({
      NULL_AI_ALLOWED_HOSTS: ' Null.Lan , ,box ',
      NULL_AI_LAB_TARGETS: 'Juice-Shop.lab,',
      NULL_AI_APP_URL: ' http://localhost:8080// ',
    });
    expect(settings.NULL_AI_ALLOWED_HOSTS).toEqual(['null.lan', 'box']);
    expect(settings.NULL_AI_LAB_TARGETS).toEqual(['juice-shop.lab']);
    expect(settings.NULL_AI_APP_URL).toBe('http://localhost:8080');
  });

  it('resolves the workspace root against the working directory, default storage/workspaces', () => {
    expect(workspaceRootDir(undefined)).toBe(path.resolve(process.cwd(), 'storage', 'workspaces'));
    expect(workspaceRootDir('data/ws')).toBe(path.resolve(process.cwd(), 'data/ws'));
  });

  it('is part of the full schema, with the same values', () => {
    const config = loadAppConfig(testEnv({ NULL_AI_LAB_TARGETS: 'juice-shop.lab' }));
    expect(config.NULL_AI_LAB_TARGETS).toEqual(['juice-shop.lab']);
    expect(config.NULL_AI_BIND_HOST).toBe('127.0.0.1');
  });
});
