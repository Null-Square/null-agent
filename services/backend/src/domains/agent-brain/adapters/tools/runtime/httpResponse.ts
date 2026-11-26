/**
 * HTTP Response Parser - Parse curl -i output into structured response data.
 *
 * @module agent-brain/adapters/tools/runtime/httpResponse
 */

const STATUS_LINE_REGEX = /^HTTP\/[\d.]+\s+\d{3}.*$/gm;

/** Parsed HTTP response */
export interface ParsedHttpResponse {
  headersRaw: string;
  bodyRaw: string;
  statusCode: number | null;
}

/**
 * Extract status code from headers.
 */
const extractStatusCode = (headersRaw: string): number | null => {
  const match = headersRaw.match(/^HTTP\/[\d.]+\s+(\d{3})/);
  if (!match) {
    return null;
  }
  const code = Number.parseInt(match[1], 10);
  return Number.isFinite(code) ? code : null;
};

/**
 * Parse curl -i output to separate headers and body.
 * Handles multiple status lines (from redirects) by using the last one.
 */
export const parseCurlHttpResponse = (raw: string): ParsedHttpResponse => {
  if (!raw) {
    return { headersRaw: '', bodyRaw: '', statusCode: null };
  }

  // Find all HTTP status lines, use the last one (handles redirects)
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = STATUS_LINE_REGEX.exec(raw)) !== null) {
    lastMatch = match;
  }

  if (!lastMatch) {
    return { headersRaw: '', bodyRaw: raw, statusCode: null };
  }

  const headersStart = lastMatch.index;

  // Find end of headers (blank line)
  let headersEnd = raw.indexOf('\r\n\r\n', headersStart);
  let separatorLength = 4;
  if (headersEnd === -1) {
    headersEnd = raw.indexOf('\n\n', headersStart);
    separatorLength = 2;
  }

  if (headersEnd === -1) {
    // No body, just headers
    const headersRaw = raw.slice(headersStart);
    return {
      headersRaw,
      bodyRaw: '',
      statusCode: extractStatusCode(headersRaw),
    };
  }

  const headersRaw = raw.slice(headersStart, headersEnd);
  const bodyRaw = raw.slice(headersEnd + separatorLength);

  return {
    headersRaw,
    bodyRaw,
    statusCode: extractStatusCode(headersRaw),
  };
};

/**
 * Get a specific header value from raw headers.
 */
export const getHeaderValue = (headersRaw: string, headerName: string): string | undefined => {
  if (!headersRaw) {
    return undefined;
  }

  const normalized = headerName.trim().toLowerCase();
  for (const line of headersRaw.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) {
      continue;
    }
    const name = line.slice(0, idx).trim().toLowerCase();
    if (name !== normalized) {
      continue;
    }
    return line.slice(idx + 1).trim();
  }

  return undefined;
};
