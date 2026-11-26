import type { AttackMissionV1 } from './attackContracts';
import type { SessionState } from '../types';

export interface AttackRuntimeGuardDecision {
  requestCost: number;
  requestConcurrency: number;
  targetCapable: boolean;
  blockedReason?: string;
}

const TARGET_CAPABLE_TOOLS = new Set([
  'shell_run',
  'python_session',
  'http_payload',
  'http_raw_send',
  'http_differential',
  'http_list',
  'http_view',
  'http_repeat',
  'http_sitemap',
  'browser_action',
  'authz_replay',
  'oob_token_create',
  'oob_check_interactions',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const getAttackMission = (
  session: SessionState | undefined,
): AttackMissionV1 | undefined => {
  const envelope = session?.task?.vars?.mission;
  if (!isRecord(envelope) || !isRecord(envelope.attack)) return undefined;
  return envelope.attack as unknown as AttackMissionV1;
};

const parseTarget = (value: string): URL | undefined => {
  try {
    return new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    return undefined;
  }
};

const explicitUrls = (toolName: string, args: Record<string, unknown>): string[] => {
  const values: string[] = [];
  for (const key of ['url', 'uri', 'baseUrl', 'base_url', 'target']) {
    if (typeof args[key] === 'string') values.push(args[key] as string);
  }
  if (toolName === 'http_raw_send' && Array.isArray(args.requests)) {
    for (const entry of args.requests) {
      if (isRecord(entry) && typeof entry.url === 'string') values.push(entry.url);
    }
  }
  if (toolName === 'shell_run' || toolName === 'python_session') {
    const text = [
      typeof args.command === 'string' ? args.command : '',
      typeof args.cmd === 'string' ? args.cmd : '',
      typeof args.code === 'string' ? args.code : '',
    ].join('\n');
    values.push(...(text.match(/https?:\/\/[^\s"'`)<>\]]+/giu) ?? []));
  }
  return values;
};

const targetBlockReason = (
  mission: AttackMissionV1,
  candidate: string,
): string | undefined => {
  const expected = parseTarget(mission.targetRef);
  const actual = parseTarget(candidate);
  if (
    !expected ||
    !actual ||
    expected.hostname.toLowerCase() !== actual.hostname.toLowerCase() ||
    (expected.port && expected.port !== actual.port) ||
    (mission.targetRef.includes('://') && expected.protocol !== actual.protocol)
  ) {
    return `attack_worker target_scope_denied: ${candidate || '(missing target)'}`;
  }
  if (
    mission.boundedPaths &&
    mission.boundedPaths.length > 0 &&
    !mission.boundedPaths.some((path) =>
      actual.pathname === path ||
      actual.pathname.startsWith(`${path.replace(/\/+$/u, '')}/`))
  ) {
    return `attack_worker path_scope_denied: ${actual.pathname}`;
  }
  return undefined;
};

const requestCost = (
  toolName: string,
  args: Record<string, unknown>,
): { cost: number; concurrency: number } => {
  if (!TARGET_CAPABLE_TOOLS.has(toolName)) return { cost: 0, concurrency: 0 };
  if (toolName === 'http_raw_send') {
    return { cost: Math.max(1, Array.isArray(args.requests) ? args.requests.length : 1), concurrency: 1 };
  }
  if (toolName === 'http_differential') {
    const variants = Array.isArray(args.values) ? args.values.length + 1 : 1;
    const concurrency =
      typeof args.concurrency === 'number' && Number.isFinite(args.concurrency)
        ? Math.max(1, Math.floor(args.concurrency))
        : 1;
    return { cost: Math.max(1, variants), concurrency };
  }
  if (toolName === 'authz_replay') {
    const personas = Array.isArray(args.personas) ? args.personas.length : 1;
    return { cost: Math.max(1, personas + (args.includeAnonymous === false ? 0 : 1)), concurrency: 1 };
  }
  if (toolName === 'browser_action') {
    const action = typeof args.action === 'string' ? args.action.toLowerCase() : '';
    return { cost: action === 'launch' || action === 'navigate' ? 4 : 1, concurrency: 1 };
  }
  return { cost: 1, concurrency: 1 };
};

export const assessAttackWorkerToolUse = (
  session: SessionState | undefined,
  toolName: string,
  rawArgs: unknown,
  now: number = Date.now(),
): AttackRuntimeGuardDecision => {
  if (
    session?.coordination?.role !== 'worker' ||
    session.coordination.workerType !== 'attack_worker'
  ) {
    return { requestCost: 0, requestConcurrency: 0, targetCapable: false };
  }
  const targetCapable = TARGET_CAPABLE_TOOLS.has(toolName);
  if (!targetCapable) {
    return { requestCost: 0, requestConcurrency: 0, targetCapable: false };
  }
  if (session.coordination.deadlineAt && now >= session.coordination.deadlineAt) {
    return {
      requestCost: 0,
      requestConcurrency: 0,
      targetCapable,
      blockedReason: 'attack_worker wall_timeout: the mission deadline has elapsed',
    };
  }
  const mission = getAttackMission(session);
  if (!mission) {
    return {
      requestCost: 0,
      requestConcurrency: 0,
      targetCapable,
      blockedReason: 'attack_worker mission_missing',
    };
  }
  const args = isRecord(rawArgs) ? rawArgs : {};
  for (const candidate of explicitUrls(toolName, args)) {
    const reason = targetBlockReason(mission, candidate);
    if (reason) {
      return { requestCost: 0, requestConcurrency: 0, targetCapable, blockedReason: reason };
    }
  }
  const { cost, concurrency } = requestCost(toolName, args);
  const maxRequests = session.coordination.maxTargetRequests ?? mission.requestBudget;
  const usedRequests = session.coordination.targetRequestsUsed ?? 0;
  if (usedRequests + cost > maxRequests) {
    return {
      requestCost: cost,
      requestConcurrency: concurrency,
      targetCapable,
      blockedReason: 'attack_worker target_request_budget_exhausted',
    };
  }
  const maxConcurrency = session.coordination.maxRequestConcurrency ?? mission.maxRequestConcurrency;
  const activeConcurrency = session.coordination.activeTargetRequests ?? 0;
  if (concurrency > maxConcurrency || activeConcurrency + concurrency > maxConcurrency) {
    return {
      requestCost: cost,
      requestConcurrency: concurrency,
      targetCapable,
      blockedReason: 'attack_worker target_concurrency_exhausted',
    };
  }
  return { requestCost: cost, requestConcurrency: concurrency, targetCapable };
};

