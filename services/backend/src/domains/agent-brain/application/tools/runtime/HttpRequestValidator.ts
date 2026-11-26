/**
 * HTTP Request Validator - Normalize and auto-correct HTTP requests.
 *
 * Handles:
 * - Raw HTTP requests (method path version + headers + body)
 * - Structured requests (url, method, headers, body)
 * - Auto-fixes common issues (line endings, missing headers, Content-Length)
 *
 * @module agent-brain/application/tools/runtime/HttpRequestValidator
 */

const VALID_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
  'TRACE',
  'CONNECT',
]);

/** Header entry with original casing preserved */
interface HeaderEntry {
  name: string;
  value: string;
}

/** Fixed request line with corrections */
interface FixedRequestLine {
  line: string;
  method: string;
  path: string;
  version: string;
  corrections: string[];
}

/** Normalized header line */
interface NormalizedHeader {
  line: string;
  name: string;
  value: string;
  fixed: boolean;
}

/** Input for normalization */
export interface NormalizeInput {
  targetUrl: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  rawRequest?: string;
}

/** Normalized output */
export interface NormalizedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  requestLine?: string;
  correctedRequest?: string;
  corrections: string[];
}

const normalizeLineEndings = (raw: string): { normalized: string; changed: boolean } => {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
  return { normalized, changed: normalized !== raw };
};

const toHeaderRecord = (headers: Map<string, HeaderEntry>): Record<string, string> => {
  const record: Record<string, string> = {};
  for (const entry of headers.values()) {
    record[entry.name] = entry.value;
  }
  return record;
};

const setHeader = (headers: Map<string, HeaderEntry>, name: string, value: string): void => {
  headers.set(name.toLowerCase(), { name, value });
};

const getHeader = (headers: Map<string, HeaderEntry>, name: string): HeaderEntry | undefined =>
  headers.get(name.toLowerCase());

const findHeaderKey = (headers: Record<string, string>, headerName: string): string | null => {
  const lower = headerName.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      return key;
    }
  }
  return null;
};

const deriveHostHeader = (targetUrl: string, path: string): string | null => {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    try {
      return new URL(path).host;
    } catch {
      return null;
    }
  }
  try {
    return new URL(targetUrl).host;
  } catch {
    return null;
  }
};

const resolveUrl = (targetUrl: string, path: string): string => {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  try {
    const base = new URL(targetUrl);
    const [pathname, query = ''] = path.split('?', 2);
    const sanitizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
    base.pathname = sanitizedPath;
    base.search = query ? `?${query}` : '';
    return base.toString();
  } catch {
    return targetUrl;
  }
};

const fixRequestLine = (requestLine: string): FixedRequestLine => {
  const corrections: string[] = [];
  const trimmed = requestLine.trim();
  const parts = trimmed ? trimmed.split(/\s+/) : [];

  if (parts.length === 0) {
    corrections.push('Added default request line: GET / HTTP/1.1');
    return {
      line: 'GET / HTTP/1.1',
      method: 'GET',
      path: '/',
      version: 'HTTP/1.1',
      corrections,
    };
  }

  let method = parts[0];
  let path = '/';
  let version = 'HTTP/1.1';

  // Uppercase method
  if (method !== method.toUpperCase()) {
    corrections.push(`Uppercased method: ${method} -> ${method.toUpperCase()}`);
    method = method.toUpperCase();
  }

  // Handle invalid/missing method
  if (!VALID_METHODS.has(method)) {
    const firstPart = parts[0];
    if (firstPart.startsWith('/') || firstPart.startsWith('http://') || firstPart.startsWith('https://')) {
      corrections.push(`Added missing method: GET (path was: ${firstPart})`);
      path = firstPart;
      method = 'GET';
      if (parts.length > 1 && parts[1].startsWith('HTTP/')) {
        version = parts[1];
      }
    }
  }

  if (parts.length >= 2) {
    if (parts[1].startsWith('HTTP/')) {
      corrections.push('Added missing path: /');
      version = parts[1];
    } else {
      path = parts[1];
    }
  }

  if (parts.length >= 3) {
    if (parts[2].startsWith('HTTP/')) {
      version = parts[2];
    } else {
      corrections.push(`Fixed HTTP version: ${parts[2]} -> HTTP/1.1`);
      version = 'HTTP/1.1';
    }
  } else if (parts.length < 3) {
    corrections.push('Added missing HTTP version: HTTP/1.1');
  }

  if (!/^HTTP\/\d\.\d$/.test(version)) {
    corrections.push(`Fixed invalid HTTP version: ${version} -> HTTP/1.1`);
    version = 'HTTP/1.1';
  }

  if (path === '*') {
    corrections.push('Fixed asterisk path to /');
    path = '/';
  }

  if (!path.startsWith('/') && !path.startsWith('http://') && !path.startsWith('https://')) {
    corrections.push(`Fixed path: ${path} -> /${path}`);
    path = `/${path}`;
  }

  return {
    line: `${method} ${path} ${version}`,
    method,
    path,
    version,
    corrections,
  };
};

const normalizeHeaderLine = (headerLine: string): NormalizedHeader | null => {
  if (!headerLine.includes(':')) {
    return null;
  }

  const [rawKey, ...rest] = headerLine.split(':');
  const rawValue = rest.join(':');
  const key = rawKey.trim();
  const value = rawValue.trim();
  const fixed = key !== rawKey || value !== rawValue.trimStart();

  return {
    line: `${key}: ${value}`,
    name: key,
    value,
    fixed,
  };
};

