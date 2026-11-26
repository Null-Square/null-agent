import { createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKey } from 'crypto';

/**
 * Sign in with ChatGPT, the open-source app path ("ChatGPT plan usage"):
 * https://developers.openai.com/siwc/token-sharing-open-source. OAuth with PKCE and no client
 * secret; the first sign-in registers a client (`dynamic_agent_client`) and the callback returns
 * the issued client id, which every later sign-in, refresh and revocation reuses.
 */
export const CHATGPT_SIGN_IN = {
  scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
  /** Without this granted scope a valid sign-in still may not spend the plan. */
  planScope: 'chatgpt.tokens.use.direct',
  resource: 'https://api.openai.com/v1',
  registrationClientId: 'dynamic_agent_client',
  agentName: 'Null AI',
  /** The redirect must be http://127.0.0.1:<port>/auth/callback exactly; only the port may change. */
  callbackPath: '/auth/callback',
} as const;

export type ChatGptEndpoints = {
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Read from the issuer's openid-configuration (`revocation_endpoint`), as the docs direct. */
  discoveryUrl: string;
  jwksUrl: string;
};

export const CHATGPT_ENDPOINTS: ChatGptEndpoints = {
  issuer: 'https://auth.openai.com',
  authorizeUrl: 'https://auth.openai.com/api/accounts/authorize',
  tokenUrl: 'https://auth.openai.com/api/accounts/oauth/token',
  discoveryUrl: 'https://auth.openai.com/.well-known/openid-configuration',
  jwksUrl: 'https://auth.openai.com/.well-known/jwks.json',
};

/** What is kept for the one ChatGPT registration on this computer, encrypted on its model row. */
export type ChatGptCredentialRecord = {
  /** `ext_agent_host_id`: stable for this computer, kept across sign-outs. */
  hostId: string;
  /** The issued client id (oaiapp_…), never `dynamic_agent_client`. */
  clientId: string;
  subject: string;
  email: string | null;
  /** The last sign-in's ID token, sent as `id_token_hint`; dropped on sign-out. */
  idToken: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  /** When the access token stops working, in epoch milliseconds. */
  expiresAt: number | null;
  scopes: string[];
  savedAt: string;
};

export type ChatGptTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: number;
  scopes: string[];
};

/** An OAuth failure, by its error code only; the provider's description is never surfaced. */
export class ChatGptAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** The refresh token can no longer be used: clear the tokens and sign in again. */
    readonly terminal = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ChatGptAuthError';
  }
}

const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

type Fetch = typeof fetch;
const AUTH_TIMEOUT_MS = 15_000;

const base64url = (value: Buffer): string => value.toString('base64url');

/**
 * The redirect ChatGPT sends the browser back to. The docs ask for an HTTP loopback callback on the
 * literal 127.0.0.1 ("Do not substitute with localhost"), path /auth/callback, where only the port
 * may vary; the app (Vite in dev, nginx in compose) serves that path and hands it to this backend.
 * So: 127.0.0.1 on the port of the app the person opens.
 */
export const loopbackRedirectUri = (appUrl: string): string => {
  const url = new URL(appUrl);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `http://127.0.0.1:${port}${CHATGPT_SIGN_IN.callbackPath}`;
};

export const newHostId = (): string => `urn:uuid:${randomUUID()}`;
export const randomValue = (): string => base64url(randomBytes(32));

export const createPkce = (): { verifier: string; challenge: string } => {
  const verifier = randomValue();
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
};

