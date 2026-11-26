const truthyValues = new Set(['1', 'true', 'yes', 'on']);

export const isVerboseSessionLoggingEnabled = (
  value: string | undefined = process.env.LOG_VERBOSE_SESSION,
): boolean => truthyValues.has(String(value ?? '').toLowerCase());
