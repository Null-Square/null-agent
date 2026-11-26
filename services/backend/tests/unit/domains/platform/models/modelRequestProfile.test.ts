import { describe, expect, it } from 'vitest';
import { validateModelRequestProfile } from '@/domains/platform/models/modelRequestProfile';

describe('validateModelRequestProfile', () => {
  it('accepts only provider-owned request fields', () => {
    expect(validateModelRequestProfile('DEEPSEEK', {
      thinking: 'enabled',
      reasoningEffort: 'high',
    })).toEqual({ thinking: 'enabled', reasoningEffort: 'high' });
    expect(validateModelRequestProfile('MOONSHOT', {
      thinking: 'enabled',
      keep: 'all',
    })).toEqual({ thinking: 'enabled', keep: 'all' });
  });

  it('rejects routing, pricing, and invalid provider fields', () => {
    expect(() => validateModelRequestProfile('OPENAI', { price: 1 })).toThrow('Unsupported OPENAI');
    expect(() => validateModelRequestProfile('MOONSHOT', { thinking: 'disabled', keep: 'all' }))
      .toThrow('keep requires thinking=enabled');
    expect(() => validateModelRequestProfile('UNKNOWN', {})).toThrow('Unsupported model provider');
  });
});
