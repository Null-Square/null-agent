import { type TraceArtifactReceipt, type TraceEventPayload } from './types';

const SECRET_KEY_PATTERN = /(_KEY|_TOKEN|_SECRET|AUTH|PASSWORD)$/i;
const BEARER_PATTERN = /(Authorization:\s*Bearer\s+)([A-Za-z0-9_+=/-]{8,})/gi;
const QUERY_SECRET_PATTERN = /([?&](?:key|token|auth|secret)=[^&]+)/gi;

export interface RedactOptions {
  inlineLimit: number;
  compressOverBytes: number;
  createArtifact?: (
    params: { content: Buffer; extension: string; compress?: boolean },
  ) => string | TraceArtifactReceipt;
}

export interface RedactResult {
  payload: TraceEventPayload;
  artifactPath?: string;
  artifactReceipt?: TraceArtifactReceipt;
  truncated?: boolean;
  bytes?: number;
}

function maskSecret(value: string): string {
  if (!value) return value;
  const visible = Math.min(4, value.length);
  const masked = '*'.repeat(Math.max(0, value.length - visible));
  return `${value.slice(0, visible)}${masked}`;
}

function redactStringContent(input: string): string {
  if (!input) return input;
  let output = input.replace(BEARER_PATTERN, (_match, prefix, token) => {
    return `${prefix}${maskSecret(token)}`;
  });
  output = output.replace(QUERY_SECRET_PATTERN, (match) => {
    const [key, value] = match.split('=');
    if (!value) {
      return match;
    }
    const cleanedKey = key ?? '';
    const maskedValue = maskSecret(decodeURIComponent(value));
    return `${cleanedKey}=${encodeURIComponent(maskedValue)}`;
  });
  return output;
}

const toTracePayload = (value: unknown): TraceEventPayload => {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toTracePayload(item));
  }
  if (typeof value === 'object') {
    return value;
  }
  return String(value);
};

function redactValue(key: string, value: TraceEventPayload): TraceEventPayload {
  if (value === null) {
    return value;
  }

  if (typeof value === 'string') {
    if (SECRET_KEY_PATTERN.test(key)) {
      return maskSecret(value);
    }
    return redactStringContent(value);
  }

  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(key, toTracePayload(item)));
    }

    const output: Record<string, TraceEventPayload> = {};
    for (const [innerKey, innerValue] of Object.entries(value)) {
      output[innerKey] = redactValue(innerKey, toTracePayload(innerValue));
    }
    return output;
  }

  return value;
}

export function redactPayload(payload: TraceEventPayload, options: RedactOptions): RedactResult {
  const safePayload = redactValue('', payload);

  let serialized: string;
  try {
    serialized = JSON.stringify(safePayload);
  } catch (error) {
    serialized = JSON.stringify({
      error: 'Could not serialize payload',
      message: (error as Error).message,
    });
  }

  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= options.inlineLimit || !options.createArtifact) {
    return { payload: safePayload, bytes };
  }

  const compress = bytes >= options.compressOverBytes;
  const createdArtifact = options.createArtifact({
    content: Buffer.from(serialized, 'utf8'),
    extension: '.json',
    compress,
  });
  const artifactReceipt = typeof createdArtifact === 'string' ? undefined : createdArtifact;
  const artifactPath = typeof createdArtifact === 'string' ? createdArtifact : createdArtifact.path;

  return {
    payload: {
      artifact: artifactPath,
      truncated: true,
    },
    artifactPath,
    artifactReceipt,
    truncated: true,
    bytes,
  };
}