const ensureContentLength = (
  headers: Record<string, string>,
  body: string | undefined,
  corrections: string[]
): Record<string, string> => {
  const nextHeaders = { ...headers };
  const bodyLength = Buffer.byteLength(body ?? '', 'utf8');

  const contentLengthKey = findHeaderKey(nextHeaders, 'content-length');
  if (contentLengthKey) {
    const parsed = Number.parseInt(nextHeaders[contentLengthKey] ?? '', 10);
    if (!Number.isFinite(parsed) || parsed !== bodyLength) {
      corrections.push(`Corrected Content-Length: ${nextHeaders[contentLengthKey]} -> ${bodyLength}`);
      nextHeaders[contentLengthKey] = String(bodyLength);
    }
  } else if (bodyLength > 0) {
    corrections.push(`Added Content-Length: ${bodyLength}`);
    nextHeaders['Content-Length'] = String(bodyLength);
  }

  return nextHeaders;
};

export class HttpRequestValidator {
  /**
   * Normalize an HTTP request, handling both raw and structured inputs.
   */
  static normalize(input: NormalizeInput): NormalizedRequest {
    const rawRequest = typeof input.rawRequest === 'string' ? input.rawRequest : '';

    if (rawRequest.trim()) {
      return this.normalizeRawRequest(rawRequest, input.targetUrl);
    }

    return this.normalizeStructuredRequest(input);
  }

  /**
   * Ensure Content-Length header matches body.
   */
  static ensureContentLength(
    headers: Record<string, string>,
    body: string | undefined,
    corrections: string[] = []
  ): { headers: Record<string, string>; corrections: string[] } {
    return {
      headers: ensureContentLength(headers, body, corrections),
      corrections,
    };
  }

  /**
   * Normalize a structured request (url, method, headers, body).
   */
  private static normalizeStructuredRequest(input: NormalizeInput): NormalizedRequest {
    const corrections: string[] = [];

    const method = input.method.toUpperCase();
    if (input.method !== method) {
      corrections.push(`Uppercased method: ${input.method} -> ${method}`);
    }

    const normalizedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.headers)) {
      const trimmedKey = key.trim();
      const trimmedValue = value.trim();
      if (!trimmedKey) {
        continue;
      }
      if (trimmedKey !== key || trimmedValue !== value) {
        corrections.push(`Normalized header: ${key} -> ${trimmedKey}`);
      }
      normalizedHeaders[trimmedKey] = trimmedValue;
    }

    const finalHeaders = ensureContentLength(normalizedHeaders, input.body, corrections);

    return {
      url: input.targetUrl,
      method,
      headers: finalHeaders,
      body: input.body,
      corrections,
    };
  }

  /**
   * Parse and normalize a raw HTTP request string.
   */
  private static normalizeRawRequest(rawRequest: string, targetUrl: string): NormalizedRequest {
    const corrections: string[] = [];

    if (!rawRequest.trim()) {
      throw new Error('raw_request is required when provided');
    }

    // Normalize line endings to CRLF
    const { normalized, changed } = normalizeLineEndings(rawRequest);
    if (changed) {
      corrections.push('Fixed line endings: \\n -> \\r\\n');
    }

    const lines = normalized.split('\r\n');
    const requestLine = lines[0] ?? '';

    // Fix request line
    const fixed = fixRequestLine(requestLine);
    corrections.push(...fixed.corrections);

    // Parse headers
    const headers = new Map<string, HeaderEntry>();
    let bodyStartIndex = lines.length;
    let separatorFixed = false;

    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i];

      // Empty line = end of headers
      if (line === '') {
        bodyStartIndex = i + 1;
        break;
      }

      // Whitespace-only line = end of headers (with correction)
      if (line.trim() === '') {
        bodyStartIndex = i + 1;
        break;
      }

      const normalizedHeader = normalizeHeaderLine(line);
      if (normalizedHeader) {
        if (normalizedHeader.fixed) {
          corrections.push(`Fixed header format: '${line}' -> '${normalizedHeader.line}'`);
        }
        setHeader(headers, normalizedHeader.name, normalizedHeader.value);
        continue;
      }

      // Line doesn't look like a header - treat as body start
      if (!separatorFixed) {
        corrections.push('Fixed missing header-body separator');
        separatorFixed = true;
      }
      bodyStartIndex = i;
      break;
    }

    const body = lines.slice(bodyStartIndex).join('\r\n');

    // Ensure Host header
    const hostHeader = deriveHostHeader(targetUrl, fixed.path);
    if (!getHeader(headers, 'host') && hostHeader) {
      setHeader(headers, 'Host', hostHeader);
      corrections.push(`Added missing Host header: ${hostHeader}`);
    }

    // Ensure Content-Length
    const headerRecord = ensureContentLength(toHeaderRecord(headers), body, corrections);

    // Reconstruct corrected request
    const reconstructedHeaders = Object.entries(headerRecord).map(([key, value]) => `${key}: ${value}`);
    const correctedRequest = [fixed.line, ...reconstructedHeaders, '', body].join('\r\n');

    return {
      url: resolveUrl(targetUrl, fixed.path),
      method: fixed.method,
      headers: headerRecord,
      body,
      requestLine: fixed.line,
      correctedRequest,
      corrections,
    };
  }
}
