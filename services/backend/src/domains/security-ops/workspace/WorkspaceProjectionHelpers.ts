import { normalizeWorkspaceRelativePath } from './WorkspaceFilePort';
import type {
  CoverageProjection,
  LeadPriorityScore,
  ProjectRunWorkspaceInput,
  ProjectionEnvelope,
  ProjectionScope,
  ReconProjection,
} from './WorkspaceProjectionTypes';

const OWNED_FILES = new Set([
  'AGENTS.md',
  '.artifacts/README.md',
  'context/scope.json',
  'context/organization.md',
  'context/scope.md',
  'context/roe.md',
  'context/execution.md',
  'context/access.md',
  'context/access-materials.md',
  'context/prior-runs.md',
  'recon/assets.json',
  'recon/services.json',
  'recon/endpoints.json',
  'recon/technologies.json',
  'recon/graph.json',
  'recon/surface.md',
  'journal/model.json',
  'journal/model.md',
  'journal/coverage.json',
  'journal/coverage.md',
  'journal/leads.json',
  'journal/leads.md',
  'findings/index.json',
  'findings/index.md',
  'findings/candidates.json',
  'findings/reportable.json',
  'evidence/manifest.json',
  '.compliance/framework.json',
  '.compliance/monitored-controls.json',
  '.compliance/readiness-current.json',
  '.compliance/open-requests.json',
  '.compliance/evidence-index.json',
  '.compliance/previous-runs.json',
  '.compliance/methodology.md',
  'skills/index.json',
  'skills/index.md',
  'skills/active.md',
  'scans/digest.json',
  'scans/digest.md',
]);

export const WORKSPACE_DIRS = [
  '.artifacts',
  '.artifacts/scans',
  '.artifacts/report',
  '.artifacts/phase-handoffs',
  '.artifacts/phase-checkpoints',
  '.skills',
  'context',
  'recon',
  'journal',
  'findings',
  'evidence',
  '.compliance',
  'skills',
  'scans',
  'report',
];

const ALL_SCOPES: ProjectionScope[] = [
  'contract',
  'context',
  'recon',
  'coverage',
  'leads',
  'findings',
  'evidence',
  'compliance',
  'skills',
  'scanDigest',
  'model',
];

export const MODEL_TOKEN_CHAR_CAP = 10_000;
const RECENT_LIMIT = 50;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const toIso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
};

export const getString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

export const firstString = (...values: unknown[]): string | null => {
  for (const value of values) {
    const normalized = getString(value);
    if (normalized) return normalized;
  }
  return null;
};

export const truncate = (value: string | null | undefined, max = 240): string => {
  const text = value?.replace(/\s+/g, ' ').trim() ?? '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
};

const SECRET_ASSIGNMENT_PATTERN =
  /\b(password|passwd|pwd|secret|token|api[_ -]?key|access[_ -]?key|private[_ -]?key|authorization|credential|client[_ -]?secret)\b\s*[:=]\s*("[^"]+"|'[^']+'|[^\s,;]+)/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const BASIC_TOKEN_PATTERN = /\bBasic\s+[A-Za-z0-9+/=._~-]+/gi;

export const redactSensitiveText = (value: string | null | undefined, max = 240): string => {
  const text = value?.replace(/\s+/g, ' ').trim() ?? '';
  const redacted = text
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [REDACTED]')
    .replace(BASIC_TOKEN_PATTERN, 'Basic [REDACTED]')
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1=[REDACTED]');
  return truncate(redacted, max);
};

const bullet = (value: string): string => `- ${value}`;

export const renderList = (items: string[], empty: string): string[] =>
  items.length > 0 ? items.map(bullet) : [bullet(empty)];

export const normalizeSkillSlugs = (slugs: readonly string[] | null | undefined): string[] =>
  Array.from(
    new Set(
      (slugs ?? [])
        .map((slug) => (typeof slug === 'string' ? slug.trim().toLowerCase() : ''))
        .filter(Boolean),
    ),
  );

export const getStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];

export const getNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const getNested = (record: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
};

