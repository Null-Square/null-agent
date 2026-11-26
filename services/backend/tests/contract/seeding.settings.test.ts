import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
/**
 * Settings Seed Schema Validation Tests
 * 
 * Tests for the settings seeding schemas including:
 * - Network settings (CORS origins, outbound allowlist)
 * - Task input schema from contracts
 */


import {
  NetworkSettingsSeedSchema,
  RuntimeSettingsSeedSchema,
  TraceSettingsSeedSchema,
  SandboxSettingsSeedSchema,
  ThreatWatchSettingsSeedSchema,
  TokenGuardSettingsSeedSchema,
  WebSearchSettingsSeedSchema,
} from '@/app/seeding/schemas';

describe('Network Settings Seed Schema', () => {
  describe('valid inputs', () => {
    it('should accept complete network settings', () => {
      const result = NetworkSettingsSeedSchema.safeParse({
        allowOutbound: true,
        outboundAllowlist: ['api.example.com'],
        corsAllowedOrigins: ['*.localhost', '*.nullsquare.net'],
      });
      
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowOutbound).toBe(true);
        expect(result.data.corsAllowedOrigins).toEqual(['*.localhost', '*.nullsquare.net']);
      }
    });

    it('should allow empty outbound allowlist', () => {
      const result = NetworkSettingsSeedSchema.safeParse({
        allowOutbound: false,
        outboundAllowlist: [],
        corsAllowedOrigins: ['*.localhost'],
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing settings', () => {
      const result = NetworkSettingsSeedSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});

describe('Runtime Settings Seed Schema', () => {
  it('should accept valid runtime settings', () => {
    const result = RuntimeSettingsSeedSchema.safeParse({
      turnTimeoutMs: 180000,
      maxToolCallsPerTurn: 64,
      shellTimeoutMs: 120000,
      webTimeoutMs: 15000,
      webMaxBytes: 1048576,
      sessionTTLMinutes: 120,
    });
    
    expect(result.success).toBe(true);
  });

  it('should reject missing settings', () => {
    const result = RuntimeSettingsSeedSchema.safeParse({
      turnTimeoutMs: 60000,
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-positive timeout', () => {
    const result = RuntimeSettingsSeedSchema.safeParse({
      turnTimeoutMs: 0,
      maxToolCallsPerTurn: 64,
      shellTimeoutMs: 120000,
      webTimeoutMs: 15000,
      webMaxBytes: 1048576,
      sessionTTLMinutes: 120,
    });
    expect(result.success).toBe(false);
  });
});

describe('Trace Settings Seed Schema', () => {
  it('should accept valid trace settings', () => {
    const result = TraceSettingsSeedSchema.safeParse({
      traceInlineLimit: 4096,
      stdoutChunkSize: 65536,
      traceCompressOverBytes: 1048576,
      traceRetentionDays: 14,
      traceLogsRoot: 'storage/object-store/traces',
      artifactDirName: '.artifacts',
      artifactMaxChars: 50000,
    });
    
    expect(result.success).toBe(true);
  });

  it('should reject non-positive retention days', () => {
    const result = TraceSettingsSeedSchema.safeParse({
      traceRetentionDays: 0,
      traceInlineLimit: 4096,
      stdoutChunkSize: 65536,
      traceCompressOverBytes: 1048576,
      traceLogsRoot: 'storage/object-store/traces',
      artifactDirName: '.artifacts',
      artifactMaxChars: 50000,
    });
    expect(result.success).toBe(false);
  });
});

describe('Sandbox Settings Seed Schema', () => {
  it('should accept valid sandbox settings', () => {
    const result = SandboxSettingsSeedSchema.safeParse({
      devUnsafe: true,
      stdoutLimitBytes: 1048576,
      cpuQuota: 1,
      memoryMb: 1024,
      pidsLimit: 256,
    });
    
    expect(result.success).toBe(true);
  });

  it('should reject non-positive memory', () => {
    const result = SandboxSettingsSeedSchema.safeParse({
      memoryMb: 0,
      devUnsafe: true,
      stdoutLimitBytes: 1048576,
      cpuQuota: 1,
      pidsLimit: 256,
    });
    expect(result.success).toBe(false);
  });
});

describe('Seed File Format Validation', () => {
  it('should match network-settings.seed.json format', () => {
    // This matches the actual seed file format
    const seedData = {
      allowOutbound: true,
      outboundAllowlist: [],
      corsAllowedOrigins: [
        '*.localhost',
        '*.nullsquare.net',
      ],
    };
    
    const result = NetworkSettingsSeedSchema.safeParse(seedData);
    expect(result.success).toBe(true);
  });

  it('should match web-search-settings.seed.json format without storing a secret', () => {
    const seedData = {
      provider: 'tavily',
      duckBaseUrl: 'https://api.duckduckgo.com/',
      duckLiteBaseUrl: 'https://duckduckgo.com/html/',
      tavilyBaseUrl: 'https://api.tavily.com/search',
      maxResults: 5,
      timeoutMs: 15000,
      maxBytes: 1048576,
      tavilyApiKey: null,
    };

    const result = WebSearchSettingsSeedSchema.safeParse(seedData);
    expect(result.success).toBe(true);
  });

  it('should match token-guard-settings.seed.json safety-net defaults', () => {
    const seedPath = path.resolve(process.cwd(), 'config/seeds/settings/token-guard-settings.seed.json');
    const seedData = JSON.parse(readFileSync(seedPath, 'utf8')) as unknown;

    const result = TokenGuardSettingsSeedSchema.safeParse(seedData);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        perSessionLimit: 10_000_000,
        perUserDailyLimit: 0,
        warningThresholdPct: 80,
      });
    }
  });

  it('starts Threat Watch in shadow mode in a clean environment', () => {
    const seedPath = path.resolve(process.cwd(), 'config/seeds/settings/threat-watch-settings.seed.json');
    const seedData = JSON.parse(readFileSync(seedPath, 'utf8')) as unknown;

    const result = ThreatWatchSettingsSeedSchema.safeParse(seedData);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        syncEnabled: true,
        notificationsEnabled: false,
        notificationActivationAt: null,
        notificationEvidenceMaxAgeDays: 14,
        immediateNotifyOnKev: true,
        immediateNotifyMinPriority: 70,
        maxImmediateNotificationsPerDay: 5,
      });
    }
  });

  it('seeds no billing, email, URL, platform or Code Review publication settings', () => {
    const settingsDir = path.resolve(process.cwd(), 'config/seeds/settings');
    const files = readdirSync(settingsDir);
    for (const removed of ['billing-settings.seed.json', 'email-settings.seed.json', 'urls-settings.seed.json', 'platform-settings.seed.json', 'code-review-settings.seed.json']) {
      expect(files).not.toContain(removed);
    }
  });
});






