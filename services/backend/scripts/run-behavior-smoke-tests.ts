import path from 'node:path';

import dotenv from 'dotenv';

const backendRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.resolve(backendRoot, '.env.example') });
dotenv.config({ path: path.resolve(backendRoot, '.env.local'), override: true });

void import('./run-behavior-smoke-tests.lib');
