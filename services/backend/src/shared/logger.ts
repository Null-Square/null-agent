import pino, { type Logger, type LoggerOptions } from 'pino';
import { traceContextMixin } from './logger/traceContext';

const resolveLevel = (): string => process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
const NULL_CHAR = String.fromCharCode(0);

const redactVerboseErrorText = (value: string): string =>
  value
    .replace(/(\n\s*params:\s*)[\s\S]*/i, '$1[redacted]')
    .replace(/(\n\s*parameters:\s*)[\s\S]*/i, '$1[redacted]')
    .split(NULL_CHAR).join('');

const truncateLogText = (value: string, maxChars: number): string => {
  const redacted = redactVerboseErrorText(value);
  if (redacted.length <= maxChars) {
    return redacted;
  }
  return `${redacted.slice(0, maxChars).trimEnd()}...[truncated for log safety]`;
};

const sanitizeErrorForLog = (error: unknown): unknown => {
  const serialized = pino.stdSerializers.err(error as Error) as Record<string, unknown>;
  if (!serialized || typeof serialized !== 'object') {
    return serialized;
  }
  if (typeof serialized.message === 'string') {
    serialized.message = truncateLogText(serialized.message, 2_000);
  }
  if (typeof serialized.stack === 'string') {
    serialized.stack = truncateLogText(serialized.stack, 6_000);
  }
  if ('params' in serialized) {
    serialized.params = '[redacted]';
  }
  if ('parameters' in serialized) {
    serialized.parameters = '[redacted]';
  }
  if (typeof serialized.query === 'string') {
    serialized.query = truncateLogText(serialized.query, 2_000);
  }
  return serialized;
};

const baseOptions: LoggerOptions = {
  level: resolveLevel(),
  base: {
    service: 'backend-service',
    appRole: process.env.APP_ROLE || 'api',
  },
  // Inject traceId/spanId from OpenTelemetry when available
  mixin: traceContextMixin,
  messageKey: 'msg',
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  serializers: {
    err: sanitizeErrorForLog,
  },
};

const isPretty = ['1', 'true', 'yes'].includes(String(process.env.LOG_PRETTY || '').toLowerCase());

const buildTransport = () => {
  if (!isPretty) {
    return undefined;
  }
  const isTest = process.env.NODE_ENV === 'test';
  try {
    // Ensure pino-pretty is available; otherwise fall back to default transport to avoid crashing.
    require.resolve('pino-pretty');
    return pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        singleLine: false,
      },
    });
  } catch {
    if (!isTest) {
       
      console.warn('[logger] LOG_PRETTY enabled but pino-pretty is not installed; falling back to JSON logs.');
    }
    return undefined;
  }
};

const transport = buildTransport();

const rootLogger = pino(baseOptions, transport);

export type AppLogger = Logger;

const cleanContext = (context: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined && value !== null),
  );

export const createLogger = (context?: Record<string, unknown>): AppLogger =>
  context ? rootLogger.child(cleanContext(context)) : rootLogger;

export const requestLogger = (context: {
  requestId?: string;
  userId?: string;
  sessionId?: string;
  path?: string;
  method?: string;
} = {}): AppLogger => createLogger(cleanContext(context));

export const logger = rootLogger;
