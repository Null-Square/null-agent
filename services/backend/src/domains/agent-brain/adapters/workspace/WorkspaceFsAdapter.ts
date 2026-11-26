import fs from 'fs/promises';
import path from 'path';
import { ensureSandboxWritableDirectory } from './workspacePermissions';

export const joinFsPath = (...segments: string[]): string => path.join(...segments);

export const resolveFsPath = (...segments: string[]): string => path.resolve(...segments);

export const dirnameFsPath = (value: string): string => path.dirname(value);

export const joinPosixPath = (...segments: string[]): string => path.posix.join(...segments);

export const normalizePosixPath = (value: string): string => path.posix.normalize(value);

export const toPosixPath = (value: string): string => value.split(path.sep).join('/');

export const ensureDirectory = async (directoryPath: string): Promise<void> => {
  await ensureSandboxWritableDirectory(directoryPath);
};

export const writeTextFileEnsuringParent = async (filePath: string, content: string): Promise<void> => {
  await ensureDirectory(dirnameFsPath(filePath));
  await fs.writeFile(filePath, content, 'utf8');
};

export const readTextFile = async (filePath: string): Promise<string> =>
  fs.readFile(filePath, 'utf8');

export const writeJsonFileEnsuringParent = async (filePath: string, value: unknown): Promise<void> => {
  await writeTextFileEnsuringParent(filePath, JSON.stringify(value, null, 2));
};

export const copyPathIfPresent = async (sourcePath: string, targetPath: string): Promise<boolean> => {
  try {
    await fs.access(sourcePath);
  } catch {
    return false;
  }

  await ensureDirectory(dirnameFsPath(targetPath));
  await fs.cp(sourcePath, targetPath, { recursive: true });
  return true;
};

export const isFilePath = async (filePath: string): Promise<boolean> => {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
};

export const copyFileEnsuringParent = async (sourcePath: string, targetPath: string): Promise<void> => {
  await ensureDirectory(dirnameFsPath(targetPath));
  await fs.copyFile(sourcePath, targetPath);
};

export const isWithinFsRoot = (rootPath: string, candidatePath: string): boolean => {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.resolve(candidatePath);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
};
