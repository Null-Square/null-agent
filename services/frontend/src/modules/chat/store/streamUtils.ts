export const decodeSseChunk = (raw: string | undefined | null): string => {
  if (raw == null) {
    return '';
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') {
      return parsed;
    }
  } catch {
    // swallow parse errors and fall back to the raw payload
  }

  return raw;
};
