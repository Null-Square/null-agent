export const sessionIdFromPath = (dir: string): string => {
  const parts = dir.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || parts[parts.length - 2];
};
