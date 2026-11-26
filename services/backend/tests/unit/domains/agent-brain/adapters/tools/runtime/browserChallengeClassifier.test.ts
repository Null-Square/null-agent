import { describe, expect, it } from 'vitest';
import { classifyBrowserChallenge } from '@/domains/agent-brain/adapters/tools/runtime/browserChallengeClassifier';

describe('classifyBrowserChallenge', () => {
  it('classifies Cloudflare challenge markers', () => {
    const result = classifyBrowserChallenge({
      url: 'https://example.com/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1',
      title: 'Just a moment...',
      text: 'Checking your browser before accessing example.com',
      network: [],
    });

    expect(result).toEqual(expect.objectContaining({
      kind: 'cloudflare_challenge',
      confidence: 'high',
      retryable: false,
    }));
  });

  it('classifies blocked auth POSTs from browser network events', () => {
    const result = classifyBrowserChallenge({
      url: 'https://example.com/login',
      title: 'Login',
      text: 'Welcome',
      network: [
        {
          id: 'browser-1',
          ts: '2026-06-15T00:00:00.000Z',
          method: 'POST',
          url: 'https://example.com/login',
          resourceType: 'document',
          initiatorType: 'navigation',
          requestHeaders: {},
          status: 403,
          responseHeaders: {},
        },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      kind: 'auth_post_blocked',
      confidence: 'medium',
      blocking_stage: 'form_submit',
      retryable: false,
    }));
  });

  it('returns null for normal rendered pages', () => {
    expect(classifyBrowserChallenge({
      url: 'https://example.com/app',
      title: 'Dashboard',
      text: 'Project overview',
      network: [],
    })).toBeNull();
  });
});