export const scoreValidationLeadPriority = (lead: {
  title?: unknown;
  data?: unknown;
  confidence?: unknown;
  evidence?: unknown;
  lastSeenAt?: unknown;
}): LeadPriorityScore => {
  const data = isRecord(lead.data) ? lead.data : {};
  const reasons: string[] = [];
  let score = 30;

  const explicitPriority = firstString(data.priority, data.severity, data.impact)?.toLowerCase();
  const priorityWeights: Record<string, number> = {
    critical: 42,
    high: 30,
    medium: 18,
    low: 8,
    info: 0,
  };
  if (explicitPriority && explicitPriority in priorityWeights) {
    score += priorityWeights[explicitPriority];
    reasons.push(`priority=${explicitPriority}`);
  }

  const riskFamily = firstString(data.riskFamily, data.risk_family, data.family, data.type)?.toLowerCase() ?? '';
  if (/rce|command|sqli|sql.injection|ssrf|deserial|auth|access.control|idor|tenant|jwt|oauth|session|business.logic/u.test(riskFamily)) {
    score += 15;
    reasons.push(`risk=${riskFamily}`);
  } else if (/xss|path.traversal|upload|redirect|csrf|cors/u.test(riskFamily)) {
    score += 9;
    reasons.push(`risk=${riskFamily}`);
  }

  const confidence = getNumber(lead.confidence) ?? getNumber(data.confidence);
  if (confidence !== null) {
    score += Math.round(Math.max(0, Math.min(1, confidence)) * 12);
    reasons.push(`confidence=${confidence.toFixed(2)}`);
  } else {
    const confidenceText = firstString(data.confidenceLevel, data.confidence_label)?.toLowerCase();
    if (confidenceText === 'high') {
      score += 12;
      reasons.push('confidence=high');
    } else if (confidenceText === 'medium') {
      score += 6;
      reasons.push('confidence=medium');
    } else if (confidenceText === 'low') {
      score += 2;
      reasons.push('confidence=low');
    }
  }

  const evidenceRefs = [
    ...getStringArray(data.evidenceRefs),
    ...getStringArray(data.evidence_refs),
    ...getStringArray(lead.evidence),
  ];
  if (evidenceRefs.length > 0) {
    score += Math.min(10, evidenceRefs.length * 4);
    reasons.push('evidence');
  }

  const targetText = firstString(data.target, data.path, data.url, data.endpoint, lead.title)?.toLowerCase() ?? '';
  if (/admin|internal|token|password|secret|billing|payment|tenant|user|account|profile|upload|callback|webhook/u.test(targetText)) {
    score += 8;
    reasons.push('sensitive-target');
  }

  const source = firstString(data.source)?.toLowerCase() ?? '';
  if (/phase-handoff|scanner|openapi|worker|validator|manual/u.test(source)) {
    score += 4;
    reasons.push(`source=${source.split(':')[0]}`);
  }

  const attempts = getNumber(data.attempts);
  if (attempts !== null && attempts > 0) {
    score -= Math.min(15, Math.floor(attempts) * 4);
    reasons.push(`attempts=${Math.floor(attempts)}`);
  }

  const status = firstString(getNested(data, 'status', 'outcome'))?.toLowerCase();
  if (status && ['validated', 'false_positive', 'superseded'].includes(status)) {
    score -= 50;
    reasons.push(`closed=${status}`);
  } else if (status === 'blocked') {
    score -= 18;
    reasons.push('blocked');
  } else if (status === 'deferred') {
    score -= 10;
    reasons.push('deferred');
  }

  const normalizedScore = Math.max(0, Math.min(100, score));
  const band = normalizedScore >= 80 ? 'critical' : normalizedScore >= 60 ? 'high' : normalizedScore >= 35 ? 'medium' : 'low';
  return {
    score: normalizedScore,
    band,
    reasons: reasons.slice(0, 5),
  };
};

