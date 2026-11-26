import fs from 'fs/promises';

export const SANDBOX_WRITABLE_DIR_MODE = 0o777;

export const ensureSandboxWritableDirectory = async (directoryPath: string): Promise<void> => {
  await fs.mkdir(directoryPath, { recursive: true, mode: SANDBOX_WRITABLE_DIR_MODE });
  await fs.chmod(directoryPath, SANDBOX_WRITABLE_DIR_MODE).catch(() => undefined);
};
