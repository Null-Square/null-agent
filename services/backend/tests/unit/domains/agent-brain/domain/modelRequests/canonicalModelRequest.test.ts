import { describe, expect, it } from 'vitest';

import {
  assertModelRequestDigest,
  canonicalizeModelRequestEnvelope,
} from '@/domains/agent-brain/domain/modelRequests/canonicalModelRequest';

describe('canonicalModelRequest', () => {
  it('produces one digest regardless of object key insertion order', () => {
    const left = canonicalizeModelRequestEnvelope({
      tools: [{ function: { name: 'inspect', parameters: { required: ['target'], type: 'object' } } }],
      model: 'model-a',
      messages: [{ content: 'hello', role: 'user' }],
    });
    const right = canonicalizeModelRequestEnvelope({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'model-a',
      tools: [{ function: { parameters: { type: 'object', required: ['target'] }, name: 'inspect' } }],
    });

    expect(left.digest).toBe(right.digest);
    expect(left.canonicalJson).toBe(right.canonicalJson);
  });

  it('detects any model-visible mutation', () => {
    const canonical = canonicalizeModelRequestEnvelope({
      model: 'model-a',
      messages: [{ role: 'system', content: 'original' }],
      stream: true,
    });

    expect(() => assertModelRequestDigest({
      ...canonical.envelope,
      messages: [{ role: 'system', content: 'mutated' }],
    }, canonical.digest)).toThrowError(expect.objectContaining({
      code: 'model_request_digest_mismatch',
    }));
  });
});
