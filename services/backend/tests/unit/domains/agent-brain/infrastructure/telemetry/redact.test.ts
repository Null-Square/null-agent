import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { redactPayload } from '@/domains/agent-brain/infrastructure/telemetry';

describe('redactPayload', () => {
  it('masks secrets in headers, query params, and secret-suffixed keys', () => {
    const payload = {
      API_KEY: 'supersecret',
      nested: {
        Authorization: 'Authorization: Bearer abcdefghijklmno',
        url: 'https://example.com?token=abc123&safe=yes',
      },
      arr: [{ access_token: 'topsecret' }],
    };

    const result = redactPayload(payload, {
      inlineLimit: 10_000,
      compressOverBytes: 50_000,
    });

    expect(result.artifactPath).toBeUndefined();

    const maskedKey = (result.payload as any).API_KEY;
    expect(maskedKey).toMatch(/^supe\*+/);
    expect(maskedKey.length).toBe(payload.API_KEY.length);

    const maskedAuth = (result.payload as any).nested.Authorization;
    expect(maskedAuth).toContain('Authorization: Bearer ');
    expect(maskedAuth).toMatch(/Bearer\s+[a-z]{4}\*+/i);

    const maskedUrl = (result.payload as any).nested.url;
    expect(maskedUrl).toContain('token=abc1**');
    expect(maskedUrl).toContain('&safe=yes');

    const maskedArrayToken = (result.payload as any).arr[0].access_token;
    expect(maskedArrayToken).toMatch(/^tops\*+/);
  });

  it('spills to artifact when payload exceeds inline limit and marks truncated', () => {
    const largeValue = 'x'.repeat(6000);
    const createArtifact = vi.fn().mockReturnValue('artifacts/trace.json.gz');

    const result = redactPayload(
      { large: largeValue },
      {
        inlineLimit: 1024,
        compressOverBytes: 2048,
        createArtifact,
      },
    );

    expect(createArtifact).toHaveBeenCalledTimes(1);
    const callArgs = createArtifact.mock.calls[0][0];
    expect(callArgs.extension).toBe('.json');
    expect(callArgs.compress).toBe(true);
    expect(result.artifactPath).toBe('artifacts/trace.json.gz');
    expect(result.payload).toEqual({ artifact: 'artifacts/trace.json.gz', truncated: true });
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeGreaterThan(1024);
  });
});







