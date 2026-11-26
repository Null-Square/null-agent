import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { localSettings } from '@/config/configSchema';

/**
 * The owner key: the one secret that makes a request the person. Null AI has no sign-in, and on this
 * computer anything that can reach the port (another program, a container, the agent's own sandbox)
 * looks like the browser. So the person is whoever holds this key: the browser gets it once from the
 * link printed at start (`/#key=…`), trades it at `POST /api/auth/claim` for an HttpOnly cookie, and
 * scripts may send it as `Authorization: Bearer <key>`.
 *
 * The key lives outside the repository and outside every sandbox mount:
 * `NULL_AI_OWNER_KEY_FILE`, else `${NULL_AI_HOME:-~/.null-ai}/owner-key`.
 */

export const OWNER_COOKIE = 'null_ai_owner';
const SESSION_LABEL = 'null-ai-owner-session-v1';
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const ownerKeyFile = (env: NodeJS.ProcessEnv = process.env): string => {
  const { NULL_AI_OWNER_KEY_FILE: explicit, NULL_AI_HOME: home } = localSettings(env);
  if (explicit) return path.resolve(explicit);
  return path.join(path.resolve(home), 'owner-key');
};

/** Reads the key, or makes one on first start. A file that holds anything else is refused, not replaced. */
export const loadOrCreateOwnerKey = (file: string = ownerKeyFile()): string => {
  let existing: string | null = null;
  try {
    existing = readFileSync(file, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing !== null) {
    if (!KEY_PATTERN.test(existing)) {
      throw new Error(`[owner-key] ${file} does not hold a Null AI owner key. Delete it to make a new one.`);
    }
    return existing;
  }
  const key = randomBytes(32).toString('base64url');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, key + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows keeps its own ACLs; the file sits in the person's home folder.
  }
  return key;
};

/** The cookie value: derived from the key, so the cookie never holds the key itself. */
export const ownerSessionValue = (key: string): string =>
  createHmac('sha256', key).update(SESSION_LABEL).digest('base64url');

const sameSecret = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const isOwnerKey = (provided: unknown, key: string): boolean =>
  typeof provided === 'string' && provided.length > 0 && sameSecret(provided, key);

const readCookie = (header: string | undefined, name: string): string | null => {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
};

/** True only for a request that carries the owner cookie or the key as a bearer token. */
export const carriesOwnerKey = (
  headers: { cookie?: string; authorization?: string },
  key: string,
): boolean => {
  const cookie = readCookie(headers.cookie, OWNER_COOKIE);
  if (cookie && sameSecret(cookie, ownerSessionValue(key))) return true;
  const auth = headers.authorization;
  if (auth?.toLowerCase().startsWith('bearer ')) return isOwnerKey(auth.slice(7).trim(), key);
  return false;
};

export const ownerCookieHeader = (key: string): string =>
  `${OWNER_COOKIE}=${ownerSessionValue(key)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;

/** Where the person opens the app: NULL_AI_APP_URL (no trailing slash), else the Vite dev server. */
export const appUrl = (env: NodeJS.ProcessEnv = process.env): string => localSettings(env).NULL_AI_APP_URL;

export const ownerLink = (key: string, env: NodeJS.ProcessEnv = process.env): string =>
  `${appUrl(env)}/#key=${key}`;
