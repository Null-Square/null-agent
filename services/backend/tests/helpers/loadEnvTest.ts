import fs from 'fs';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';

// Tests make their owner key in a temp folder, never in the person's home.
process.env.NULL_AI_OWNER_KEY_FILE = path.join(os.tmpdir(), `null-ai-test-owner-key-${process.pid}`);

// Skip loading local env files in CI - use CI-provided environment variables instead
if (process.env.CI) {
  console.log('[Vitest Setup] Running in CI - using CI environment variables');
} else {
  // Get directory - use __dirname which works in CommonJS context with ts-node
  const currentDir = __dirname;
  const defaultsEnvPath = path.resolve(currentDir, '..', '..', '.env.example');
  const localEnvPath = path.resolve(currentDir, '..', '..', '.env.local');

  console.log('[Vitest Setup] Loading env defaults from:', defaultsEnvPath);

  if (fs.existsSync(defaultsEnvPath)) {
    const result = dotenv.config({ path: defaultsEnvPath });
    if (result.error) {
      console.error('[Vitest Setup] Error loading .env.example:', result.error);
    } else {
      console.log('[Vitest Setup] Loaded .env.example successfully');
    }
  } else {
    console.warn('[Vitest Setup] .env.example not found at:', defaultsEnvPath);
  }

  if (fs.existsSync(localEnvPath)) {
    dotenv.config({ path: localEnvPath, override: true });
    console.log('[Vitest Setup] Loaded .env.local successfully');
  }

  console.log('[Vitest Setup] TEST_DATABASE_URL:', process.env.TEST_DATABASE_URL ? 'SET' : 'NOT SET');
  console.log('[Vitest Setup] TEST_S3_ENDPOINT:', process.env.TEST_S3_ENDPOINT ? 'SET' : 'NOT SET');
}
