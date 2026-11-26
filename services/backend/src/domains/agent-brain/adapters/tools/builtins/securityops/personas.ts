import { createHash } from 'crypto';

import { fromToolImpl } from '@/domains/agent-brain/application/tools/helpers';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import { getSessionFromContext } from '@/domains/agent-brain/application/tools/runtime/ToolContextSelectors';
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import type { ToolModuleDefinition } from '@/domains/agent-brain/application/tools/types';
import { getEnumerationWorkerUrlBlockReason } from '@/domains/agent-brain/domain/workers/enumerationRuntimeGuard';
import { executeHttpRequest } from '../../runtime/httpRequestExecutor';
import { findHttpHistoryEntry, type HttpHistoryEntry } from '../../runtime/httpHistory';
import { getPersonaService } from '../securityopsServiceRegistry';
import { resolveSecurityOpsToolContext } from '../securityopsContext';
import {
  formatToolError,
  getSecurityOpsFlags,
  getString,
  isRecord,
  pickToolArgsPreview,
  requireUserId,
  uniqueStrings,
} from './shared';

type ReplayPersonaAuth = {
  persona: string;
  personaId?: string;
  roleLabel?: string | null;
  kind: string;
  headers: Record<string, string>;
  appliedHeaderNames: string[];
  refreshProcedure: Record<string, unknown>;
};

type ReplayRow = {
  persona: string;
  personaId?: string;
  roleLabel?: string | null;
  kind: string;
  status_code: number | null;
  body_size: number;
  body_sha256: string;
  history_entry_id?: string;
  response_time_ms?: number;
  same_as_baseline?: boolean;
  blocked_like?: boolean;
  refresh?: {
    attempted: boolean;
    succeeded: boolean;
    history_entry_id?: string;
    error?: string;
  };
};

const AUTH_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
]);

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const getEnumerationMissionPersonaRefs = (
  session: ReturnType<typeof getSessionFromContext>,
): Set<string> | null => {
  if (
    session?.coordination?.role !== 'worker' ||
    session.coordination.workerType !== 'enumeration_worker'
  ) {
    return null;
  }
  const mission = isRecord(session.task?.vars?.mission)
    ? session.task?.vars?.mission
    : undefined;
  const enumeration = isRecord(mission?.enumeration) ? mission.enumeration : undefined;
  const refs = Array.isArray(enumeration?.personaRefs)
    ? enumeration.personaRefs.filter((value): value is string => typeof value === 'string')
    : [];
  return new Set(refs);
};

const toStringMap = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      out[key] = entry;
    }
  }
  return out;
};

const parseUrlOrNull = (rawUrl: string): URL | null => {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
};

const applyParamModifications = (rawUrl: string, params: Record<string, string>): string => {
  if (Object.keys(params).length === 0) {
    return rawUrl;
  }
  const url = parseUrlOrNull(rawUrl);
  if (!url) {
    return rawUrl;
  }
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
};

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const readDataRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

const readHistoryEntryId = (value: unknown): string | undefined => {
  const data = readDataRecord(value);
  return typeof data.history_entry_id === 'string' && data.history_entry_id.trim().length > 0
    ? data.history_entry_id
    : undefined;
};

const readStatusCode = (value: unknown): number | null => {
  const data = readDataRecord(value);
  return typeof data.status_code === 'number' && Number.isFinite(data.status_code)
    ? data.status_code
    : null;
};

const readExecutionError = (value: unknown): string => {
  const data = readDataRecord(value);
  return getString(data.error) ?? 'HTTP execution failed';
};

