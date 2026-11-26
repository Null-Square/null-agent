export const normalizeArtifactRelativePath = (relativePath: string): string =>
  relativePath.trim().replace(/\\/g, '/').replace(/^\/+/, '');

const pathSegments = (relativePath: string): string[] =>
  normalizeArtifactRelativePath(relativePath).toLowerCase().split('/').filter(Boolean);

export const isTransientArtifactSubtreePath = (relativePath: string): boolean => {
  const segments = pathSegments(relativePath);
  return (
    segments.length >= 2 &&
    segments[0] === '.artifacts' &&
    (segments[1] === 'shell-jobs' || segments[1] === 'proxy')
  );
};

export const isStagingNoiseArtifactPath = (
  relativePath: string,
  options: { sizeBytes?: number } = {},
): boolean => {
  const segments = pathSegments(relativePath);
  if (segments.length === 0) return false;

  const fileName = segments[segments.length - 1];
  if (!fileName) return false;

  if (segments[0] === '.mitmproxy') {
    return true;
  }

  const isShellJobFile =
    segments.length >= 4 && segments[0] === '.artifacts' && segments[1] === 'shell-jobs';
  if (isShellJobFile && (fileName === 'runner.sh' || fileName === 'pid')) {
    return true;
  }

  const normalized = segments.join('/');
  if (
    normalized === '.artifacts/proxy/mitmproxy.log' ||
    normalized === '.artifacts/proxy/mitmproxy.pid'
  ) {
    return true;
  }

  return fileName.endsWith('.log') && options.sizeBytes === 0;
};
