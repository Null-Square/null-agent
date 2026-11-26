import type { EnumerationMissionV1, SessionState } from '../types';

export interface EnumerationRuntimeGuardDecision {
  requestCost: number;
  requestConcurrency: number;
  blockedReason?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asMethod = (value: unknown): string =>
  typeof value === 'string' && value.trim().length > 0
    ? value.trim().toUpperCase()
    : 'GET';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT']);
const POC_PROHIBITED_METHODS = new Set(['DELETE', 'CONNECT']);
const LOCAL_SHELL_COMMANDS = new Set([
  'base64',
  'comm',
  'cut',
  'diff',
  'file',
  'grep',
  'head',
  'hexdump',
  'jq',
  'ls',
  'printf',
  'pwd',
  'rg',
  'sha1sum',
  'sha256sum',
  'shasum',
  'sort',
  'stat',
  'strings',
  'tail',
  'tr',
  'uniq',
  'wc',
  'xxd',
]);
const NETWORK_PYTHON_PATTERN =
  /\b(?:requests|httpx|aiohttp|urllib|socket|websocket|ftplib|smtplib|paramiko|subprocess|importlib|ctypes|raw_send|replay|oob|eval|exec|compile|__import__|getattr|setattr|globals|locals|vars|open)\b|__|https?:\/\/|wss?:\/\//iu;

const shellLocalOnlyBlockReason = (command: string): string | undefined => {
  if (!command.trim()) {
    return undefined;
  }
  if (/[\r\n;&`$<>]|\|\|/u.test(command)) {
    return 'shell control operators, expansion, and redirection are disabled';
  }
  for (const segment of command.split('|')) {
    const executable = segment.trim().split(/\s+/u)[0] ?? '';
    const basename = executable.replace(/\\/gu, '/').split('/').pop()?.toLowerCase() ?? '';
    if (!LOCAL_SHELL_COMMANDS.has(basename)) {
      return `${basename || '(missing command)'} is not an approved local parser`;
    }
  }
  return undefined;
};

const rawHttpMethods = (args: Record<string, unknown>): string[] => {
  const requests = Array.isArray(args.requests) ? args.requests : [];
  const rawRequests = [
    args.raw_request,
    args.rawRequest,
    ...requests.flatMap((entry) =>
      isRecord(entry) ? [entry.raw_request, entry.rawRequest] : [entry]
    ),
  ];
  return rawRequests
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().split(/\s+/u)[0]?.toUpperCase() ?? '')
    .filter(Boolean);
};

const getEnumerationMission = (session: SessionState | undefined): EnumerationMissionV1 | undefined => {
  const envelope = session?.task?.vars?.mission;
  if (!isRecord(envelope) || !isRecord(envelope.enumeration)) {
    return undefined;
  }
  return envelope.enumeration as unknown as EnumerationMissionV1;
};

const hasBoundedPocAuthority = (session: SessionState | undefined): boolean => {
  const securityops = isRecord(session?.flags?.securityops) ? session.flags.securityops : {};
  return securityops.enumerationImpactTolerance === 'poc' || securityops.enumerationImpactTolerance === 'full';
};

const stateChangingMethodDenied = (
  session: SessionState | undefined,
  method: string,
): boolean => STATE_CHANGING_METHODS.has(method) &&
  (!hasBoundedPocAuthority(session) || POC_PROHIBITED_METHODS.has(method));

const parseHttpUrl = (value: string): URL | undefined => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const normalizedTargetOrigin = (targetRef: string): { hostname: string; port?: string; protocol?: string } | undefined => {
  const parsed = parseHttpUrl(targetRef.includes('://') ? targetRef : `https://${targetRef}`);
  if (!parsed) {
    return undefined;
  }
  return {
    hostname: parsed.hostname.toLowerCase(),
    ...(parsed.port ? { port: parsed.port } : {}),
    ...(targetRef.includes('://') ? { protocol: parsed.protocol } : {}),
  };
};

const refPath = (ref: string): string => {
  const withoutMethod = ref.trim().replace(/^[A-Z]+\s+/iu, '');
  const parsed = parseHttpUrl(withoutMethod);
  return (parsed ? parsed.pathname : withoutMethod.split(/[?#]/u)[0] || '/').replace(/\/+$/u, '') || '/';
};

const pathMatchesRef = (candidatePath: string, allowedPath: string): boolean => {
  if (candidatePath === allowedPath) {
    return true;
  }
  const escaped = allowedPath
    .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    .replace(/\\\{[^}]+\\\}/gu, '[^/]+');
  return new RegExp(`^${escaped}$`, 'u').test(candidatePath);
};

export const getEnumerationWorkerUrlBlockReason = (
  session: SessionState | undefined,
  rawUrl: string,
): string | undefined => {
  if (session?.coordination?.role !== 'worker' || session.coordination.workerType !== 'enumeration_worker') {
    return undefined;
  }
  const mission = getEnumerationMission(session);
  if (!mission) {
    return 'enumeration_worker mission_scope_missing';
  }
  if (mission.surface.kind === 'repository_path_set') {
    return 'enumeration_worker target_scope_denied: repository-path missions cannot issue target network requests';
  }
  const url = parseHttpUrl(rawUrl);
  const target = normalizedTargetOrigin(mission.targetRef);
  if (
    !url ||
    !target ||
    url.hostname.toLowerCase() !== target.hostname ||
    (target.port !== undefined && url.port !== target.port) ||
    (target.protocol !== undefined && url.protocol !== target.protocol)
  ) {
    return `enumeration_worker target_scope_denied: ${rawUrl || '(missing URL)'}`;
  }

  if (mission.surface.kind === 'component') {
    return undefined;
  }
  const candidatePath = url.pathname.replace(/\/+$/u, '') || '/';
  const allowedPaths = mission.surface.refs.map(refPath);
  const allowed =
    mission.surface.kind === 'path_prefix_set'
      ? allowedPaths.some((prefix) =>
          candidatePath === prefix || candidatePath.startsWith(`${prefix === '/' ? '' : prefix}/`)
        )
      : allowedPaths.some((allowedPath) => pathMatchesRef(candidatePath, allowedPath));
  return allowed
    ? undefined
    : `enumeration_worker surface_scope_denied: ${candidatePath} is outside ${mission.surface.kind}`;
};

const targetUrlFromRawRequest = (
  rawRequest: string,
  baseUrl: string,
): string | undefined => {
  const requestLine = rawRequest.trimStart().split(/\r?\n/u)[0]?.trim() ?? '';
  const requestTarget = requestLine.split(/\s+/u)[1];
  if (!requestTarget) {
    return undefined;
  }
  if (/^https?:\/\//iu.test(requestTarget)) {
    return requestTarget;
  }
  const host = rawRequest.match(/(?:^|\r?\n)host\s*:\s*([^\r\n]+)/iu)?.[1]?.trim();
  try {
    const base = new URL(baseUrl);
    return new URL(
      requestTarget,
      host ? `${base.protocol}//${host}` : base,
    ).toString();
  } catch {
    return undefined;
  }
};

const targetUrlsForTool = (toolName: string, args: Record<string, unknown>): string[] => {
  if (toolName === 'http_differential') {
    const url = typeof args.url_template === 'string'
      ? args.url_template.replace(/\{[^}]+\}/gu, 'bounded-value')
      : typeof args.url === 'string'
        ? args.url
        : undefined;
    return url ? [url] : [];
  }
  if (toolName === 'http_payload' || toolName === 'http_raw_send') {
    const baseUrl = typeof args.url === 'string' ? args.url : '';
    const rawRequests = toolName === 'http_raw_send' && Array.isArray(args.requests)
      ? args.requests.flatMap((entry) =>
          isRecord(entry)
            ? [
                typeof entry.raw_request === 'string'
                  ? entry.raw_request
                  : typeof entry.rawRequest === 'string'
                    ? entry.rawRequest
                    : undefined,
              ]
            : []
        )
      : [
          typeof args.raw_request === 'string'
            ? args.raw_request
            : typeof args.rawRequest === 'string'
              ? args.rawRequest
              : undefined,
        ];
    const rawTargets = rawRequests
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => targetUrlFromRawRequest(entry, baseUrl))
      .filter((entry): entry is string => typeof entry === 'string');
    return rawTargets.length > 0 ? rawTargets : baseUrl ? [baseUrl] : [];
  }
  if (toolName === 'browser_action') {
    return typeof args.url === 'string' ? [args.url] : [];
  }
  return [];
};

const repositoryScopeBlockReason = (
  session: SessionState | undefined,
  toolName: string,
  args: Record<string, unknown>,
): string | undefined => {
  if (
    !['list_connected_repositories', 'search_connected_repository', 'read_connected_repository_file'].includes(
      toolName,
    )
  ) {
    return undefined;
  }
  const mission = getEnumerationMission(session);
  if (!mission) {
    return 'enumeration_worker mission_scope_missing';
  }
  if (mission.sourceMode !== 'whitebox') {
    return 'enumeration_worker repository_scope_denied: repository tools require whitebox source mode';
  }
  if (mission.surface.kind !== 'repository_path_set' || toolName === 'list_connected_repositories') {
    return undefined;
  }
  const repository = typeof args.repository === 'string' ? args.repository.trim() : '';
  if (repository.toLowerCase() !== mission.targetRef.trim().toLowerCase()) {
    return `enumeration_worker repository_scope_denied: ${repository || '(missing repository)'}`;
  }
  if (toolName === 'read_connected_repository_file') {
    const candidate = typeof args.path === 'string'
      ? args.path.trim().replace(/\\/gu, '/').replace(/^\/+/u, '')
      : '';
    const allowed = mission.surface.refs.some(
      (ref) => candidate === ref || candidate.startsWith(`${ref}/`),
    );
    return allowed
      ? undefined
      : `enumeration_worker repository_path_denied: ${candidate || '(missing path)'}`;
  }
  const query = typeof args.query === 'string' ? args.query : '';
  const hasBoundedPathQualifier = mission.surface.refs.some(
    (ref) => query.includes(`path:${ref}`) || query.includes(`path:"${ref}"`),
  );
  return hasBoundedPathQualifier
    ? undefined
    : 'enumeration_worker repository_search_denied: query must include an allowed path: qualifier';
};

const resolveRequestCost = (
  toolName: string,
  args: Record<string, unknown>,
): { cost: number; concurrency: number } => {
  switch (toolName) {
    case 'http_payload':
    case 'http_repeat':
      return { cost: 1, concurrency: 1 };
    case 'http_raw_send': {
      const requests = Array.isArray(args.requests) ? args.requests.length : 1;
      return { cost: Math.max(1, requests), concurrency: 1 };
    }
    case 'http_differential': {
      const variants = Array.isArray(args.values) ? args.values.length : 0;
      const concurrency =
        typeof args.concurrency === 'number' && Number.isFinite(args.concurrency)
          ? Math.max(1, Math.floor(args.concurrency))
          : 1;
      return { cost: Math.max(1, variants + 1), concurrency };
    }
    case 'authz_replay': {
      const personas = Array.isArray(args.personas)
        ? new Set(args.personas.filter((entry): entry is string => typeof entry === 'string')).size
        : 0;
      const baseline = typeof args.baselinePersona === 'string' ? 1 : 0;
      const anonymous = args.includeAnonymous === false ? 0 : 1;
      return { cost: Math.max(1, personas + baseline + anonymous), concurrency: 1 };
    }
    case 'browser_action': {
      const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
      return ['launch', 'navigate'].includes(action)
        ? { cost: 4, concurrency: 1 }
        : { cost: 0, concurrency: 0 };
    }
    default:
      return { cost: 0, concurrency: 0 };
  }
};

export const assessEnumerationWorkerToolUse = (
  session: SessionState | undefined,
  toolName: string,
  rawArgs: unknown,
  now: number = Date.now(),
): EnumerationRuntimeGuardDecision => {
  if (session?.coordination?.role !== 'worker' || session.coordination.workerType !== 'enumeration_worker') {
    return { requestCost: 0, requestConcurrency: 0 };
  }
  const args = isRecord(rawArgs) ? rawArgs : {};
  if (session.coordination.deadlineAt && now >= session.coordination.deadlineAt) {
    return {
      requestCost: 0,
      requestConcurrency: 0,
      blockedReason: 'enumeration_worker wall_timeout: the mission deadline has elapsed',
    };
  }

  if (
    ['http_payload', 'http_repeat', 'http_differential'].includes(toolName) &&
    stateChangingMethodDenied(session, asMethod(args.method))
  ) {
    return {
      requestCost: 0,
      requestConcurrency: 0,
      blockedReason: `enumeration_worker state_change_denied: ${asMethod(args.method)} is not allowed`,
    };
  }
  if (
    toolName === 'http_raw_send' &&
    rawHttpMethods(args).some((method) => stateChangingMethodDenied(session, method))
  ) {
    return {
      requestCost: 0,
      requestConcurrency: 0,
      blockedReason: 'enumeration_worker state_change_denied: raw state-changing requests are not allowed',
    };
  }
  if (
    toolName === 'http_raw_send' &&
    (
      typeof args.raw_request_base64 === 'string' ||
      typeof args.rawRequestBase64 === 'string' ||
      (Array.isArray(args.requests) && args.requests.some((entry) =>
        isRecord(entry) &&
        (typeof entry.raw_request_base64 === 'string' || typeof entry.rawRequestBase64 === 'string')
      ))
    )
  ) {
    return {
      requestCost: 0,
      requestConcurrency: 0,
      blockedReason: 'enumeration_worker opaque_raw_request_denied: base64 request methods cannot be safety-inspected',
    };
  }
  if (toolName === 'http_payload') {
    const rawRequest =
      typeof args.raw_request === 'string'
        ? args.raw_request
        : typeof args.rawRequest === 'string'
          ? args.rawRequest
          : undefined;
    const rawMethod = rawRequest?.trim().split(/\s+/u)[0]?.toUpperCase();
    if (rawMethod && stateChangingMethodDenied(session, rawMethod)) {
      return {
        requestCost: 0,
        requestConcurrency: 0,
        blockedReason: `enumeration_worker state_change_denied: raw ${rawMethod} is not allowed`,
      };
    }
  }
  if (toolName === 'authz_replay' && args.allow_state_changing === true) {
    return {
      requestCost: 0,
      requestConcurrency: 0,
      blockedReason: 'enumeration_worker state_change_denied: allow_state_changing must be false',
    };
  }
  if (toolName === 'browser_action') {
    const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
    if (
      !hasBoundedPocAuthority(session) &&
      ['click', 'type', 'submit', 'execute_js', 'load_state', 'save_state'].includes(action)
    ) {
      return {
        requestCost: 0,
        requestConcurrency: 0,
        blockedReason: `enumeration_worker browser_state_change_denied: ${action}`,
      };
    }
  }
  if (toolName === 'shell_run') {
    const command =
      typeof args.command === 'string'
        ? args.command
        : typeof args.cmd === 'string'
          ? args.cmd
          : '';
    const localOnlyBlockReason = shellLocalOnlyBlockReason(command);
    if (localOnlyBlockReason) {
      return {
        requestCost: 0,
        requestConcurrency: 0,
        blockedReason:
          `enumeration_worker unmetered_network_denied: ${localOnlyBlockReason}; use the scoped HTTP/browser tools for target traffic`,
      };
    }
  }
  if (toolName === 'python_session') {
    const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : 'exec';
    if (action === 'replay' || action === 'replay_poc') {
      return {
        requestCost: 0,
        requestConcurrency: 0,
        blockedReason:
          `enumeration_worker unmetered_network_denied: Python ${action} is disabled; use the scoped HTTP tools`,
      };
    }
    const code = typeof args.code === 'string' ? args.code : '';
    if (NETWORK_PYTHON_PATTERN.test(code)) {
      return {
        requestCost: 0,
        requestConcurrency: 0,
        blockedReason:
          'enumeration_worker unmetered_network_denied: Python target traffic is disabled; use Python for local parsing or replay only',
      };
    }
  }

  const repositoryBlockReason = repositoryScopeBlockReason(session, toolName, args);
  if (repositoryBlockReason) {
    return {
      requestCost: 0,
      requestConcurrency: 0,
      blockedReason: repositoryBlockReason,
    };
  }

  const targetUrls = targetUrlsForTool(toolName, args);
  for (const targetUrl of targetUrls) {
    const scopeBlockReason = getEnumerationWorkerUrlBlockReason(session, targetUrl);
    if (scopeBlockReason) {
      return {
        requestCost: 0,
        requestConcurrency: 0,
        blockedReason: scopeBlockReason,
      };
    }
  }

  const { cost, concurrency } = resolveRequestCost(toolName, args);
  if (
    cost > 0 &&
    ['browser_action', 'http_differential', 'http_payload', 'http_raw_send'].includes(toolName) &&
    targetUrls.length === 0
  ) {
    return {
      requestCost: cost,
      requestConcurrency: concurrency,
      blockedReason: 'enumeration_worker target_scope_denied: target URL is required',
    };
  }
  const used = session.coordination.targetRequestsUsed ?? 0;
  const max = session.coordination.maxTargetRequests ?? 0;
  if (cost > 0 && (max <= 0 || used + cost > max)) {
    return {
      requestCost: cost,
      requestConcurrency: concurrency,
      blockedReason:
        `enumeration_worker request_budget_exhausted: ${used}/${max} used and ${cost} requested`,
    };
  }
  const active = session.coordination.activeTargetRequests ?? 0;
  const maxConcurrency = session.coordination.maxRequestConcurrency ?? 0;
  if (concurrency > 0 && (maxConcurrency <= 0 || active + concurrency > maxConcurrency)) {
    return {
      requestCost: cost,
      requestConcurrency: concurrency,
      blockedReason:
        `enumeration_worker request_concurrency_denied: ${active}/${maxConcurrency} active and ${concurrency} requested`,
    };
  }
  return { requestCost: cost, requestConcurrency: concurrency };
};
