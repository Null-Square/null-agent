import {
  buildAuthorizeUrl,
  CHATGPT_SIGN_IN,
  ChatGptAuthError,
  createPkce,
  exchangeCode,
  loopbackRedirectUri,
  newHostId,
  randomValue,
  verifyIdToken,
  type ChatGptCredentialRecord,
  type ChatGptEndpoints,
} from '@/domains/platform/models/chatGptAuth';
import { listChatGptPlanModels, type CatalogModel } from '@/domains/platform/models/modelCatalog';
import type { ModelConnection, ModelService } from '@/domains/platform/models/ModelService';
import { logger } from '@/shared/logger';

export { loopbackRedirectUri };

type Fetch = typeof fetch;

/** An attempt waits this long for its callback; state, nonce and PKCE verifier live only in memory. */
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 20;

type PendingSignIn = {
  state: string;
  nonce: string;
  codeVerifier: string;
  hostId: string;
  clientId: string;
  redirectUri: string;
  returnTo: string | null;
  createdAt: number;
};

export type ChatGptSignInOutcome = {
  returnTo: string | null;
  /** connected: the plan is the model now. no_plan: signed in, but plan usage was not allowed.
   * no_models: signed in, but the plan's models could not be listed yet. */
  outcome: 'connected' | 'no_plan' | 'no_models';
  connection: ModelConnection | null;
};

/** A sign-in that cannot finish, by a stable reason and a plain message. */
export class ChatGptSignInError extends Error {
  constructor(
    readonly reason: 'expired' | 'denied' | 'incomplete' | 'refused' | 'other_account' | 'invalid',
    message: string,
    readonly returnTo: string | null = null,
  ) {
    super(message);
    this.name = 'ChatGptSignInError';
  }
}

/**
 * Sign in with ChatGPT for this computer, the documented open-source path: a loopback redirect
 * (http://127.0.0.1:<the app's port>/auth/callback, which the app proxies to this backend), PKCE S256, a fresh state and
 * nonce per attempt, the issued client id and this host's id reused on every later sign-in.
 */
export class ChatGptSignIn {
  private readonly pending = new Map<string, PendingSignIn>();

