import { describe, it, expect } from 'vitest';
import { decodeSseChunk } from './streamUtils';

describe('decodeSseChunk', () => {
  it('returns empty string for nullish or whitespace input', () => {
    expect(decodeSseChunk(undefined)).toBe('');
    expect(decodeSseChunk(null)).toBe('');
    expect(decodeSseChunk('   ')).toBe('');
  });

  it('parses JSON string payloads', () => {
    expect(decodeSseChunk('"hello"')).toBe('hello');
  });

  it('returns raw input for non-string JSON or invalid JSON', () => {
    expect(decodeSseChunk('{"value":1}')).toBe('{"value":1}');
    expect(decodeSseChunk('not-json')).toBe('not-json');
  });
});