const omitAuthHeaders = (
  headers: Record<string, string>,
  extraSensitiveHeaders: ReadonlySet<string>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.trim().toLowerCase();
    if (
      normalized === 'content-length' ||
      AUTH_HEADER_NAMES.has(normalized) ||
      extraSensitiveHeaders.has(normalized) ||
      value.trim() === '[REDACTED]'
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
};

const isExpiredAuthStatus = (statusCode: number | null): boolean =>
  statusCode === 401 || statusCode === 419 || statusCode === 440;

const isBlockedStatus = (statusCode: number | null): boolean =>
  statusCode === 401 || statusCode === 403 || statusCode === 404;

const isSuccessStatus = (statusCode: number | null): boolean =>
  typeof statusCode === 'number' && statusCode >= 200 && statusCode < 400;

const getJsonPath = (value: unknown, path: string | undefined): unknown => {
  const normalized = typeof path === 'string' ? path.trim() : '';
  if (!normalized) return undefined;
  return normalized.split('.').reduce<unknown>((current, segment) => {
    if (!isRecord(current)) return undefined;
    return current[segment];
  }, value);
};

const refreshProcedureType = (procedure: Record<string, unknown>): string =>
  typeof procedure.type === 'string' ? procedure.type.trim().toLowerCase() : '';

const extractRefreshSecret = (
  kind: string,
  procedure: Record<string, unknown>,
  body: string,
): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const path =
    getString(procedure.secretJsonPath) ??
    (kind === 'bearer_token' ? getString(procedure.tokenJsonPath) : undefined) ??
    (kind === 'cookie_session' ? getString(procedure.cookieHeaderJsonPath) : undefined) ??
    (kind === 'custom_header' ? getString(procedure.headerValueJsonPath) : undefined);
  const value = getJsonPath(parsed, path);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
};

const buildVerdict = (
  rows: ReplayRow[],
  baselinePersona: string | undefined,
): { verdict: 'likely_access_control_anomaly' | 'no_access_control_anomaly' | 'needs_review'; reason: string } => {
  const baseline = rows.find((row) => row.persona === baselinePersona) ?? rows.find((row) => row.persona !== 'anonymous');
  if (!baseline) {
    return { verdict: 'needs_review', reason: 'No authenticated baseline persona was replayed.' };
  }
  if (!isSuccessStatus(baseline.status_code)) {
    return {
      verdict: 'needs_review',
      reason: `Baseline persona "${baseline.persona}" did not receive a successful response.`,
    };
  }

  const challengers = rows.filter((row) => row.persona !== baseline.persona);
  const anomalous = challengers.filter(
    (row) => isSuccessStatus(row.status_code) && row.body_sha256 === baseline.body_sha256,
  );
  if (anomalous.length > 0) {
    return {
      verdict: 'likely_access_control_anomaly',
      reason: `Baseline response was reproduced by ${anomalous.map((row) => row.persona).join(', ')}.`,
    };
  }

  if (challengers.length > 0 && challengers.every((row) => isBlockedStatus(row.status_code))) {
    return {
      verdict: 'no_access_control_anomaly',
      reason: 'All challenger personas were blocked or hidden relative to the baseline response.',
    };
  }

  return {
    verdict: 'needs_review',
    reason: 'Challenger responses differed from the baseline but were not uniformly blocked.',
  };
};

const requireSecurityOpsContext = (ctx: ToolContext): { orgId: string; scopeId: string } | { error: string } => {
  const context = resolveSecurityOpsToolContext(ctx);
  const orgId = context.organizationId;
  const scopeId = context.scopeId;
  if (!orgId || !scopeId) {
    return { error: 'organizationId and scopeId are required to use persona tools' };
  }
  return { orgId, scopeId };
};

export const PersonaSave: ToolImpl = {
  meta: {
    name: 'persona_save',
    description:
      'Create or update a named scope-bound test persona with encrypted HTTP/browser auth state. Tool results return metadata only; raw cookies, bearer tokens, headers, and storage state are never echoed.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        personaId: { type: 'string' },
        label: { type: 'string' },
        roleLabel: { type: 'string' },
        kind: { type: 'string', enum: ['custom_header', 'bearer_token', 'cookie_session', 'storage_state'] },
        username: { type: 'string' },
        headerName: { type: 'string' },
        headerValue: { type: 'string' },
        token: { type: 'string' },
        cookieHeader: { type: 'string' },
        storageStateJson: { type: 'string' },
        appliesToHosts: { type: 'array', items: { type: 'string' } },
        refreshProcedure: {
          type: 'object',
          description:
            'Optional refresh instructions. Supported type=http_request with url/method/body/headers/tokenJsonPath or cookieHeaderJsonPath; sensitive fields are encrypted and not projected.',
        },
        metadata: { type: 'object' },
      },
      required: ['label', 'kind'],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx) {
    return runWithGuards(PersonaSave.meta, ctx, async () => {
      const userId = requireUserId(ctx);
      if (!userId) {
        return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
      }
      const context = requireSecurityOpsContext(ctx);
      if ('error' in context) {
        return { ok: false, data: { error: context.error } };
      }
      try {
        const persona = await getPersonaService().saveForScope({
          orgId: context.orgId,
          scopeId: context.scopeId,
          actorUserId: userId,
          input: args,
        });
        return { ok: true, data: { success: true, persona } };
      } catch (error) {
        return { ok: false, data: { error: formatToolError(error) } };
      }
    }, {}, pickToolArgsPreview(args, ['personaId', 'label', 'roleLabel', 'kind', 'username', 'appliesToHosts']));
  },
};

