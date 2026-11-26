import type { ModelRow } from '@/db/schema';
import { ModelRepository } from './ModelRepository';
import { decryptModelApiKey, encryptModelApiKey } from './modelApiKeyCipher';
import { CHATGPT_PROVIDER } from './modelProviders';
import {
  ChatGptAuthError,
  refreshTokens,
  revokeRefreshToken,
  type ChatGptCredentialRecord,
  type ChatGptEndpoints,
} from './chatGptAuth';

type Fetch = typeof fetch;

/** Refresh this long before the access token runs out, so a request never leaves with a dead one. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export const encryptCredentialRecord = (record: ChatGptCredentialRecord): string =>
  encryptModelApiKey(JSON.stringify(record)) as string;

export const readCredentialRecord = (stored: string | null | undefined): ChatGptCredentialRecord | null => {
  try {
    const plaintext = decryptModelApiKey(stored);
    if (!plaintext) return null;
    const record = JSON.parse(plaintext) as Partial<ChatGptCredentialRecord>;
    if (typeof record.hostId !== 'string' || typeof record.clientId !== 'string') return null;
    return {
      hostId: record.hostId,
      clientId: record.clientId,
      subject: typeof record.subject === 'string' ? record.subject : '',
      email: typeof record.email === 'string' ? record.email : null,
      idToken: typeof record.idToken === 'string' ? record.idToken : null,
      accessToken: typeof record.accessToken === 'string' ? record.accessToken : null,
      refreshToken: typeof record.refreshToken === 'string' ? record.refreshToken : null,
      expiresAt: typeof record.expiresAt === 'number' ? record.expiresAt : null,
      scopes: Array.isArray(record.scopes) ? record.scopes.filter((scope): scope is string => typeof scope === 'string') : [],
      savedAt: typeof record.savedAt === 'string' ? record.savedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
};

/** Signing out drops the tokens and keeps the registration: the host id, client id and account. */
export const signedOutRecord = (record: ChatGptCredentialRecord): ChatGptCredentialRecord => ({
  ...record,
  idToken: null,
  accessToken: null,
  refreshToken: null,
  expiresAt: null,
  scopes: [],
  savedAt: new Date().toISOString(),
});

export const hasPlanTokens = (record: ChatGptCredentialRecord | null): boolean =>
  Boolean(record?.accessToken && record.refreshToken);

/**
 * The one ChatGPT sign-in on this computer. It lives encrypted on the CHATGPT model row (the
 * models table is the only model store); this class reads it, keeps its access token fresh and
 * signs it out.
 */
export class ChatGptCredentials {
  private readonly repo: ModelRepository;

  constructor(
    private readonly deps: {
      repo?: ModelRepository;
      endpoints?: ChatGptEndpoints;
      fetch?: Fetch;
      now?: () => number;
    } = {},
  ) {
    this.repo = deps.repo ?? new ModelRepository();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async load(): Promise<{ row: ModelRow; record: ChatGptCredentialRecord } | null> {
    const row = await this.repo.getByProvider(CHATGPT_PROVIDER);
    const record = readCredentialRecord(row?.apiKey);
    return row && record ? { row, record } : null;
  }

  /**
   * A working access token for the plan. Near expiry it is refreshed once, under the row's lock, so
   * two callers never race the rotating refresh token; the whole new set is stored together. A
   * refresh token that can no longer be used ends the sign-in and the connection.
   */
  async accessToken(): Promise<string> {
    const loaded = await this.load();
    const notSignedIn = () =>
      new ChatGptAuthError('not_signed_in', 'ChatGPT is not signed in; connect it in Settings → Model', true);
    if (!loaded || !hasPlanTokens(loaded.record)) throw notSignedIn();
    if (this.isFresh(loaded.record)) return loaded.record.accessToken as string;

    const outcome = await this.repo.transaction(async (repository) => {
      const row = await repository.getByIdForUpdate(loaded.row.id);
      const record = readCredentialRecord(row?.apiKey);
      if (!row || !record || !hasPlanTokens(record)) return { error: notSignedIn() };
      if (this.isFresh(record)) return { token: record.accessToken as string };
      try {
        const tokens = await refreshTokens({
          endpoints: this.deps.endpoints,
          fetch: this.deps.fetch,
          clientId: record.clientId,
          refreshToken: record.refreshToken as string,
          now: this.now(),
        });
        await repository.update(row.id, {
          apiKey: encryptCredentialRecord({
            ...record,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? record.refreshToken,
            idToken: tokens.idToken ?? record.idToken,
            expiresAt: tokens.expiresAt,
            scopes: tokens.scopes.length > 0 ? tokens.scopes : record.scopes,
            savedAt: new Date(this.now()).toISOString(),
          }),
        });
        return { token: tokens.accessToken };
      } catch (error) {
        if (error instanceof ChatGptAuthError && error.terminal) {
          // OpenAI never says when the person disconnected the app; a dead refresh token is how we learn.
          await repository.update(row.id, {
            apiKey: encryptCredentialRecord(signedOutRecord(record)),
            isActive: false,
            isDefault: false,
          });
        }
        // Returned, not thrown, so the sign-out above commits; a network failure keeps the tokens.
        return { error: error as Error };
      }
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.token;
  }

  /** Revokes the refresh token, then forgets the tokens either way. Returns whether OpenAI confirmed it. */
  async signOut(row: ModelRow, record: ChatGptCredentialRecord): Promise<{ revoked: boolean; record: ChatGptCredentialRecord }> {
    const revoked = record.refreshToken
      ? await revokeRefreshToken({
          endpoints: this.deps.endpoints,
          fetch: this.deps.fetch,
          clientId: record.clientId,
          refreshToken: record.refreshToken,
        })
      : true;
    const next = signedOutRecord(record);
    await this.repo.update(row.id, { apiKey: encryptCredentialRecord(next) });
    return { revoked, record: next };
  }

  private isFresh(record: ChatGptCredentialRecord): boolean {
    return Boolean(record.accessToken && record.expiresAt && record.expiresAt - REFRESH_MARGIN_MS > this.now());
  }
}
