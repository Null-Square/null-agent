import type { LiveToolStreamState } from '../../domain/types';

const MAX_PERSISTED_STREAM_CHARS = 8_000;
const MAX_PERSISTED_RESULT_JSON_CHARS = 12_000;
const MAX_STRING_CHARS = 2_000;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 80;
const MAX_DEPTH = 5;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const NULL_CHAR = String.fromCharCode(0);

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const cleanText = (value: string): string => value.split(NULL_CHAR).join('');

const tailText = (value: string, maxChars = MAX_STRING_CHARS): string => {
  const cleaned = cleanText(value);
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  const tail = cleaned.slice(Math.max(0, cleaned.length - maxChars));
  return `[live stream text truncated; showing last ${maxChars} of ${cleaned.length} chars]\n${tail}`;
};

const trimChunks = (chunks: string[]): string[] => {
  const next = chunks.map((chunk) => tailText(chunk));
  let total = next.reduce((sum, chunk) => sum + chunk.length, 0);
  while (next.length > 1 && total > MAX_PERSISTED_STREAM_CHARS) {
    const removed = next.shift();
    total -= removed?.length ?? 0;
  }
  if (next.length === 1 && total > MAX_PERSISTED_STREAM_CHARS) {
    next[0] = tailText(next[0], MAX_PERSISTED_STREAM_CHARS);
  }
  return next;
};

const clonePayloadContainer = (result: unknown): unknown => {
  if (!isRecord(result)) {
    return result;
  }
  const next = { ...result };
  if (isRecord(next.data)) {
    next.data = { ...next.data };
  }
  return next;
};

const readPayloadRecord = (result: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(result)) {
    return undefined;
  }
  return isRecord(result.data) ? result.data : result;
};

const sanitizeShellOutputFields = (toolName: string, result: unknown): unknown => {
  if (toolName !== 'shell_run' && toolName !== 'wait_for_shell_job') {
    return result;
  }

  const next = clonePayloadContainer(result);
  const data = readPayloadRecord(next);
  if (!data) {
    return next;
  }

  for (const field of ['stdout', 'stderr'] as const) {
    const output = data[field];
    if (typeof output !== 'string' || output.length === 0) {
      continue;
    }

    const pathField = field === 'stdout' ? 'stdoutPath' : 'stderrPath';
    const pathValue = typeof data[pathField] === 'string' ? data[pathField] : undefined;
    data[`${field}OriginalChars`] = typeof data[`${field}OriginalChars`] === 'number'
      ? data[`${field}OriginalChars`]
      : output.length;

    if (pathValue) {
      data[field] = `[${field} omitted from live session metadata; full output at ${pathValue}; chars=${output.length}]`;
      data[`${field}OmittedFromLiveStream`] = true;
      continue;
    }

    data[field] = tailText(output);
    if (data[field] !== cleanText(output)) {
      data[`${field}TruncatedFromLiveStream`] = true;
    }
  }

  return next;
};

const sanitizeValue = (value: unknown, depth = 0): unknown => {
  if (typeof value === 'string') {
    return tailText(value);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return '[object omitted from live session metadata: max depth reached]';
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[${value.length - MAX_ARRAY_ITEMS} array items omitted from live session metadata]`);
    }
    return items;
  }
  if (!isRecord(value)) {
    return String(value);
  }

  const entries = Object.entries(value);
  const next: Record<string, unknown> = {};
  for (const [key, entryValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
    next[key] = sanitizeValue(entryValue, depth + 1);
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    next._liveStreamOmittedKeys = entries.length - MAX_OBJECT_KEYS;
  }
  return next;
};

const capSerializedResult = (toolName: string, result: unknown): unknown => {
  const serialized = safeStringify(result);
  if (serialized.length <= MAX_PERSISTED_RESULT_JSON_CHARS) {
    return result;
  }
  return {
    tool: toolName,
    status: isRecord(result) && typeof result.status === 'string' ? result.status : 'live_result_truncated',
    preview: `${serialized.slice(0, MAX_STRING_CHARS).trimEnd()}...[live tool result truncated]`,
    originalChars: serialized.length,
    omittedFromLiveStream: true,
  };
};

export const sanitizeLiveToolResult = (toolName: string, result: unknown): unknown => {
  if (result === undefined) {
    return undefined;
  }
  const shellSanitized = sanitizeShellOutputFields(toolName, result);
  const sanitized = sanitizeValue(shellSanitized);
  return capSerializedResult(toolName, sanitized);
};

export const sanitizeLiveToolStreams = (
  streams: Record<string, LiveToolStreamState> | undefined,
): Record<string, LiveToolStreamState> => {
  if (!streams) {
    return {};
  }

  const next: Record<string, LiveToolStreamState> = {};
  for (const [key, stream] of Object.entries(streams)) {
    const name = stream.name || key;
    next[key] = {
      ...stream,
      name,
      chunks: trimChunks(Array.isArray(stream.chunks) ? stream.chunks : []),
      result: stream.result === undefined ? undefined : sanitizeLiveToolResult(name, stream.result),
    };
  }
  return next;
};