  constructor(
    private readonly deps: {
      models: Pick<ModelService, 'chatGptRegistration' | 'saveChatGptSignIn'>;
      endpoints?: ChatGptEndpoints;
      fetch?: Fetch;
      /** Where the plan's model list is read; OpenAI's public API unless a test stubs it. */
      apiBaseUrl?: string;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async start(input: { redirectUri: string; returnTo: string | null }): Promise<{ url: string }> {
    this.prune();
    const registration = await this.deps.models.chatGptRegistration();
    const { verifier, challenge } = createPkce();
    const attempt: PendingSignIn = {
      state: randomValue(),
      nonce: randomValue(),
      codeVerifier: verifier,
      hostId: registration?.hostId ?? newHostId(),
      clientId: registration?.clientId ?? CHATGPT_SIGN_IN.registrationClientId,
      redirectUri: input.redirectUri,
      returnTo: input.returnTo,
      createdAt: this.now(),
    };
    this.pending.set(attempt.state, attempt);
    const planDeclined =
      Boolean(registration?.scopes.length) && !registration?.scopes.includes(CHATGPT_SIGN_IN.planScope);
    const url = buildAuthorizeUrl({
      endpoints: this.deps.endpoints,
      clientId: attempt.clientId,
      hostId: attempt.hostId,
      redirectUri: attempt.redirectUri,
      state: attempt.state,
      nonce: attempt.nonce,
      codeChallenge: challenge,
      idTokenHint: registration?.idToken,
      loginHint: registration?.email,
      askConsent: planDeclined,
    });
    // The URL may carry id_token_hint, so it is never logged.
    logger.info({ firstRegistration: !registration }, '[ChatGptSignIn] Sign-in started');
    return { url };
  }

  async complete(query: Record<string, unknown>): Promise<ChatGptSignInOutcome> {
    const read = (name: string): string | undefined =>
      typeof query[name] === 'string' && (query[name] as string) ? (query[name] as string) : undefined;
    const attempt = this.takePending(read('state'));
    if (!attempt) {
      throw new ChatGptSignInError('expired', 'This sign-in expired or was already used. Start it again.');
    }
    const fail = (reason: ChatGptSignInError['reason'], message: string) =>
      new ChatGptSignInError(reason, message, attempt.returnTo);

    const oauthError = read('error');
    if (oauthError === 'access_denied') throw fail('denied', 'Sign-in with ChatGPT was cancelled.');
    if (oauthError) throw fail('refused', `ChatGPT did not complete the sign-in (${oauthError}).`);

    const firstRegistration = attempt.clientId === CHATGPT_SIGN_IN.registrationClientId;
    const issued = read('client_id');
    if (firstRegistration && !issued) {
      throw fail('incomplete', 'ChatGPT did not finish registering Null AI. Start the sign-in again.');
    }
    if (!firstRegistration && issued && issued !== attempt.clientId) {
      throw fail('invalid', 'The sign-in answered for another registration. Start it again.');
    }
    const clientId = issued ?? attempt.clientId;
    const code = read('code');
    if (!code) throw fail('incomplete', 'ChatGPT returned no sign-in code. Start the sign-in again.');

    let record: ChatGptCredentialRecord;
    try {
      const tokens = await exchangeCode({
        endpoints: this.deps.endpoints,
        fetch: this.deps.fetch,
        clientId,
        code,
        codeVerifier: attempt.codeVerifier,
        redirectUri: attempt.redirectUri,
        now: this.now(),
      });
      if (!tokens.idToken) throw new ChatGptAuthError('invalid_token_response', 'No ID token');
      const identity = await verifyIdToken({
        endpoints: this.deps.endpoints,
        fetch: this.deps.fetch,
        idToken: tokens.idToken,
        clientId,
        nonce: attempt.nonce,
        now: this.now(),
      });
      const registration = await this.deps.models.chatGptRegistration();
      if (registration?.clientId === clientId && registration.subject && registration.subject !== identity.subject) {
        throw fail('other_account', 'That is a different ChatGPT account from the one this registration belongs to.');
      }
      const scopes = tokens.scopes.length > 0 ? tokens.scopes : (read('scope') ?? '').split(/[\s+]+/u).filter(Boolean);
      record = {
        hostId: attempt.hostId,
        clientId,
        subject: identity.subject,
        email: identity.email,
        idToken: tokens.idToken,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes,
        savedAt: new Date(this.now()).toISOString(),
      };
    } catch (error) {
      if (error instanceof ChatGptSignInError) throw error;
      const code = error instanceof ChatGptAuthError ? error.code : 'unexpected';
      logger.warn({ code }, '[ChatGptSignIn] Sign-in could not be completed');
      throw fail('refused', `ChatGPT sign-in could not be completed (${code}). Start it again.`);
    }

    if (!record.scopes.includes(CHATGPT_SIGN_IN.planScope)) {
      // A valid sign-in without plan permission: keep the registration, spend nothing.
      await this.deps.models.saveChatGptSignIn({ ...record, accessToken: null, refreshToken: null, expiresAt: null }, []);
      return { returnTo: attempt.returnTo, outcome: 'no_plan', connection: null };
    }

    let catalog: CatalogModel[] = [];
    try {
      catalog = await listChatGptPlanModels(record.accessToken as string, {
        fetch: this.deps.fetch,
        baseUrl: this.deps.apiBaseUrl,
      });
    } catch (error) {
      logger.warn({ err: error }, '[ChatGptSignIn] Signed in, but the plan models could not be listed');
    }
    const connection = await this.deps.models.saveChatGptSignIn(record, catalog);
    logger.info({ connected: Boolean(connection), models: catalog.length }, '[ChatGptSignIn] Sign-in completed');
    return { returnTo: attempt.returnTo, outcome: connection ? 'connected' : 'no_models', connection };
  }

  private takePending(state: string | undefined): PendingSignIn | undefined {
    if (!state) return undefined;
    const attempt = this.pending.get(state);
    this.pending.delete(state);
    return attempt && this.now() - attempt.createdAt <= PENDING_TTL_MS ? attempt : undefined;
  }

  private prune(): void {
    for (const [state, attempt] of this.pending) {
      if (this.now() - attempt.createdAt > PENDING_TTL_MS) this.pending.delete(state);
    }
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value as string;
      this.pending.delete(oldest);
    }
  }
}
