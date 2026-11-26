const SECRET_KEY_PATTERN =
  String.raw`password|passwd|pwd|secret|token|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|private[_ -]?key|authorization|credential|client[_ -]?secret`;
const QUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b(${SECRET_KEY_PATTERN})\b(\s*[:=]\s*)(["'])(?![=>])[^"'\r\n]{6,}\3`,
  'giu',
);
const UNQUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b(${SECRET_KEY_PATTERN})\b(\s*[:=]\s*)(?![=>"'])[^,\s;]{6,}`,
  'giu',
);
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu;
const BASIC_TOKEN_PATTERN = /\bBasic\s+[A-Za-z0-9+/=._~-]{12,}/giu;
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu;

export const redactCodeReviewText = (value: string): string =>
  value
    .replace(PRIVATE_KEY_PATTERN, (match) => {
      const lineEndings = match.match(/\r\n|\r|\n/gu) ?? [];
      return `[REDACTED PRIVATE KEY]${lineEndings.join('')}`;
    })
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [REDACTED]')
    .replace(BASIC_TOKEN_PATTERN, 'Basic [REDACTED]')
    .replace(GITHUB_TOKEN_PATTERN, '[REDACTED GITHUB TOKEN]')
    .replace(AWS_ACCESS_KEY_PATTERN, '[REDACTED AWS ACCESS KEY]')
    .replace(
      QUOTED_SECRET_ASSIGNMENT_PATTERN,
      (_match, key: string, separator: string, quote: string) =>
        `${key}${separator}${quote}[REDACTED]${quote}`,
    )
    .replace(
      UNQUOTED_SECRET_ASSIGNMENT_PATTERN,
      (_match, key: string, separator: string) =>
        `${key}${separator}[REDACTED]`,
    );
