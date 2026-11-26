import { afterEach, describe, expect, it } from 'vitest';
import {
  decryptModelApiKey,
  encryptModelApiKey,
  isEncryptedModelApiKey,
} from '@/domains/platform/models/modelApiKeyCipher';

const testKey = Buffer.alloc(32, 7).toString('base64');

describe('modelApiKeyCipher', () => {
  const originalModelKey = process.env.MODEL_API_KEY_ENCRYPTION_KEY;
  const originalAccessKey = process.env.ACCESS_MATERIALS_ENCRYPTION_KEY;

  afterEach(() => {
    process.env.MODEL_API_KEY_ENCRYPTION_KEY = originalModelKey;
    process.env.ACCESS_MATERIALS_ENCRYPTION_KEY = originalAccessKey;
  });

  it('encrypts and decrypts model API keys', () => {
    process.env.MODEL_API_KEY_ENCRYPTION_KEY = testKey;
    delete process.env.ACCESS_MATERIALS_ENCRYPTION_KEY;

    const encrypted = encryptModelApiKey('sk-live-secret');

    expect(encrypted).not.toBe('sk-live-secret');
    expect(isEncryptedModelApiKey(encrypted)).toBe(true);
    expect(decryptModelApiKey(encrypted)).toBe('sk-live-secret');
  });

  it('keeps legacy plaintext rows readable', () => {
    delete process.env.MODEL_API_KEY_ENCRYPTION_KEY;
    delete process.env.ACCESS_MATERIALS_ENCRYPTION_KEY;

    expect(decryptModelApiKey('sk-legacy-secret')).toBe('sk-legacy-secret');
  });

  it('requires an encryption key for new stored secrets', () => {
    delete process.env.MODEL_API_KEY_ENCRYPTION_KEY;
    delete process.env.ACCESS_MATERIALS_ENCRYPTION_KEY;

    expect(() => encryptModelApiKey('sk-new-secret')).toThrow(/required to store model API keys/u);
  });
});