export const PersonaList: ToolImpl = {
  meta: {
    name: 'persona_list',
    description: 'List scope-bound test personas by metadata only, including role labels, host applicability, and refresh availability.',
    category: 'securityops',
    schema: { type: 'object', properties: {} },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx) {
    return runWithGuards(PersonaList.meta, ctx, async () => {
      const userId = requireUserId(ctx);
      if (!userId) {
        return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
      }
      const context = requireSecurityOpsContext(ctx);
      if ('error' in context) {
        return { ok: false, data: { error: context.error } };
      }
      try {
        const personas = await getPersonaService().listForScope(context.orgId, context.scopeId);
        const missionPersonaRefs = getEnumerationMissionPersonaRefs(getSessionFromContext(ctx));
        const visiblePersonas = missionPersonaRefs
          ? personas.filter((persona) =>
              missionPersonaRefs.has(persona.id) || missionPersonaRefs.has(persona.label)
            )
          : personas;
        return { ok: true, data: { success: true, personas: visiblePersonas } };
      } catch (error) {
        return { ok: false, data: { error: formatToolError(error) } };
      }
    }, {}, pickToolArgsPreview(args, []));
  },
};

export const PersonaLoad: ToolImpl = {
  meta: {
    name: 'persona_load',
    description:
      'Mark a scope-bound persona as active for this run/session and validate optional target-host applicability without exposing the persona secret.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        persona: { type: 'string', description: 'Persona id or label.' },
        url: { type: 'string', description: 'Optional target URL used to enforce host applicability.' },
      },
      required: ['persona'],
    },
    // Loading changes only ephemeral session selection; it is not a canonical
    // or workspace write and must remain usable inside artifact-scoped workers.
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx) {
    return runWithGuards(PersonaLoad.meta, ctx, async () => {
      const userId = requireUserId(ctx);
      if (!userId) {
        return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
      }
      const context = requireSecurityOpsContext(ctx);
      if ('error' in context) {
        return { ok: false, data: { error: context.error } };
      }
      const personaRef = getString(isRecord(args) ? args.persona : undefined);
      if (!personaRef) {
        return { ok: false, data: { error: 'persona is required' } };
      }
      const session = getSessionFromContext(ctx);
      const missionPersonaRefs = getEnumerationMissionPersonaRefs(session);
      if (missionPersonaRefs && !missionPersonaRefs.has(personaRef)) {
        return {
          ok: false,
          data: {
            error: 'enumeration_worker persona_not_in_mission: only opaque personaRefs named by the mission may be loaded',
          },
        };
      }
      const targetUrl = getString(isRecord(args) ? args.url : undefined);
      if (missionPersonaRefs) {
        if (!targetUrl) {
          return {
            ok: false,
            data: { error: 'enumeration_worker persona_load requires the mission-scoped target url' },
          };
        }
        const scopeBlockReason = getEnumerationWorkerUrlBlockReason(session, targetUrl);
        if (scopeBlockReason) {
          return { ok: false, data: { error: scopeBlockReason } };
        }
      }
      try {
        const persona = await getPersonaService().loadForScope({
          orgId: context.orgId,
          scopeId: context.scopeId,
          persona: personaRef,
          url: targetUrl,
        });
        await ctx.sessionStore.mergeFlagNamespaceAsync(ctx.sessionId, 'securityops', {
          activePersona: {
            id: persona.id,
            label: persona.label,
            roleLabel: persona.roleLabel,
            kind: persona.kind,
            username: persona.username,
            appliesToHosts: persona.appliesToHosts,
            targetHost: persona.targetHost,
            loadedAt: new Date().toISOString(),
          },
        });
        return {
          ok: true,
          data: {
            success: true,
            loaded: true,
            persona,
            secretProjected: false,
          },
        };
      } catch (error) {
        return { ok: false, data: { error: formatToolError(error) } };
      }
    }, {}, pickToolArgsPreview(args, ['persona', 'url']));
  },
};

