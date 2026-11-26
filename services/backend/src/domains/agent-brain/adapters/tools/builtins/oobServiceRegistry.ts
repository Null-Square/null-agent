import { db } from '@/db/client';
import type { ResolvedConfig } from '@/config/configTypes';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { OobService } from '@/domains/security-ops/oob/OobService';

// Marker for ToolManifestRegistry: this is a helper module, not a tool module definition.
export const __skipToolManifest = true as const;

const fallbackService = new OobService(db);
const servicesByConfig = new WeakMap<ResolvedConfig, OobService>();

export const getOobService = (ctx: ToolContext): OobService => {
  if (!ctx.config) {
    return fallbackService;
  }

  const cached = servicesByConfig.get(ctx.config);
  if (cached) {
    return cached;
  }

  const service = new OobService(db, { config: ctx.config });
  servicesByConfig.set(ctx.config, service);
  return service;
};