export const getLeadPriority = (lead: unknown): LeadPriorityScore => {
  if (isRecord(lead) && isRecord(lead.leadPriority)) {
    const score = getNumber(lead.leadPriority.score);
    const band = getString(lead.leadPriority.band);
    const reasons = getStringArray(lead.leadPriority.reasons);
    if (score !== null && (band === 'critical' || band === 'high' || band === 'medium' || band === 'low')) {
      return { score, band, reasons };
    }
  }
  return scoreValidationLeadPriority(isRecord(lead) ? lead : {});
};

export const compareLeadsByPriority = (left: unknown, right: unknown): number => {
  const leftPriority = getLeadPriority(left);
  const rightPriority = getLeadPriority(right);
  if (rightPriority.score !== leftPriority.score) return rightPriority.score - leftPriority.score;
  const leftSeen = isRecord(left) ? Date.parse(getString(left.lastSeenAt) ?? '') || 0 : 0;
  const rightSeen = isRecord(right) ? Date.parse(getString(right.lastSeenAt) ?? '') || 0 : 0;
  return rightSeen - leftSeen;
};

const increment = (map: Map<string, number>, key: string | null | undefined): void => {
  const normalized = key?.trim();
  if (!normalized) return;
  map.set(normalized, (map.get(normalized) ?? 0) + 1);
};

const sortedRecord = (map: Map<string, number>): Record<string, number> =>
  Object.fromEntries([...map.entries()].sort((left, right) => left[0].localeCompare(right[0])));

const severityRank = (value: unknown): number => {
  switch (getString(value)?.toLowerCase()) {
    case 'critical':
      return 5;
    case 'high':
      return 4;
    case 'medium':
      return 3;
    case 'low':
      return 2;
    case 'info':
      return 1;
    default:
      return 0;
  }
};

const parseEndpointUrl = (value: string | null): { host: string | null; path: string | null } => {
  if (!value) return { host: null, path: null };
  try {
    const parsed = new URL(value);
    return {
      host: parsed.host || parsed.hostname || null,
      path: `${parsed.pathname || '/'}${parsed.search || ''}`,
    };
  } catch {
    if (value.startsWith('/')) {
      return { host: null, path: value };
    }
    return { host: null, path: null };
  }
};

const endpointRiskSignals = (endpoint: Record<string, unknown>): string[] => {
  const method = (getString(endpoint.method) ?? 'GET').toUpperCase();
  const pathText = [endpoint.path, endpoint.urlTemplate, endpoint.url, endpoint.title]
    .map((value) => getString(value)?.toLowerCase())
    .filter(Boolean)
    .join(' ');
  const authHint = getString(endpoint.authHint)?.toLowerCase() ?? '';
  const pathParams = getStringArray(endpoint.pathParams);
  const queryParams = getStringArray(endpoint.queryParams);
  const bodyParams = getStringArray(endpoint.bodyParams);
  const signals: string[] = [];

  if (pathParams.length > 0 || /\/:[a-z0-9_]+|\{[a-z0-9_]+\}/u.test(pathText)) {
    signals.push('path-parameter');
  }
  if (/admin|internal|private|tenant|orgs?|users?|accounts?|billing|payment|token|password|secret|upload|webhook|callback/u.test(pathText)) {
    signals.push('sensitive-route');
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    signals.push('state-changing-method');
  }
  if (bodyParams.length > 0) {
    signals.push('body-parameters');
  }
  if (queryParams.length > 0) {
    signals.push('query-parameters');
  }
  if (/anonymous|unauth|none|public|missing/u.test(authHint) && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    signals.push('anonymous-state-change');
  }

  return signals;
};

