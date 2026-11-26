import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { AppError, ERROR_CODES } from '@/shared/errors';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const PREFIX = 'enc:v1:';
const ENCRYPTION_KEY_ENV_NAMES = ['MODEL_API_KEY_ENCRYPTION_KEY', 'ACCESS_MATERIALS_ENCRYPTION_KEY'] as const;

export const isEncryptedModelApiKey = (value: string | null | undefined): boolean =>
  typeof value === 'string' && value.startsWith(PREFIX);

export const encryptModelApiKey = (value: string | null | undefined): string | null => {
  const plaintext = typeof value === 'string' ? value.trim() : '';
  if (!plaintext) return null;
  if (isEncryptedModelApiKey(plaintext)) return plaintext;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    PREFIX.slice(0, -1),
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
};

export const decryptModelApiKey = (value: string | null | undefined): string | null => {
  const stored = typeof value === 'string' ? value.trim() : '';
  if (!stored) return null;
  if (!isEncryptedModelApiKey(stored)) return stored;

  const [, , iv, authTag, ciphertext] = stored.split(':');
  if (!iv || !authTag || !ciphertext) {
    throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, 'Invalid encrypted model API key format', {
      httpStatus: 503,
    });
  }

  const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
};

const getEncryptionKey = (): Buffer => {
  const envName = ENCRYPTION_KEY_ENV_NAMES.find((name) => process.env[name]?.trim());
  const raw = envName ? process.env[envName] : undefined;
  if (!raw || !raw.trim()) {
    throw new AppError(
      ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
      `${ENCRYPTION_KEY_ENV_NAMES.join(' or ')} is required to store model API keys`,
      { httpStatus: 503 },
    );
  }

  let key: Buffer;
  try {
    key = Buffer.from(raw.trim(), 'base64');
  } catch {
    throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, `${envName} must be valid base64`, {
      httpStatus: 503,
    });
  }

  if (key.length !== KEY_BYTES) {
    throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, `${envName} must decode to ${KEY_BYTES} bytes`, {
      httpStatus: 503,
    });
  }

  return key;
};
