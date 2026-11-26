import { describe, expect, it } from 'vitest';

import {
  extractScopeDocumentText,
  isTextLikeScopeDocument,
  resolveScopeDocumentStoragePath,
  sanitizeScopeDocumentFileName,
} from '@/domains/security-ops/setup/ScopeDocumentService';

describe('ScopeDocumentService helpers', () => {
  it('sanitizes uploaded document filenames', () => {
    expect(sanitizeScopeDocumentFileName('../Rules of Engagement!.md')).toBe('Rules_of_Engagement_.md');
    expect(sanitizeScopeDocumentFileName('')).toBe('document.bin');
  });

  it('extracts bounded redacted text from text-like setup documents', () => {
    const result = extractScopeDocumentText({
      fileName: 'policy.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('Rules\npassword: super-secret-token\nBearer abcdefghijklmnop', 'utf8'),
      maxChars: 120,
    });

    expect(result.parseStatus).toBe('parsed');
    expect(result.parsedText).toContain('Rules');
    expect(result.parsedText).toContain('password=[REDACTED]');
    expect(result.parsedText).toContain('Bearer [REDACTED]');
    expect(result.redacted).toBe(true);
  });

  it('normalizes uploaded text before storing prompt-visible document content', () => {
    const nulByte = String.fromCharCode(0);
    const result = extractScopeDocumentText({
      fileName: 'scope.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(`Line one${nulByte}\r\nLine two\rLine three`, 'utf8'),
    });

    expect(result.parseStatus).toBe('parsed');
    expect(result.parsedText).toBe('Line one\nLine two\nLine three');
  });

  it('marks unsupported binary documents as unavailable for model reading', () => {
    const result = extractScopeDocumentText({
      fileName: 'contract.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7', 'utf8'),
    });

    expect(result.parseStatus).toBe('unsupported');
    expect(result.parsedText).toBeNull();
  });

  it('detects supported text extensions and blocks storage traversal', () => {
    expect(isTextLikeScopeDocument('application/octet-stream', 'scope.csv')).toBe(true);
    expect(() => resolveScopeDocumentStoragePath('../escape.txt', '/tmp/scope-docs')).toThrow(
      /Invalid scope document storage key/,
    );
  });
});
