
/**
 * HTTP Session Manager - Manages session state (cookies, auth tokens) per target.
 * 
 * Sessions are keyed by host_port matching deadend-cli's pw_send_payload behavior.
 * Cookie jars are persisted to workspace directories.
 * 
 * @module agent-brain/adapters/tools/runtime/HttpSessionManager
 */

import path from 'path';
import { promises as fs } from 'fs';
import { logger } from '@/shared/logger';

/** Headers that should automatically persist across requests */
const PERSISTED_HEADERS = new Set<string>(['authorization']);
const DEFAULT_SENSITIVE_HEADERS = new Set<string>(['authorization', 'cookie']);

/** Session state for a single target (host:port) */
export interface HttpSession {
  targetKey: string;
  workspaceDir: string;
  cookieJarRelativePath: string;
  cookieJarPath: string;
  cookieJarContainerPath: string;
  persistedHeaders: Record<string, string>;
  sensitiveHeaderNames: string[];
  lastUsedAt: number;
}

/** Parameters for getting a session */
export interface GetSessionParams {
  url: string;
  workspaceDir: string;
}

const normalizeHeaderName = (name: string): string => name.trim().toLowerCase();

const hasHeader = (headers: Record<string, string>, targetLower: string): boolean => {
  return Object.keys(headers).some((key) => normalizeHeaderName(key) === targetLower);
};

