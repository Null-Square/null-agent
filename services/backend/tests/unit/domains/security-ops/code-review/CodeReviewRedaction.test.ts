import { describe, expect, it } from 'vitest';

import { redactCodeReviewText } from '@/domains/security-ops/code-review/CodeReviewRedaction';

describe('CodeReviewRedaction', () => {
  it('redacts common credentials without flattening source formatting', () => {
    const source = [
      'const apiKey = "super-secret-value";',
      'const auth = "Bearer abcdefghijklmnopqrstuvwxyz";',
      'const github = "ghp_abcdefghijklmnopqrstuvwxyz123456";',
      'return apiKey;',
    ].join('\n');

    const redacted = redactCodeReviewText(source);

    expect(redacted).not.toContain('super-secret-value');
    expect(redacted).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(redacted).toContain('apiKey = "[REDACTED]"');
    expect(redacted.split('\n')).toHaveLength(4);
  });

  it('does not redact comparisons that merely reference a sensitive field name', () => {
    expect(redactCodeReviewText('if (password === submittedPassword) return true;'))
      .toBe('if (password === submittedPassword) return true;');
  });

  it('preserves source line positions when redacting a multiline private key', () => {
    const source = [
      'const before = true;',
      '-----BEGIN PRIVATE KEY-----',
      'sensitive-line-one',
      'sensitive-line-two',
      '-----END PRIVATE KEY-----',
      'executeAfterKey();',
    ].join('\n');

    const redacted = redactCodeReviewText(source);

    expect(redacted).not.toContain('sensitive-line-one');
    expect(redacted.split('\n')).toHaveLength(source.split('\n').length);
    expect(redacted.split('\n')[5]).toBe('executeAfterKey();');
  });
});
