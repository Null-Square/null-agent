import { describe, expect, it } from 'vitest';
import {
  buildTargetVerificationInstructions,
  dnsVerificationHost,
  expectedVerificationValue,
  httpVerificationUrls,
  normalizeChallengeValue,
  normalizeVerificationDomain,
  txtRecordsMatchToken,
  valueMatchesToken,
} from './verification.js';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('verification spec — builders', () => {
  it('builds the canonical DNS host', () => {
    expect(dnsVerificationHost('example.com')).toBe('_nullsquare-verify.example.com');
  });

  it('normalizes protocol/path/port/www before building', () => {
    expect(normalizeVerificationDomain('HTTP://WWW.Example.COM:443/path?q=1#x')).toBe('example.com');
    expect(dnsVerificationHost('https://www.example.com/path')).toBe('_nullsquare-verify.example.com');
  });

  it('builds the expected value with prefix', () => {
    expect(expectedVerificationValue(TOKEN)).toBe(`ns-verify=${TOKEN}`);
  });

  it('builds apex + www https urls', () => {
    expect(httpVerificationUrls('example.com')).toEqual([
      'https://example.com/.well-known/null-ai-verification.txt',
      'https://www.example.com/.well-known/null-ai-verification.txt',
    ]);
  });

  it('produces internally consistent instructions', () => {
    const i = buildTargetVerificationInstructions('www.example.com', TOKEN);
    expect(i.dnsHost).toBe('_nullsquare-verify.example.com');
    expect(i.expectedValue).toBe(`ns-verify=${TOKEN}`);
    expect(i.httpUrl).toBe('https://example.com/.well-known/null-ai-verification.txt');
    expect(i.httpUrls).toHaveLength(2);
  });

  it('handles an empty domain without throwing', () => {
    expect(httpVerificationUrls('')).toEqual([]);
    expect(buildTargetVerificationInstructions('', TOKEN).httpUrl).toBe('');
  });
});

describe('verification spec — value matching', () => {
  it('matches the exact prefixed value', () => {
    expect(valueMatchesToken(`ns-verify=${TOKEN}`, TOKEN)).toBe(true);
  });

  it('matches a bare token (missing prefix — common mistake)', () => {
    expect(valueMatchesToken(TOKEN, TOKEN)).toBe(true);
  });

  it('tolerates whitespace, wrapping quotes, BOM, and spacing around "="', () => {
    expect(valueMatchesToken(`  "ns-verify=${TOKEN}"  `, TOKEN)).toBe(true);
    expect(valueMatchesToken(`﻿ns-verify=${TOKEN}\n`, TOKEN)).toBe(true);
    expect(valueMatchesToken(`ns-verify = ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('rejects wrong / empty values', () => {
    expect(valueMatchesToken('ns-verify=nope', TOKEN)).toBe(false);
    expect(valueMatchesToken('', TOKEN)).toBe(false);
    expect(valueMatchesToken(`ns-verify=${TOKEN}`, '')).toBe(false);
  });

  it('is case-sensitive on the token', () => {
    expect(valueMatchesToken(`ns-verify=${TOKEN.toUpperCase()}`, TOKEN)).toBe(false);
  });

  it('normalizeChallengeValue strips quotes/BOM/whitespace', () => {
    expect(normalizeChallengeValue('  "abc"  ')).toBe('abc');
    expect(normalizeChallengeValue('﻿ abc \n')).toBe('abc');
  });
});

describe('verification spec — TXT record matching', () => {
  it('matches a single-chunk record', () => {
    expect(txtRecordsMatchToken([[`ns-verify=${TOKEN}`]], TOKEN)).toBe(true);
  });

  it('joins multi-string chunks of one record', () => {
    expect(txtRecordsMatchToken([['ns-verify=', TOKEN]], TOKEN)).toBe(true);
  });

  it('finds the record alongside unrelated SPF/DKIM records', () => {
    expect(txtRecordsMatchToken([['v=spf1 -all'], [`ns-verify=${TOKEN}`]], TOKEN)).toBe(true);
  });

  it('returns false when nothing matches', () => {
    expect(txtRecordsMatchToken([['v=spf1 -all'], ['ns-verify=nope']], TOKEN)).toBe(false);
    expect(txtRecordsMatchToken([], TOKEN)).toBe(false);
  });
});
