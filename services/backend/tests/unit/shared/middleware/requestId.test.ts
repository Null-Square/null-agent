import { describe, expect, it } from 'vitest';
import { redactSensitiveRequestPath } from '@/shared/middleware/requestId';

describe('redactSensitiveRequestPath', () => {
  it('redacts Turnstile tokens while preserving useful request context', () => {
    expect(redactSensitiveRequestPath(
      '/api/public/scan-preview/stream?domain=example.com&turnstileToken=secret-token',
    )).toBe(
      '/api/public/scan-preview/stream?domain=example.com&turnstileToken=[redacted]',
    );
  });

  it('redacts the canonical form field and leaves unrelated query values intact', () => {
    expect(redactSensitiveRequestPath(
      '/submit?cf-turnstile-response=secret-token&returnTo=%2Fdashboard',
    )).toBe(
      '/submit?cf-turnstile-response=[redacted]&returnTo=%2Fdashboard',
    );
  });

  it('redacts authentication tokens used by streaming clients', () => {
    expect(redactSensitiveRequestPath(
      '/api/notifications/stream?access_token=live-jwt&cursor=42',
    )).toBe(
      '/api/notifications/stream?access_token=[redacted]&cursor=42',
    );
  });
});
