import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { SignedUrlService } from '@/shared/security/SignedUrlService';

describe('SignedUrlService', () => {
  const secret = 'test-secret';
  const service = new SignedUrlService(secret, 50); // 50ms default TTL for quick expiry tests

  afterEach(() => {
    vi.useRealTimers();
  });

  it('verifies a valid token for the exact path', () => {
    const path = '/api/resource/123';
    const token = service.sign(path);

    expect(service.verify(path, token)).toBe(true);
  });

  it('rejects a token when the path does not match', () => {
    const token = service.sign('/expected/path');

    expect(service.verify('/other/path', token)).toBe(false);
  });

  it('rejects tampered tokens', () => {
    const token = service.sign('/secure/path');
    // Flip the last character to simulate tampering
    const tampered = token.slice(0, -1) + (token.slice(-1) === 'a' ? 'b' : 'a');

    expect(service.verify('/secure/path', tampered)).toBe(false);
  });

  it('rejects expired tokens', () => {
    vi.useFakeTimers();
    const token = service.sign('/expiring', 10);

    vi.advanceTimersByTime(15);

    expect(service.verify('/expiring', token)).toBe(false);
  });
});