export const normalizeProjectedEndpoint = (note: Record<string, unknown>): Record<string, unknown> => {
  const data = isRecord(note.data) ? note.data : {};
  const url = firstString(data.url, data.urlTemplate, note.title);
  const parsed = parseEndpointUrl(url);
  const method = (firstString(data.method) ?? 'GET').toUpperCase();
  const pathValue = firstString(data.path, data.urlTemplate, parsed.path, url);
  const normalized: Record<string, unknown> = {
    id: note.id,
    assetId: note.assetId ?? null,
    sessionId: note.sessionId ?? null,
    method,
    url,
    host: parsed.host,
    path: pathValue,
    statusCode: getNumber(data.statusCode),
    title: firstString(data.title, note.title),
    source: firstString(data.source),
    sourceArtifact: firstString(data.sourceArtifact),
    signal: firstString(data.signal),
    summary: firstString(data.summary),
    tags: getStringArray(data.tags),
    urlTemplate: firstString(data.urlTemplate),
    pathParams: getStringArray(data.pathParams),
    queryParams: getStringArray(data.queryParams),
    bodyParams: getStringArray(data.bodyParams),
    authHint: firstString(data.authHint),
    confidence: getNumber(data.confidence) ?? getNumber(note.confidence),
    evidence: note.evidence ?? [],
    lastSeenAt: note.lastSeenAt ?? null,
  };
  return {
    ...normalized,
    endpointKey: [method, parsed.host ?? '', pathValue ?? url ?? 'unknown'].join(' '),
    riskSignals: endpointRiskSignals(normalized),
  };
};

export const buildEndpointSurfaceGraph = (input: {
  assets: Array<Record<string, unknown>>;
  services: Array<Record<string, unknown>>;
  endpoints: Array<Record<string, unknown>>;
}): ReconProjection['graph'] & { endpointSummary: ReconProjection['endpointSummary'] } => {
  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];
  const byHost = new Map<string, number>();
  const byMethod = new Map<string, number>();
  const hostNodeIds = new Set<string>();

  for (const asset of input.assets) {
    nodes.push({ id: asset.id, type: 'asset', label: asset.value });
  }
  for (const service of input.services) {
    nodes.push({
      id: service.id,
      type: 'service',
      label: `${service.protocol}/${service.port}`,
      assetId: service.assetId,
    });
    edges.push({
      source: service.assetId,
      target: service.id,
      type: 'exposes_service',
    });
  }

  for (const endpoint of input.endpoints) {
    const id = getString(endpoint.id) ?? getString(endpoint.endpointKey) ?? `endpoint:${nodes.length}`;
    const host = getString(endpoint.host);
    const method = getString(endpoint.method) ?? 'GET';
    increment(byHost, host ?? 'unknown-host');
    increment(byMethod, method);
    nodes.push({
      id,
      type: 'endpoint',
      label: `${method} ${getString(endpoint.path) ?? getString(endpoint.url) ?? 'unknown endpoint'}`,
      host,
      riskSignals: Array.isArray(endpoint.riskSignals) ? endpoint.riskSignals : [],
    });

    const assetId = getString(endpoint.assetId);
    if (assetId) {
      edges.push({ source: assetId, target: id, type: 'asset_has_endpoint' });
    } else if (host) {
      const hostNodeId = `host:${host}`;
      if (!hostNodeIds.has(hostNodeId)) {
        hostNodeIds.add(hostNodeId);
        nodes.push({ id: hostNodeId, type: 'host', label: host });
      }
      edges.push({ source: hostNodeId, target: id, type: 'host_has_endpoint' });
    }
  }

  return {
    nodes,
    edges,
    endpointSummary: {
      total: input.endpoints.length,
      byHost: sortedRecord(byHost),
      byMethod: sortedRecord(byMethod),
      risky: input.endpoints
        .filter((endpoint) => Array.isArray(endpoint.riskSignals) && endpoint.riskSignals.length > 0)
        .sort((left, right) => (right.riskSignals as unknown[]).length - (left.riskSignals as unknown[]).length)
        .slice(0, 30),
    },
  };
};

