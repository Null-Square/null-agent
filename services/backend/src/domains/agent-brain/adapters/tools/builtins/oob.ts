import { fromToolImpl } from '@/domains/agent-brain/application/tools/helpers';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import { getSessionFromContext } from '@/domains/agent-brain/application/tools/runtime/ToolContextSelectors';
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolModuleDefinition } from '@/domains/agent-brain/application/tools/types';
import { resolveSecurityOpsToolContext } from './securityopsContext';
import { getOobService } from './oobServiceRegistry';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export const OobTokenCreate: ToolImpl = {
  meta: {
    name: 'oob_token_create',
    description:
      'Create a run-scoped out-of-band callback token for blind SSRF, XXE, RCE, log-injection, or DNS exfil validation. When INTERACTSH_SERVER_URL is configured, the token is issued for the self-hosted callback domain and interactions are persisted in the database; otherwise the tool falls back to offline workspace files and reports that OOB is unavailable for real blind testing.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short label for the hypothesis or endpoint under test.' },
        ttl_seconds: { type: 'number', description: 'Token TTL in seconds. Default 3600, max 86400.' },
      },
    },
    risks: ['network', 'write'],
    returns: 'json',
  },

  async run(args, ctx) {
    return runWithGuards(
      OobTokenCreate.meta,
      ctx,
      async () => {
        const session = getSessionFromContext(ctx);
        if (!session?.id || !session.userId) {
          return { ok: false, data: { error: 'Session identity is not available' } };
        }

        const securityContext = resolveSecurityOpsToolContext(ctx);
        const parsed = isRecord(args) ? args : {};
        const result = await getOobService(ctx).createToken({
          label: optionalString(parsed.label),
          ttlSeconds: optionalNumber(parsed.ttl_seconds),
          sessionId: session.id,
          userId: session.userId,
          organizationId: securityContext.organizationId,
          scopeId: securityContext.scopeId,
          runId: securityContext.runId,
          workspaceDir: session.workspaceDir,
        });
        return { ok: !result.unavailable || Boolean(result.hostname), data: result };
      },
      {},
      {},
    );
  },
};

export const OobCheckInteractions: ToolImpl = {
  meta: {
    name: 'oob_check_interactions',
    description:
      'Check recorded interactions for an OOB token. Configured deployments poll the self-hosted interactsh service and return database-backed DNS/HTTP/SMTP interactions; offline/test environments read compatible .oob-interactions.ndjson records from the workspace.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Token returned by oob_token_create.' },
        since: { type: 'string', description: 'Optional ISO timestamp lower bound.' },
        limit: { type: 'number', description: 'Maximum interactions to return. Default 20, max 100.' },
      },
      required: ['token'],
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx) {
    return runWithGuards(
      OobCheckInteractions.meta,
      ctx,
      async () => {
        const session = getSessionFromContext(ctx);
        if (!session?.id || !session.userId) {
          return { ok: false, data: { error: 'Session identity is not available' } };
        }
        const parsed = isRecord(args) ? args : {};
        const token = optionalString(parsed.token);
        if (!token) {
          return { ok: false, data: { error: 'token is required' } };
        }
        const securityContext = resolveSecurityOpsToolContext(ctx);
        const result = await getOobService(ctx).checkInteractions({
          token,
          since: optionalString(parsed.since),
          limit: optionalNumber(parsed.limit),
          sessionId: session.id,
          userId: session.userId,
          organizationId: securityContext.organizationId,
          scopeId: securityContext.scopeId,
          workspaceDir: session.workspaceDir,
        });
        return { ok: !result.unavailable, data: result };
      },
      {},
      {},
    );
  },
};

export const tools: ToolModuleDefinition[] = [OobTokenCreate, OobCheckInteractions].map(fromToolImpl);
