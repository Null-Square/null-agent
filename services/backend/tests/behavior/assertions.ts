import type { ObservedToolCall } from './types';

export const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export const asString = (value: unknown): string =>
  typeof value === 'string' ? value : '';

export const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

export const firstTool = (calls: ObservedToolCall[]): ObservedToolCall | undefined => calls[0];

export const requireSingleTool = (calls: ObservedToolCall[]): string[] => {
  if (calls.length === 0) return ['expected exactly one tool call, observed none'];
  if (calls.length > 1) return [`expected exactly one tool call, observed ${calls.length}`];
  return [];
};

export const requireNoToolNames = (call: ObservedToolCall | undefined, blockedNames: string[]): string[] => {
  if (!call) return [];
  return blockedNames.includes(call.name) ? [`did not expect ${call.name}`] : [];
};

export const normalizedPath = (value: unknown): string => asString(value).replace(/\\/g, '/');

export const requireContentNeedles = (content: string, needles: string[], label = 'content'): string[] => {
  const normalized = content.toLowerCase();
  return needles
    .filter((needle) => !normalized.includes(needle.toLowerCase()))
    .map((needle) => `expected ${label} to mention ${needle}`);
};

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