export const deriveCoverageProjectionDetail = (input: {
  coverageNotes: Array<Record<string, unknown>>;
  scannerRows: Array<Record<string, unknown>>;
}): { matrix: Array<Record<string, unknown>>; blockers: string[]; gaps: string[] } => {
  const byFamily = new Map<string, Record<string, unknown>>();
  const touchedFamilies = new Set<string>();
  const blockers: string[] = [];

  for (const note of input.coverageNotes) {
    const data = isRecord(note.data) ? note.data : {};
    const family = firstString(data.family, data.tool, note.title) ?? 'unknown';
    touchedFamilies.add(family);
    const current = byFamily.get(family) ?? {
      family,
      completed: 0,
      blocked: 0,
      notes: 0,
      observations: 0,
      targets: [] as string[],
      lastSeenAt: null,
    };
    current.notes = Number(current.notes ?? 0) + 1;
    if (firstString(data.status)?.toLowerCase() === 'blocked') {
      current.blocked = Number(current.blocked ?? 0) + 1;
      blockers.push(truncate(firstString(data.reason, data.target, data.targetHost, note.title, JSON.stringify(data)), 180));
    } else {
      current.completed = Number(current.completed ?? 0) + 1;
    }
    const targets = current.targets as string[];
    const target = firstString(data.target, data.targetHost, data.targetUrl);
    if (target && !targets.includes(target)) targets.push(target);
    current.lastSeenAt = firstString(note.lastSeenAt, current.lastSeenAt);
    byFamily.set(family, current);
  }

  for (const row of input.scannerRows) {
    const family = firstString(row.parser, row.sourceTool, row.observationType) ?? 'scanner';
    touchedFamilies.add(family);
    const current = byFamily.get(family) ?? {
      family,
      completed: 0,
      blocked: 0,
      notes: 0,
      observations: 0,
      targets: [] as string[],
      lastSeenAt: null,
    };
    current.observations = Number(current.observations ?? 0) + 1;
    current.lastSeenAt = firstString(row.lastSeenAt, current.lastSeenAt);
    byFamily.set(family, current);
  }

  const gaps: string[] = [];
  if (input.coverageNotes.length === 0 && input.scannerRows.length === 0) {
    gaps.push('no scan.coverage notes or scanner observations projected');
  }
  if (!['broad-surface', 'subfinder', 'httpx'].some((family) => touchedFamilies.has(family))) {
    gaps.push('broad surface coverage is not explicitly recorded');
  }
  if (!['katana', 'openapi', 'ffuf'].some((family) => touchedFamilies.has(family))) {
    gaps.push('endpoint discovery or route enumeration is not explicitly recorded');
  }
  for (const row of byFamily.values()) {
    if (Number(row.observations ?? 0) > 0 && Number(row.notes ?? 0) === 0) {
      gaps.push(`${row.family} produced observations but has no scan.coverage ledger note`);
    }
  }
  for (const blocker of blockers.slice(0, 10)) {
    gaps.push(`blocked coverage: ${blocker}`);
  }

  return {
    matrix: [...byFamily.values()].sort((left, right) => String(left.family).localeCompare(String(right.family))),
    blockers,
    gaps: Array.from(new Set(gaps)).slice(0, 30),
  };
};

