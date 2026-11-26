import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  carriesOwnerKey,
  loadOrCreateOwnerKey,
  OWNER_COOKIE,
  ownerCookieHeader,
  ownerKeyFile,
  ownerLink,
  ownerSessionValue,
} from '@/shared/auth/ownerKey';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'null-ai-owner-key-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('owner key', () => {
  it('is made once on first start and the same key is read after', () => {
    const file = path.join(tempDir(), 'nested', 'owner-key');
    const first = loadOrCreateOwnerKey(file);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(file, 'utf8').trim()).toBe(first);
    expect(loadOrCreateOwnerKey(file)).toBe(first);
  });

  it('refuses a key file that holds something else instead of replacing it', () => {
    const file = path.join(tempDir(), 'owner-key');
    writeFileSync(file, 'not a key');
    expect(() => loadOrCreateOwnerKey(file)).toThrow(/does not hold a Null AI owner key/);
    expect(readFileSync(file, 'utf8')).toBe('not a key');
  });

  it('lives outside the repository: NULL_AI_OWNER_KEY_FILE, else NULL_AI_HOME, else ~/.null-ai', () => {
    expect(ownerKeyFile({ NULL_AI_OWNER_KEY_FILE: '/secrets/key' })).toBe(path.resolve('/secrets/key'));
    expect(ownerKeyFile({ NULL_AI_HOME: '/data/null-ai' })).toBe(path.join(path.resolve('/data/null-ai'), 'owner-key'));
    expect(ownerKeyFile({})).toMatch(/[\\/]\.null-ai[\\/]owner-key$/);
  });

  it('sets an HttpOnly, SameSite=Strict cookie that never holds the key itself', () => {
    const key = 'a'.repeat(43);
    const header = ownerCookieHeader(key);
    expect(header).toContain(`${OWNER_COOKIE}=${ownerSessionValue(key)}`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).not.toContain(key);
  });

  it('knows the owner only by the cookie or the key as a bearer token', () => {
    const key = 'b'.repeat(43);
    expect(carriesOwnerKey({ cookie: `${OWNER_COOKIE}=${ownerSessionValue(key)}` }, key)).toBe(true);
    expect(carriesOwnerKey({ authorization: `Bearer ${key}` }, key)).toBe(true);
    expect(carriesOwnerKey({}, key)).toBe(false);
    expect(carriesOwnerKey({ cookie: `${OWNER_COOKIE}=${key}` }, key)).toBe(false);
  });

  it('prints a link whose key sits in the fragment, which browsers never send to a server', () => {
    expect(ownerLink('c'.repeat(43), { NULL_AI_APP_URL: 'http://localhost:8080/' })).toBe(`http://localhost:8080/#key=${'c'.repeat(43)}`);
  });
});