export const PersonaForget: ToolImpl = {
  meta: {
    name: 'persona_forget',
    description: 'Delete a scope-bound test persona and clear the active session persona when it matches.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        persona: { type: 'string', description: 'Persona id or label.' },
      },
      required: ['persona'],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx) {
    return runWithGuards(PersonaForget.meta, ctx, async () => {
      const userId = requireUserId(ctx);
      if (!userId) {
        return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
      }
      const context = requireSecurityOpsContext(ctx);
      if ('error' in context) {
        return { ok: false, data: { error: context.error } };
      }
      const personaRef = getString(isRecord(args) ? args.persona : undefined);
      if (!personaRef) {
        return { ok: false, data: { error: 'persona is required' } };
      }
      try {
        await getPersonaService().deleteForScope({
          orgId: context.orgId,
          scopeId: context.scopeId,
          persona: personaRef,
        });
        const securityops = getSecurityOpsFlags(getSessionFromContext(ctx));
        const activePersona = isRecord(securityops?.activePersona) ? securityops.activePersona : undefined;
        if (activePersona?.id === personaRef || activePersona?.label === personaRef) {
          await ctx.sessionStore.mergeFlagNamespaceAsync(ctx.sessionId, 'securityops', {
            activePersona: undefined,
          });
        }
        return { ok: true, data: { success: true, deleted: true } };
      } catch (error) {
        return { ok: false, data: { error: formatToolError(error) } };
      }
    }, {}, pickToolArgsPreview(args, ['persona']));
  },
};

const refreshPersona = async (params: {
  ctx: ToolContext;
  workspaceDir: string;
  orgId: string;
  scopeId: string;
  originalUrl: string;
  persona: ReplayPersonaAuth;
  maxBodyBytes?: number;
}): Promise<{ refreshed?: ReplayPersonaAuth; result: ReplayRow['refresh'] }> => {
  const procedure = params.persona.refreshProcedure;
  if (refreshProcedureType(procedure) !== 'http_request') {
    return {
      result: {
        attempted: true,
        succeeded: false,
        error: 'No supported http_request refresh procedure is configured for this persona.',
      },
    };
  }
  const url = getString(procedure.url) ?? params.originalUrl;
  const method = getString(procedure.method)?.toUpperCase() ?? 'POST';
  const headers = {
    ...(procedure.includePersonaAuth === false ? {} : params.persona.headers),
    ...toStringMap(procedure.headers),
  };
  const body = getString(procedure.body) ?? '';
  const refreshResult = await executeHttpRequest(
    {
      url,
      method,
      headers,
      body,
      follow_redirects: true,
      max_body_bytes: params.maxBodyBytes,
    },
    params.ctx,
    {
      toolName: 'authz_replay',
      modificationsApplied: {
        authz_replay_refresh: true,
        persona: params.persona.persona,
      },
      historyRequestBody: body ? '[refresh body omitted]' : '',
    },
  );
  if (!refreshResult.ok) {
    return {
      result: {
        attempted: true,
        succeeded: false,
        error: readExecutionError(refreshResult.data),
      },
    };
  }
  const historyEntryId = readHistoryEntryId(refreshResult.data);
  const historyEntry = historyEntryId
    ? await findHttpHistoryEntry(params.workspaceDir, historyEntryId)
    : undefined;
  const secret = extractRefreshSecret(params.persona.kind, procedure, historyEntry?.response_body ?? '');
  if (!secret || !params.persona.personaId) {
    return {
      result: {
        attempted: true,
        succeeded: false,
        ...(historyEntryId ? { history_entry_id: historyEntryId } : {}),
        error: 'Refresh response did not contain the configured replacement secret path.',
      },
    };
  }

  await getPersonaService().updatePersonaSecret({
    orgId: params.orgId,
    scopeId: params.scopeId,
    personaId: params.persona.personaId,
    secret,
  });
  const resolved = await getPersonaService().resolveHttpAuth({
    orgId: params.orgId,
    scopeId: params.scopeId,
    persona: params.persona.personaId,
    url: params.originalUrl,
  });
  return {
    refreshed: {
      persona: resolved.label,
      personaId: resolved.personaId,
      roleLabel: resolved.roleLabel,
      kind: resolved.kind,
      headers: resolved.headers,
      appliedHeaderNames: resolved.appliedHeaderNames,
      refreshProcedure: resolved.refreshProcedure,
    },
    result: {
      attempted: true,
      succeeded: true,
      ...(historyEntryId ? { history_entry_id: historyEntryId } : {}),
    },
  };
};