export const buildScanDigest = (
  rows: Array<Record<string, unknown>>,
  context: {
    recon?: Pick<ReconProjection, 'endpoints' | 'technologies' | 'endpointSummary'> | null;
    coverage?: Pick<CoverageProjection, 'notes' | 'gaps' | 'matrix' | 'blockers'> | null;
  } = {},
): Record<string, unknown> => {
  const byParser = new Map<string, number>();
  const bySeverity = new Map<string, number>();
  const byObservationType = new Map<string, number>();
  const byHost = new Map<string, number>();
  const byStatusCode = new Map<string, number>();
  const artifactMap = new Map<string, Record<string, unknown>>();
  const endpointMap = new Map<string, Record<string, unknown>>();
  const hostMap = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const parser = firstString(row.parser, row.sourceTool) ?? 'unknown';
    const severity = firstString(row.severity) ?? 'info';
    const observationType = firstString(row.observationType) ?? 'observation';
    const artifactPath = firstString(row.artifactPath) ?? 'unknown artifact';
    const data = isRecord(row.data) ? row.data : {};
    const dataUrl = firstString(data.url, data.urlTemplate, data.endpoint, data.location, data.input);
    const parsedUrl = parseEndpointUrl(dataUrl);
    const host = firstString(data.host, data.hostname, data.domain, parsedUrl.host);
    const endpointPath = firstString(data.path, parsedUrl.path, dataUrl);
    const method = firstString(data.method, data.httpMethod) ?? 'GET';
    const statusCode = getNumber(data.statusCode) ?? getNumber(data.status_code) ?? getNumber(data.status);
    increment(byParser, parser);
    increment(bySeverity, severity);
    increment(byObservationType, observationType);
    increment(byHost, host);
    if (typeof statusCode === 'number') {
      increment(byStatusCode, String(statusCode));
    }

    if (host) {
      const hostEntry = hostMap.get(host) ?? {
        host,
        observations: 0,
        statusCodes: {} as Record<string, number>,
        parsers: [] as string[],
        highestSeverity: 'info',
        lastSeenAt: null,
      };
      hostEntry.observations = Number(hostEntry.observations ?? 0) + 1;
      if (typeof statusCode === 'number') {
        const statusCodes = hostEntry.statusCodes as Record<string, number>;
        statusCodes[String(statusCode)] = (statusCodes[String(statusCode)] ?? 0) + 1;
      }
      const hostParsers = hostEntry.parsers as string[];
      if (!hostParsers.includes(parser)) hostParsers.push(parser);
      if (severityRank(severity) > severityRank(hostEntry.highestSeverity)) {
        hostEntry.highestSeverity = severity;
      }
      hostEntry.lastSeenAt = firstString(row.lastSeenAt, hostEntry.lastSeenAt);
      hostMap.set(host, hostEntry);
    }

    if (host || endpointPath) {
      const endpointKey = [method.toUpperCase(), host ?? 'unknown-host', endpointPath ?? 'unknown-path'].join(' ');
      const endpoint = endpointMap.get(endpointKey) ?? {
        endpointKey,
        method: method.toUpperCase(),
        host,
        path: endpointPath,
        url: dataUrl,
        observations: 0,
        statusCodes: {} as Record<string, number>,
        parsers: [] as string[],
        highestSeverity: 'info',
        lastSeenAt: null,
        artifactPath,
      };
      endpoint.observations = Number(endpoint.observations ?? 0) + 1;
      if (typeof statusCode === 'number') {
        const statusCodes = endpoint.statusCodes as Record<string, number>;
        statusCodes[String(statusCode)] = (statusCodes[String(statusCode)] ?? 0) + 1;
      }
      const endpointParsers = endpoint.parsers as string[];
      if (!endpointParsers.includes(parser)) endpointParsers.push(parser);
      if (severityRank(severity) > severityRank(endpoint.highestSeverity)) {
        endpoint.highestSeverity = severity;
      }
      endpoint.lastSeenAt = firstString(row.lastSeenAt, endpoint.lastSeenAt);
      endpointMap.set(endpointKey, endpoint);
    }

    const artifact = artifactMap.get(artifactPath) ?? {
      artifactPath,
      observations: 0,
      parsers: [] as string[],
      severities: {} as Record<string, number>,
      highestSeverity: 'info',
      lastSeenAt: null,
    };
    artifact.observations = Number(artifact.observations ?? 0) + 1;
    const parsers = artifact.parsers as string[];
    if (!parsers.includes(parser)) parsers.push(parser);
    const severities = artifact.severities as Record<string, number>;
    severities[severity] = (severities[severity] ?? 0) + 1;
    if (severityRank(severity) > severityRank(artifact.highestSeverity)) {
      artifact.highestSeverity = severity;
    }
    artifact.lastSeenAt = firstString(row.lastSeenAt, artifact.lastSeenAt);
    artifactMap.set(artifactPath, artifact);
  }

  const recent = rows.slice(0, RECENT_LIMIT).map((row) => ({ ...row, lastSeenAt: toIso(row.lastSeenAt as Date | string | null) }));
  const highSignal = [...rows]
    .filter((row) => severityRank(row.severity) >= 3)
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity))
    .slice(0, 40)
    .map((row) => ({ ...row, lastSeenAt: toIso(row.lastSeenAt as Date | string | null) }));
  const topArtifacts = [...artifactMap.values()]
    .sort((left, right) => Number(right.observations ?? 0) - Number(left.observations ?? 0))
    .slice(0, 30);
  const topHosts = [...hostMap.values()]
    .sort((left, right) => Number(right.observations ?? 0) - Number(left.observations ?? 0))
    .slice(0, 30);
  const topEndpoints = [...endpointMap.values()]
    .sort((left, right) =>
      severityRank(right.highestSeverity) - severityRank(left.highestSeverity) ||
      Number(right.observations ?? 0) - Number(left.observations ?? 0) ||
      String(left.endpointKey).localeCompare(String(right.endpointKey)),
    )
    .slice(0, 50);
  const recon = context.recon ?? null;
  const coverage = context.coverage ?? null;
  const projectedEndpoints = Array.isArray(recon?.endpoints) ? recon.endpoints : [];
  const projectedTechnologies = Array.isArray(recon?.technologies) ? recon.technologies : [];
  const projectedRiskyEndpoints = Array.isArray(recon?.endpointSummary?.risky)
    ? recon.endpointSummary.risky
    : [];
  const projectedCoverageGaps = Array.isArray(coverage?.gaps) ? coverage.gaps.map(String).slice(0, 30) : [];
  const projectedCoverageMatrix = Array.isArray(coverage?.matrix) ? coverage.matrix.slice(0, 30) : [];

  return {
    totals: {
      observations: rows.length,
      byParser: sortedRecord(byParser),
      bySeverity: sortedRecord(bySeverity),
      byObservationType: sortedRecord(byObservationType),
      byHost: sortedRecord(byHost),
      byStatusCode: sortedRecord(byStatusCode),
      artifactCount: artifactMap.size,
      hostCount: hostMap.size,
      endpointCount: endpointMap.size,
      projectedEndpointCount: projectedEndpoints.length,
      projectedTechnologyCount: projectedTechnologies.length,
      coverageNoteCount: Array.isArray(coverage?.notes) ? coverage.notes.length : 0,
    },
    highSignal,
    topHosts,
    topEndpoints,
    topArtifacts,
    recent,
    projectedInventory: {
      recentEndpoints: projectedEndpoints.slice(0, 40),
      riskyEndpoints: projectedRiskyEndpoints.slice(0, 30),
      technologies: projectedTechnologies.slice(0, 30),
      coverageGaps: projectedCoverageGaps,
      coverageMatrix: projectedCoverageMatrix,
    },
    rawReadPolicy: 'Prefer this digest, recon/graph.json, recon/endpoints.json, and projected coverage before raw scanner artifacts. Open raw artifacts when exact evidence, parser repair, or missing detail requires them.',
    recommendedNextAction: rows.length > 0 || projectedEndpoints.length > 0 || projectedCoverageGaps.length > 0
      ? 'Use highSignal, projectedInventory.riskyEndpoints, topEndpoints, and coverageGaps first; open raw artifacts only for evidence drill-down, parser repair, or details this digest does not contain.'
      : 'No scanner observations or projected endpoints are available yet; run or ingest a bounded scanner pass before reading raw artifacts.',
  };
};

export const makeEnvelope = <T>(
  input: ProjectRunWorkspaceInput,
  projection: string,
  generatedAt: string,
  data: T,
): ProjectionEnvelope<T> => ({
  schemaVersion: 1,
  runId: input.runId,
  scopeId: input.scopeId,
  generatedAt,
  source: {
    db: 'postgres',
    projection,
  },
  data,
});

export const expandScopes = (scopesToProject: ProjectionScope[]): Set<ProjectionScope> => {
  const expanded = new Set<ProjectionScope>();
  const requested: ProjectionScope[] = scopesToProject.length > 0 ? scopesToProject : ['all'];
  for (const scope of requested) {
    if (scope === 'all') {
      for (const item of ALL_SCOPES) expanded.add(item);
      continue;
    }
    if (scope === 'surface') {
      expanded.add('recon');
      continue;
    }
    expanded.add(scope);
  }
  return expanded;
};

export const assertProjectionOwnedPath = (relativePath: string): string => {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (!OWNED_FILES.has(normalized)) {
    throw new Error(`projection_path_not_owned:${normalized}`);
  }
  return normalized;
};
