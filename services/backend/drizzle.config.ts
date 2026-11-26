import { defineConfig } from 'drizzle-kit';
import path from 'node:path';
import dotenv from 'dotenv';

const envPath = path.resolve(__dirname, '.env');
dotenv.config({ path: envPath });

const DEFAULT_DB_URL = 'postgres://postgres:postgres@localhost:15432/nullai_chat';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || process.env.DB_URL || DEFAULT_DB_URL,
  },
  verbose: true,
  strict: true,
});