const replayAsPersona = async (params: {
  ctx: ToolContext;
  workspaceDir: string;
  entry: HttpHistoryEntry;
  persona: ReplayPersonaAuth;
  baseHeaders: Record<string, string>;
  url: string;
  body: string | undefined;
  modifications: Record<string, unknown>;
  timeout?: number;
  maxBodyBytes?: number;
}): Promise<ReplayRow> => {
  const modifiedHeaders = omitAuthHeaders(
    toStringMap(params.modifications.headers),
    new Set(params.persona.appliedHeaderNames.map((name) => name.toLowerCase())),
  );
  const headers = {
    ...params.baseHeaders,
    ...modifiedHeaders,
    ...params.persona.headers,
  };
  const result = await executeHttpRequest(
    {
      url: params.url,
      method: params.entry.request.method,
      headers,
      body: params.body,
      timeout: params.timeout,
      follow_redirects: params.entry.request.options?.follow_redirects,
      insecure: params.entry.request.options?.insecure,
      max_body_bytes: params.maxBodyBytes,
    },
    params.ctx,
    {
      toolName: 'authz_replay',
      replayedFrom: params.entry.id,
      modificationsApplied: {
        authz_replay: true,
        persona: params.persona.persona,
        modifications: params.modifications,
      },
    },
  );
  if (!result.ok) {
    throw new Error(readExecutionError(result.data));
  }
  const historyEntryId = readHistoryEntryId(result.data);
  const stored = historyEntryId
    ? await findHttpHistoryEntry(params.workspaceDir, historyEntryId)
    : undefined;
  const body = stored?.response_body ?? getString(readDataRecord(result.data).body_preview) ?? '';
  const statusCode = stored?.status_code ?? readStatusCode(result.data);
  const data = readDataRecord(result.data);

  return {
    persona: params.persona.persona,
    ...(params.persona.personaId ? { personaId: params.persona.personaId } : {}),
    roleLabel: params.persona.roleLabel ?? null,
    kind: params.persona.kind,
    status_code: statusCode,
    body_size:
      typeof stored?.body_size === 'number'
        ? stored.body_size
        : typeof data.body_size === 'number'
          ? data.body_size
          : Buffer.byteLength(body, 'utf8'),
    body_sha256: sha256(body),
    ...(historyEntryId ? { history_entry_id: historyEntryId } : {}),
    ...(typeof data.response_time_ms === 'number' ? { response_time_ms: data.response_time_ms } : {}),
  };
};

