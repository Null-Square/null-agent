export const generateMessageId = (): string => {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Ignore and fall back to timestamp-based ID
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