const findHeaderValue = (headers: Record<string, string>, targetLower: string): string | undefined => {
  for (const [key, value] of Object.entries(headers)) {
    if (normalizeHeaderName(key) !== targetLower) continue;
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
};

const canonicalHeaderName = (lower: string): string => {
  if (lower === 'authorization') return 'Authorization';
  if (lower === 'cookie') return 'Cookie';
  return lower
    .split('-')
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ''}${segment.slice(1)}`)
    .join('-');
};

const sanitizeKey = (key: string): string => key.replace(/[^a-zA-Z0-9._-]/g, '_');

export class HttpSessionManager {
  // Sessions are keyed by host_port (deadend-cli parity).
  private static sessions = new Map<string, HttpSession>();
  private static pending = new Map<string, Promise<HttpSession>>();
  private static log = logger.child({ scope: 'HttpSessionManager' });

  /**
   * Get or create a session for the given URL.
   * Sessions are cached and reused for the same target.
   */
  static async getSession(params: GetSessionParams): Promise<HttpSession | null> {
    const targetKey = this.getTargetKey(params.url);
    if (!targetKey || !params.workspaceDir) {
      return null;
    }

    const workspaceDir = path.resolve(params.workspaceDir);
    const existing = this.sessions.get(targetKey);
    if (existing) {
      existing.lastUsedAt = Date.now();
      this.logCookieUsage(existing, 'using');
      return existing;
    }

    const pending = this.pending.get(targetKey);
    if (pending) {
      return pending;
    }

    const createPromise = this.createSession({
      targetKey,
      workspaceDir,
    });
    this.pending.set(targetKey, createPromise);

    try {
      const session = await createPromise;
      this.sessions.set(targetKey, session);
      this.logCookieUsage(session, 'using');
      return session;
    } finally {
      this.pending.delete(targetKey);
    }
  }

  /**
   * Apply persistent headers (like Authorization) from session to request headers.
   * Does not overwrite if headers already contains the key.
   */
  static applyPersistentHeaders(
    session: HttpSession,
    headers: Record<string, string>
  ): Record<string, string> {
    const merged = { ...headers };

    for (const [lower, value] of Object.entries(session.persistedHeaders)) {
      if (!value || hasHeader(merged, lower)) {
        continue;
      }
      merged[canonicalHeaderName(lower)] = value;
    }

    return merged;
  }

  static applySecretHeaders(
    session: HttpSession,
    headers: Record<string, string>,
  ): Record<string, string> {
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== 'string' || !value.trim()) {
        continue;
      }
      const normalizedName = normalizeHeaderName(name);
      session.persistedHeaders[normalizedName] = value.trim();
      if (!session.sensitiveHeaderNames.includes(normalizedName)) {
        session.sensitiveHeaderNames.push(normalizedName);
      }
    }

    return this.applyPersistentHeaders(session, {});
  }

  /**
   * Extract and persist headers from outgoing request.
   */
  static updateFromRequest(session: HttpSession, headers: Record<string, string>): void {
    for (const header of PERSISTED_HEADERS) {
      const value = findHeaderValue(headers, header);
      if (value) {
        session.persistedHeaders[header] = value;
        if (!session.sensitiveHeaderNames.includes(header)) {
          session.sensitiveHeaderNames.push(header);
        }
      }
    }
  }

  /**
   * Extract and persist headers from response (e.g. new tokens).
   */
  static updateFromResponse(session: HttpSession, headersRaw: string): void {
    if (!headersRaw) {
      return;
    }

    // Handle multiple response headers (e.g. from redirects)
    const blocks = headersRaw.split(/\r?\n\r?\n/).filter((block) => block.trim().length > 0);
    const lastBlock = blocks.length > 0 ? blocks[blocks.length - 1] : headersRaw;

    const headerMap: Record<string, string> = {};
    for (const line of lastBlock.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const name = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (name && value) {
        headerMap[name] = value;
      }
    }

    for (const header of PERSISTED_HEADERS) {
      const value = headerMap[header];
      if (value) {
        session.persistedHeaders[header] = value;
        if (!session.sensitiveHeaderNames.includes(header)) {
          session.sensitiveHeaderNames.push(header);
        }
      }
    }

    this.logCookieUsage(session, 'saved');
  }

  /** Testing-only helper to avoid state bleed across unit tests. */
  static clearForTests(): void {
    this.sessions.clear();
    this.pending.clear();
  }

  static getSensitiveHeaderNames(session: HttpSession | null | undefined): string[] {
    if (!session) {
      return Array.from(DEFAULT_SENSITIVE_HEADERS);
    }

    return Array.from(new Set([...DEFAULT_SENSITIVE_HEADERS, ...session.sensitiveHeaderNames]));
  }

  /**
   * Extract target key (host_port) from URL.
   */
  private static getTargetKey(url: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    const hostname = parsed.hostname;
    if (!hostname) {
      return null;
    }

    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return `${hostname}_${port}`;
  }

  /**
   * Create a new session with a cookie jar file.
   */
  private static async createSession(params: {
    targetKey: string;
    workspaceDir: string;
  }): Promise<HttpSession> {
    const cookieDir = path.resolve(params.workspaceDir, '.http_sessions');
    const fileName = `${sanitizeKey(params.targetKey)}.cookie`;
    const cookieJarPath = path.join(cookieDir, fileName);

    await fs.mkdir(cookieDir, { recursive: true });
    await fs.writeFile(cookieJarPath, '', { flag: 'a' });

    // Convert to container-relative path
    const relative = path.relative(params.workspaceDir, cookieJarPath);
    const relativePosix = relative.split(path.sep).join('/');
    const cookieJarContainerPath = path.posix.join('/workspace', relativePosix);

    const session: HttpSession = {
      targetKey: params.targetKey,
      workspaceDir: params.workspaceDir,
      cookieJarRelativePath: relativePosix,
      cookieJarPath,
      cookieJarContainerPath,
      persistedHeaders: {},
      sensitiveHeaderNames: Array.from(DEFAULT_SENSITIVE_HEADERS),
      lastUsedAt: Date.now(),
    };

    this.log.debug(
      {
        sessionKey: session.targetKey,
        target: this.formatTargetForLog(session.targetKey),
        cookieJarPath: session.cookieJarPath,
        cookieJarContainerPath: session.cookieJarContainerPath,
      },
      'Initialized HTTP session storage'
    );

    return session;
  }

  private static isDebugEnabled(): boolean {
    const logAny = this.log as unknown as { isLevelEnabled?: (level: string) => boolean; level?: string };
    if (typeof logAny.isLevelEnabled === 'function') {
      return logAny.isLevelEnabled('debug');
    }
    const level = logAny.level;
    return level === 'debug' || level === 'trace';
  }

  private static formatTargetForLog(targetKey: string): string {
    const idx = targetKey.lastIndexOf('_');
    if (idx === -1) {
      return targetKey;
    }
    return `${targetKey.slice(0, idx)}:${targetKey.slice(idx + 1)}`;
  }

  private static countCookies(contents: string): number {
    return contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .filter((line) => line.split('\t').length >= 7).length;
  }

  private static logCookieUsage(session: HttpSession, action: 'using' | 'saved'): void {
    if (!this.isDebugEnabled()) {
      return;
    }

    void fs.readFile(session.cookieJarPath, 'utf8')
      .then((contents) => {
        const cookieCount = this.countCookies(contents);
        const target = this.formatTargetForLog(session.targetKey);
        const message =
          action === 'using'
            ? `Using ${cookieCount} cookies from session ${target}`
            : `Saved ${cookieCount} cookies to session ${target}`;

        this.log.debug(
          {
            cookieCount,
            sessionKey: session.targetKey,
            target,
            cookieJarPath: session.cookieJarPath,
            cookieJarContainerPath: session.cookieJarContainerPath,
          },
          message
        );
      })
      .catch((error) => {
        this.log.debug(
          { err: error, sessionKey: session.targetKey, cookieJarPath: session.cookieJarPath },
          'Failed to read cookie jar for session logging'
        );
      });
  }
}