export const buildAuthorizeUrl = (input: {
  endpoints?: ChatGptEndpoints;
  clientId: string;
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  idTokenHint?: string | null;
  loginHint?: string | null;
  /** Ask again for plan permission after it was declined (`prompt=consent`); never every time. */
  askConsent?: boolean;
}): string => {
  const url = new URL((input.endpoints ?? CHATGPT_ENDPOINTS).authorizeUrl);
  const firstRegistration = input.clientId === CHATGPT_SIGN_IN.registrationClientId;
  const params: Array<[string, string | null | undefined]> = [
    ['client_id', input.clientId],
    ['agent_name_hint', firstRegistration ? CHATGPT_SIGN_IN.agentName : undefined],
    ['ext_agent_host_id', input.hostId],
    ['id_token_hint', firstRegistration ? undefined : input.idTokenHint],
    ['login_hint', input.loginHint],
    ['response_type', 'code'],
    ['redirect_uri', input.redirectUri],
    ['scope', CHATGPT_SIGN_IN.scope],
    ['resource', CHATGPT_SIGN_IN.resource],
    ['state', input.state],
    ['nonce', input.nonce],
    ['code_challenge_method', 'S256'],
    ['code_challenge', input.codeChallenge],
    ['prompt', input.askConsent ? 'consent' : undefined],
  ];
  for (const [name, value] of params) {
    if (value) url.searchParams.set(name, value);
  }
  return url.toString();
};

const postForm = async (
  fetchImpl: Fetch,
  url: string,
  form: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> | null }> => {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch {
    throw new ChatGptAuthError('network_error', 'Could not reach the ChatGPT sign-in service');
  }
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
};

const readTokenSet = (body: Record<string, unknown> | null, now: number): ChatGptTokenSet => {
  const accessToken = typeof body?.access_token === 'string' ? body.access_token : '';
  if (!accessToken) throw new ChatGptAuthError('invalid_token_response', 'The sign-in service returned no access token');
  const expiresIn = typeof body?.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
  return {
    accessToken,
    refreshToken: typeof body?.refresh_token === 'string' ? body.refresh_token : null,
    idToken: typeof body?.id_token === 'string' ? body.id_token : null,
    expiresAt: now + expiresIn * 1000,
    scopes: typeof body?.scope === 'string' ? body.scope.split(/\s+/u).filter(Boolean) : [],
  };
};

const tokenError = (status: number, body: Record<string, unknown> | null, terminalCodes = new Set<string>()) => {
  const code = typeof body?.error === 'string' ? body.error : `http_${status}`;
  return new ChatGptAuthError(code, `The ChatGPT sign-in service refused the request (${code})`, terminalCodes.has(code), status);
};

export const exchangeCode = async (input: {
  endpoints?: ChatGptEndpoints;
  fetch?: Fetch;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  now?: number;
}): Promise<ChatGptTokenSet> => {
  const { status, body } = await postForm(input.fetch ?? fetch, (input.endpoints ?? CHATGPT_ENDPOINTS).tokenUrl, {
    grant_type: 'authorization_code',
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    resource: CHATGPT_SIGN_IN.resource,
  });
  if (status !== 200) throw tokenError(status, body);
  return readTokenSet(body, input.now ?? Date.now());
};

/** Refresh rotates the refresh token: store the whole new set together. Omit scope to keep the grant. */
export const refreshTokens = async (input: {
  endpoints?: ChatGptEndpoints;
  fetch?: Fetch;
  clientId: string;
  refreshToken: string;
  now?: number;
}): Promise<ChatGptTokenSet> => {
  const { status, body } = await postForm(input.fetch ?? fetch, (input.endpoints ?? CHATGPT_ENDPOINTS).tokenUrl, {
    grant_type: 'refresh_token',
    client_id: input.clientId,
    refresh_token: input.refreshToken,
    resource: CHATGPT_SIGN_IN.resource,
  });
  if (status !== 200) throw tokenError(status, body, TERMINAL_REFRESH_ERRORS);
  return readTokenSet(body, input.now ?? Date.now());
};

