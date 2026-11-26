import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { JsonRepairService } from '@/domains/agent-brain/application/services/JsonRepairService';

describe('JsonRepairService', () => {
  const service = new JsonRepairService();

  it('passes through valid JSON unchanged', () => {
    const result = service.parse('{"foo":1,"bar":"baz"}');

    expect(result).toEqual({ foo: 1, bar: 'baz' });
  });

  it('repairs missing closing braces', () => {
    const result = service.parse('{"foo":"bar"');

    expect(result).toEqual({ foo: 'bar' });
  });

  it('repairs trailing commas', () => {
    const result = service.parse('{"foo":1,}');

    expect(result).toEqual({ foo: 1 });
  });

  it('quotes unquoted keys', () => {
    const result = service.parse('{foo: "bar", baz: 2}');

    expect(result).toEqual({ foo: 'bar', baz: 2 });
  });

  it('repairs single-quoted keys and string values', () => {
    const result = service.parse("{'foo': 'bar', 'nested': {'baz': 'qux'}}");

    expect(result).toEqual({ foo: 'bar', nested: { baz: 'qux' } });
  });

  it('repairs JS-like literals emitted by models', () => {
    const result = service.parse("{foo: 'bar', enabled: True, fallback: None, next: undefined}");

    expect(result).toEqual({ foo: 'bar', enabled: true, fallback: null, next: null });
  });

  it('quotes bare enum-like values emitted by models', () => {
    const result = service.parse('{closeoutOutcome: no_findings, phase: enumeration, retryable: False}');

    expect(result).toEqual({
      closeoutOutcome: 'no_findings',
      phase: 'enumeration',
      retryable: false,
    });
  });

  it('quotes bare nested values and array items while preserving JSON primitives', () => {
    const result = service.parse(
      '{ntype: dns.subdomain, ids: [lead_one, lead_two], enabled: true, count: 3, url: http://localhost:3000/api}',
    );

    expect(result).toEqual({
      ntype: 'dns.subdomain',
      ids: ['lead_one', 'lead_two'],
      enabled: true,
      count: 3,
      url: 'http://localhost:3000/api',
    });
  });

  it('preserves escaped backslashes inside repaired single-quoted strings', () => {
    const result = service.parse(String.raw`{'path':'C:\\temp\\report.txt'}`);

    expect(result).toEqual({ path: String.raw`C:\temp\report.txt` });
  });

  it('repairs truncated string values', () => {
    const result = service.parse('{"foo":"bar');

    expect(result).toEqual({ foo: 'bar' });
  });

  it('returns empty object for empty input', () => {
    const result = service.parse('');

    expect(result).toEqual({});
  });
});







