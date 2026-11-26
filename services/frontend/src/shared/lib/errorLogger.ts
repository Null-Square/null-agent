import { toApiError } from '@/shared/lib/apiError';

type LogSeverity = 'info' | 'warn' | 'error' | 'critical';

interface ErrorContext {
  userId?: string;
  scanId?: string;
  component?: string;
  action?: string;
  url?: string;
  userAgent?: string;
  timestamp?: string;
  [key: string]: unknown;
}

interface LogErrorParams {
  error: Error | string;
  source: string;
  severity?: LogSeverity;
  context?: ErrorContext;
}

/**
 * Log an error to the console
 * @param params - Error logging parameters
 */
export const logError = async ({
  error,
  source,
  severity = 'error',
  context = {}
}: LogErrorParams): Promise<void> => {
  try {
    // Prepare error message
    const message = typeof error === 'string' ? error : error.message;

    // Prepare context with additional metadata
    const errorContext: ErrorContext = {
      ...context,
      url: typeof window !== 'undefined' ? window.location.href : '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      timestamp: new Date().toISOString(),
    };

    // Remove undefined values from context
    Object.keys(errorContext).forEach(key => {
      if (errorContext[key] === undefined) {
        delete errorContext[key];
      }
    });

    // Error logs service has been removed, logging to console only
    console.error(`[ERROR LOGGABLE] Source: ${source}, Severity: ${severity}, Message: ${message}`);
    if (Object.keys(errorContext).length > 0) {
      console.error('[ERROR CONTEXT]', errorContext);
    }
  } catch (error: unknown) {
    const apiError = toApiError(error);
    console.error('Critical failure in error logging service:', apiError);
  }
};

/**
 * Log an info message
 * @param message - Info message
 * @param source - Source of the message
 * @param context - Additional context
 */
export const logInfo = async (
  message: string,
  source: string,
  context?: ErrorContext
): Promise<void> => {
  await logError({
    error: message,
    source,
    severity: 'info',
    context
  });
};

/**
 * Log a warning message
 * @param message - Warning message
 * @param source - Source of the message
 * @param context - Additional context
 */
export const logWarning = async (
  message: string,
  source: string,
  context?: ErrorContext
): Promise<void> => {
  await logError({
    error: message,
    source,
    severity: 'warn',  // Use 'warn' - will be converted to 'warning' in the database
    context
  });
};

/**
 * Log a critical error
 * @param error - Error object or message
 * @param source - Source of the error
 * @param context - Additional context
 */
export const logCritical = async (
  error: Error | string,
  source: string,
  context?: ErrorContext
): Promise<void> => {
  await logError({
    error,
    source,
    severity: 'critical',
    context
  });
};

export default {
  logError,
  logInfo,
  logWarning,
  logCritical
};
