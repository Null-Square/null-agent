import {
  constants,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  randomUUID,
} from 'crypto';

export type InteractshClientConfig = {
  serverUrl: string;
  authToken?: string;
  callbackDomain?: string;
  callbackScheme?: 'http' | 'https';
};

export type InteractshTokenRegistration = {
  token: string;
  correlationId: string;
  secretKey: string;
  privateKeyPem: string;
  hostname: string;
  url: string;
  dns: string;
};

export type InteractshPollSession = {
  correlationId: string;
  secretKey: string;
  privateKeyPem: string;
};

export type InteractshInteraction = {
  ts?: string;
  protocol?: string;
  sourceIp?: string;
  hostname?: string;
  method?: string;
  path?: string;
  payload?: Record<string, unknown>;
  raw?: unknown;
};

const CORRELATION_ID_LENGTH = 20;
const NONCE_LENGTH = 13;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const randomDnsLabel = (length: number): string => {
  let value = '';
  while (value.length < length) {
    value += randomBytes(length).toString('hex');
  }
  return value.slice(0, length).toLowerCase();
};

const parseRequestLine = (raw: unknown): { method?: string; path?: string } => {
  if (typeof raw !== 'string') return {};
  const firstLine = raw.split(/\r?\n/u)[0] ?? '';
  const match = /^(?<method>[A-Z]+)\s+(?<path>\S+)/u.exec(firstLine);
  return {
    method: match?.groups?.method,
    path: match?.groups?.path,
  };
};

const coerceInteractions = (body: unknown): InteractshInteraction[] => {
  const candidates = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.interactions)
      ? body.interactions
      : isRecord(body) && Array.isArray(body.data)
        ? body.data
        : [];

  return candidates
    .filter(isRecord)
    .map((entry) => {
      const raw = entry.raw ?? entry.request ?? entry['raw-request'] ?? entry.data;
      const requestLine = parseRequestLine(raw);
      return {
        ts: asString(entry.timestamp) ?? asString(entry.ts) ?? asString(entry.time) ?? asString(entry.created_at),
        protocol: asString(entry.protocol) ?? asString(entry.type) ?? asString(entry.interaction_protocol),
        sourceIp:
          asString(entry.source_ip) ??
          asString(entry['remote-address']) ??
          asString(entry.remote_address) ??
          asString(entry.remoteAddress) ??
          asString(entry.ip),
        hostname:
          asString(entry.hostname) ??
          asString(entry.host) ??
          asString(entry.full_id) ??
          asString(entry['full-id']),
        method: asString(entry.method) ?? asString(entry.http_method) ?? requestLine.method,
        path: asString(entry.path) ?? asString(entry.uri) ?? requestLine.path,
        payload: entry,
        raw,
      };
    });
};

const decodePollData = (data: unknown): unknown[] => {
  if (!Array.isArray(data)) return [];
  return data.map((item) => {
    if (typeof item !== 'string') return item;
    try {
      return JSON.parse(item) as unknown;
    } catch {
      return { raw: item };
    }
  });
};

export class InteractshClient {
  private readonly baseUrl: URL;

  constructor(private readonly config: InteractshClientConfig) {
    this.baseUrl = new URL(config.serverUrl);
  }

  get callbackDomain(): string {
    return this.config.callbackDomain ?? this.baseUrl.hostname;
  }

  get callbackScheme(): 'http' | 'https' {
    return this.config.callbackScheme ?? (this.baseUrl.protocol === 'http:' ? 'http' : 'https');
  }

  async registerToken(): Promise<InteractshTokenRegistration> {
    const correlationId = randomDnsLabel(CORRELATION_ID_LENGTH);
    const nonce = randomDnsLabel(NONCE_LENGTH);
    const token = `${correlationId}${nonce}`;
    const secretKey = randomUUID();
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });

    const url = new URL('/register', this.baseUrl);
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json', accept: 'application/json' }),
      body: JSON.stringify({
        'public-key': Buffer.from(publicKey).toString('base64'),
        'secret-key': secretKey,
        'correlation-id': correlationId,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`interactsh register failed: HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }

    const hostname = `${token}.${this.callbackDomain}`;
    return {
      token,
      correlationId,
      secretKey,
      privateKeyPem: privateKey,
      hostname,
      url: `${this.callbackScheme}://${hostname}/`,
      dns: hostname,
    };
  }

  async pollToken(session: InteractshPollSession): Promise<InteractshInteraction[]> {
    const url = new URL('/poll', this.baseUrl);
    url.searchParams.set('id', session.correlationId);
    url.searchParams.set('secret', session.secretKey);

    const response = await fetch(url, { headers: this.headers({ accept: 'application/json' }) });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`interactsh poll failed: HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }

    const body = await response.json() as unknown;
    if (!isRecord(body)) return [];

    const decrypted = this.decryptData(session.privateKeyPem, body.aes_key, body.data);
    const extra = decodePollData(body.extra);
    const tldData = decodePollData(body.tlddata);
    return coerceInteractions([...decrypted, ...extra, ...tldData]);
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    const headers = { ...extra };
    if (this.config.authToken) {
      headers.authorization = this.config.authToken;
    }
    return headers;
  }

  private decryptData(privateKeyPem: string, encryptedKey: unknown, encryptedItems: unknown): unknown[] {
    if (typeof encryptedKey !== 'string' || !Array.isArray(encryptedItems) || encryptedItems.length === 0) {
      return [];
    }

    const key = privateDecrypt(
      {
        key: privateKeyPem,
        oaepHash: 'sha256',
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(encryptedKey, 'base64'),
    );

    return encryptedItems.map((item) => {
      if (typeof item !== 'string') return item;
      const cipherText = Buffer.from(item, 'base64');
      const iv = cipherText.subarray(0, 16);
      const payload = cipherText.subarray(16);
      const decipher = createDecipheriv('aes-256-ctr', key, iv);
      const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8').trim();
      try {
        return JSON.parse(plaintext) as unknown;
      } catch {
        return { raw: plaintext };
      }
    });
  }
}
