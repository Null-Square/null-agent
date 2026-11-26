import path from 'path';
import dotenv from 'dotenv';

const backendRoot = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(backendRoot, '.env') });

const nodeEnv = process.env.NODE_ENV ?? 'development';
if (nodeEnv !== 'production' && nodeEnv !== 'test') {
  dotenv.config({ path: path.join(backendRoot, '.env.local'), override: true });
}
