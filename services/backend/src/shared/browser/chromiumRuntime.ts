import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const DEFAULT_CHROMIUM_PATH =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() ||
  process.env.PUPPETEER_EXECUTABLE_PATH?.trim() ||
  '/usr/bin/chromium';

export const CHROMIUM_LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

export type ChromiumRuntime = {
  executablePath: string;
  env: Record<string, string>;
  userDataDir: string;
  rootDir: string;
  cleanup: () => Promise<void>;
};

export async function createChromiumRuntime(
  prefix: string,
  options?: {
    userDataDir?: string;
  },
): Promise<ChromiumRuntime> {
  const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const homeDir = path.join(rootDir, 'home');
  const configDir = path.join(rootDir, 'config');
  const cacheDir = path.join(rootDir, 'cache');
  const userDataDir = options?.userDataDir ?? path.join(rootDir, 'profile');

  await Promise.all([
    fs.promises.mkdir(homeDir, { recursive: true }),
    fs.promises.mkdir(configDir, { recursive: true }),
    fs.promises.mkdir(cacheDir, { recursive: true }),
    fs.promises.mkdir(userDataDir, { recursive: true }),
  ]);

  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );

  return {
    executablePath: DEFAULT_CHROMIUM_PATH,
    env: {
      ...env,
      HOME: homeDir,
      XDG_CONFIG_HOME: configDir,
      XDG_CACHE_HOME: cacheDir,
    },
    userDataDir,
    rootDir,
    cleanup: async () => {
      await fs.promises.rm(rootDir, { recursive: true, force: true });
    },
  };
}