/** True when the sign-in service confirmed it (an empty 200, also for an already invalid token). */
export const revokeRefreshToken = async (input: {
  endpoints?: ChatGptEndpoints;
  fetch?: Fetch;
  clientId: string;
  refreshToken: string;
}): Promise<boolean> => {
  const fetchImpl = input.fetch ?? fetch;
  const endpoints = input.endpoints ?? CHATGPT_ENDPOINTS;
  try {
    const discovery = await fetchImpl(endpoints.discoveryUrl, { signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) });
    const revocationUrl = ((await discovery.json()) as { revocation_endpoint?: unknown }).revocation_endpoint;
    if (typeof revocationUrl !== 'string') return false;
    const { status } = await postForm(fetchImpl, revocationUrl, {
      token: input.refreshToken,
      token_type_hint: 'refresh_token',
      client_id: input.clientId,
    });
    return status === 200;
  } catch {
    return false;
  }
};

const jwksCache = new Map<string, { keys: JsonWebKey[]; fetchedAt: number }>();
const JWKS_TTL_MS = 60 * 60 * 1000;

const loadJwks = async (fetchImpl: Fetch, url: string, refresh: boolean): Promise<JsonWebKey[]> => {
  const cached = jwksCache.get(url);
  if (cached && !refresh && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) });
  const keys = ((await response.json()) as { keys?: unknown }).keys;
  const list = Array.isArray(keys) ? (keys as JsonWebKey[]) : [];
  jwksCache.set(url, { keys: list, fetchedAt: Date.now() });
  return list;
};

const decodeSegment = (segment: string): Record<string, unknown> => {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new ChatGptAuthError('invalid_id_token', 'The ID token is not readable');
  }
};

/**
 * Validates the ID token the way the docs ask: RS256 signature against the issuer's JWKS, then
 * issuer, audience (the issued client id), expiry and nonce. Returns who signed in.
 */
export const verifyIdToken = async (input: {
  endpoints?: ChatGptEndpoints;
  fetch?: Fetch;
  idToken: string;
  clientId: string;
  nonce: string;
  now?: number;
}): Promise<{ subject: string; email: string | null }> => {
  const endpoints = input.endpoints ?? CHATGPT_ENDPOINTS;
  const fetchImpl = input.fetch ?? fetch;
  const parts = input.idToken.split('.');
  if (parts.length !== 3) throw new ChatGptAuthError('invalid_id_token', 'The ID token is malformed');
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeSegment(headerPart);
  const claims = decodeSegment(payloadPart);
  if (header.alg !== 'RS256') throw new ChatGptAuthError('invalid_id_token', 'The ID token is not signed with RS256');

  const findKey = (keys: JsonWebKey[]) =>
    keys.find((key) => key.kty === 'RSA' && (header.kid === undefined || (key as { kid?: unknown }).kid === header.kid));
  let jwk = findKey(await loadJwks(fetchImpl, endpoints.jwksUrl, false));
  if (!jwk) jwk = findKey(await loadJwks(fetchImpl, endpoints.jwksUrl, true));
  if (!jwk) throw new ChatGptAuthError('invalid_id_token', 'No published key matches the ID token');
  const signed = verify(
    'RSA-SHA256',
    Buffer.from(`${headerPart}.${payloadPart}`),
    createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(signaturePart, 'base64url'),
  );
  if (!signed) throw new ChatGptAuthError('invalid_id_token', 'The ID token signature does not verify');

  const nowSeconds = (input.now ?? Date.now()) / 1000;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== endpoints.issuer) throw new ChatGptAuthError('invalid_id_token', 'The ID token has the wrong issuer');
  if (!audience.includes(input.clientId)) throw new ChatGptAuthError('invalid_id_token', 'The ID token is for another client');
  if (typeof claims.exp !== 'number' || claims.exp + 60 < nowSeconds) {
    throw new ChatGptAuthError('invalid_id_token', 'The ID token has expired');
  }
  if (claims.nonce !== input.nonce) throw new ChatGptAuthError('invalid_id_token', 'The ID token answers another sign-in');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new ChatGptAuthError('invalid_id_token', 'The ID token names no account');
  return { subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : null };
};
