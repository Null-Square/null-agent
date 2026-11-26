export const DEFAULT_IMAGE = 'null-ai-sandbox:local';

export const SMOKE_IMAGE =
  process.env.SANDBOX_TOOL_SMOKE_IMAGE?.trim() ||
  process.env.SANDBOX_IMAGE?.trim() ||
  DEFAULT_IMAGE;

export const COMMAND_TIMEOUT_MS = Number(process.env.SANDBOX_TOOL_SMOKE_TIMEOUT_MS ?? 180_000);

export const FIXTURE_PORT = 8123;