export const AuthzReplay: ToolImpl = {
  meta: {
    name: 'authz_replay',
    description:
      'Replay a captured normal HTTP request as named personas and/or anonymous to detect authorization boundary failures. Returns a status/size/body-hash matrix and stores each replay in HTTP history for durable evidence.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        personas: { type: 'array', items: { type: 'string' }, description: 'Persona labels or ids to replay.' },
        baselinePersona: { type: 'string', description: 'Persona label/id expected to be authorized.' },
        includeAnonymous: { type: 'boolean', default: true },
        allow_state_changing: {
          type: 'boolean',
          default: false,
          description: 'Required to replay POST/PUT/PATCH/DELETE captures because they can mutate target state.',
        },
        modifications: {
          type: 'object',
          properties: {
            headers: { type: 'object', additionalProperties: { type: 'string' } },
            params: { type: 'object', additionalProperties: { type: 'string' } },
            body: { type: 'string' },
          },
        },
        timeout: { type: 'number' },
        max_body_bytes: { type: 'number' },
      },
      required: ['request_id'],
    },
    risks: ['network', 'read'],
    returns: 'json',
  },

  async run(args, ctx) {
    return runWithGuards(AuthzReplay.meta, ctx, async () => {
      const userId = requireUserId(ctx);
      if (!userId) {
        return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
      }
      const context = requireSecurityOpsContext(ctx);
      if ('error' in context) {
        return { ok: false, data: { error: context.error } };
      }

      const session = getSessionFromContext(ctx);
      const enumerationWorker =
        session?.coordination?.role === 'worker' &&
        session.coordination.workerType === 'enumeration_worker';
      const workspaceDir = session?.workspaceDir || ctx.workspaceDir;
      const requestId = getString(isRecord(args) ? args.request_id : undefined);
      if (!workspaceDir || !requestId) {
        return { ok: false, data: { error: 'workspace and request_id are required' } };
      }

      try {
        const entry = await findHttpHistoryEntry(workspaceDir, requestId);
        if (!entry) {
          return {
            ok: false,
            data: {
              error:
                `HTTP history entry ${requestId} was not found. authz_replay currently supports normal http_payload/http_repeat captures, not raw byte captures.`,
            },
          };
        }
        const scopeBlockReason = getEnumerationWorkerUrlBlockReason(session, entry.request.url);
        if (scopeBlockReason) {
          return { ok: false, data: { error: scopeBlockReason } };
        }

        const method = entry.request.method.toUpperCase();
        if (
          session?.coordination?.role === 'worker' &&
          session.coordination.workerType === 'enumeration_worker' &&
          STATE_CHANGING_METHODS.has(method)
        ) {
          return {
            ok: false,
            data: {
              error: `enumeration_worker state_change_denied: ${method} authz replay is never allowed`,
            },
          };
        }
        if (STATE_CHANGING_METHODS.has(method) && (!isRecord(args) || args.allow_state_changing !== true)) {
          return {
            ok: false,
            data: {
              error:
                `Refusing to replay state-changing ${method} request without allow_state_changing=true.`,
            },
          };
        }

        const securityopsFlags = getSecurityOpsFlags(session);
        const activePersona = isRecord(securityopsFlags?.activePersona)
          ? securityopsFlags.activePersona
          : undefined;
        const explicitPersonas = Array.isArray(isRecord(args) ? args.personas : undefined)
          ? (args.personas as unknown[]).filter((value): value is string => typeof value === 'string')
          : [];
        const baselinePersona = getString(isRecord(args) ? args.baselinePersona : undefined);
        const activePersonaRef = getString(activePersona?.id) ?? getString(activePersona?.label);
        const personaRefs = uniqueStrings([
          ...(baselinePersona ? [baselinePersona] : []),
          ...explicitPersonas,
          ...(explicitPersonas.length === 0 && activePersonaRef ? [activePersonaRef] : []),
        ]);
        const missionPersonaRefs = getEnumerationMissionPersonaRefs(session);
        const foreignPersonaRef = missionPersonaRefs
          ? personaRefs.find((personaRef) => !missionPersonaRefs.has(personaRef))
          : undefined;
        if (foreignPersonaRef) {
          return {
            ok: false,
            data: {
              error: `enumeration_worker persona_not_in_mission: ${foreignPersonaRef}`,
            },
          };
        }
        const includeAnonymous = !isRecord(args) || args.includeAnonymous !== false;
        if (personaRefs.length === 0 && !includeAnonymous) {
          return { ok: false, data: { error: 'At least one persona or includeAnonymous=true is required' } };
        }

        const service = getPersonaService();
        const resolvedPersonas: ReplayPersonaAuth[] = [];
        for (const personaRef of personaRefs) {
          const resolved = await service.resolveHttpAuth({
            orgId: context.orgId,
            scopeId: context.scopeId,
            persona: personaRef,
            url: entry.request.url,
          });
          resolvedPersonas.push({
            persona: resolved.label,
            personaId: resolved.personaId,
            roleLabel: resolved.roleLabel,
            kind: resolved.kind,
            headers: resolved.headers,
            appliedHeaderNames: resolved.appliedHeaderNames,
            refreshProcedure: resolved.refreshProcedure,
          });
        }
        if (includeAnonymous) {
          resolvedPersonas.push({
            persona: 'anonymous',
            kind: 'anonymous',
            headers: {},
            appliedHeaderNames: [],
            refreshProcedure: {},
          });
        }

        const sensitiveHeaders = new Set<string>(
          resolvedPersonas.flatMap((persona) => persona.appliedHeaderNames.map((name) => name.toLowerCase())),
        );
        const modifications = isRecord(args?.modifications) ? args.modifications : {};
        const url = applyParamModifications(entry.request.url, toStringMap(modifications.params));
        const body = typeof modifications.body === 'string' ? modifications.body : entry.request.body;
        const baseHeaders = omitAuthHeaders(entry.request.headers, sensitiveHeaders);
        const rows: ReplayRow[] = [];
        const maxBodyBytes = typeof args?.max_body_bytes === 'number' ? args.max_body_bytes : undefined;
        const timeout = typeof args?.timeout === 'number' ? args.timeout : entry.request.options?.timeout;

        for (const persona of resolvedPersonas) {
          let row = await replayAsPersona({
            ctx,
            workspaceDir,
            entry,
            persona,
            baseHeaders,
            url,
            body,
            modifications,
            timeout,
            maxBodyBytes,
          });

          if (
            !enumerationWorker &&
            persona.persona !== 'anonymous' &&
            isExpiredAuthStatus(row.status_code)
          ) {
            const refresh = await refreshPersona({
              ctx,
              workspaceDir,
              orgId: context.orgId,
              scopeId: context.scopeId,
              originalUrl: entry.request.url,
              persona,
              maxBodyBytes,
            });
            if (refresh.refreshed) {
              row = await replayAsPersona({
                ctx,
                workspaceDir,
                entry,
                persona: refresh.refreshed,
                baseHeaders,
                url,
                body,
                modifications,
                timeout,
                maxBodyBytes,
              });
            }
            row.refresh = refresh.result;
          }
          rows.push(row);
        }

        const resolvedBaseline =
          rows.find((row) => row.personaId === baselinePersona || row.persona === baselinePersona)?.persona ??
          rows.find((row) => row.persona !== 'anonymous')?.persona;
        const baseline = rows.find((row) => row.persona === resolvedBaseline);
        for (const row of rows) {
          if (!baseline || row.persona === baseline.persona) continue;
          row.same_as_baseline = row.body_sha256 === baseline.body_sha256;
          row.blocked_like = isBlockedStatus(row.status_code);
        }
        const verdict = buildVerdict(rows, resolvedBaseline);

        return {
          ok: true,
          data: {
            success: true,
            request: {
              id: entry.id,
              method: entry.request.method,
              url,
            },
            baselinePersona: resolvedBaseline,
            matrix: rows,
            verdict: verdict.verdict,
            reason: verdict.reason,
            evidenceIds: rows
              .map((row) => row.history_entry_id)
              .filter((value): value is string => typeof value === 'string' && value.length > 0),
          },
        };
      } catch (error) {
        return { ok: false, data: { error: formatToolError(error) } };
      }
    }, {}, pickToolArgsPreview(args, ['request_id', 'personas', 'baselinePersona', 'includeAnonymous', 'allow_state_changing']));
  },
};

export const tools: ToolModuleDefinition[] = [
  PersonaSave,
  PersonaList,
  PersonaLoad,
  PersonaForget,
  AuthzReplay,
].map(fromToolImpl);
