import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type * as AssetFocusModule from '@/domains/security-ops/assets/assetFocus';

const mocks = vi.hoisted(() => {
  const selectResults: unknown[] = [];
  const insertReturningResults: unknown[] = [];
  const selectCalls: Array<Record<string, unknown>> = [];
  const insertCalls: Array<Record<string, unknown>> = [];
  const updateCalls: Array<Record<string, unknown>> = [];

  const automationEvaluate = vi.fn();
  const loadAssetFocusEnrichments = vi.fn().mockResolvedValue(new Map());
  const loadVersionAcquisitionByAssetIds = vi.fn().mockResolvedValue(new Map());
  const loggerWarn = vi.fn();
  const loggerInfo = vi.fn();
  const loggerError = vi.fn();
  const recordFailure = vi.fn();

  const next = (queue: unknown[], label: string) => {
    if (queue.length === 0) throw new Error(`No queued ${label} result`);
    return queue.shift();
  };

  const createChain = (call: Record<string, unknown>) => {
    const chain: any = {
      from: vi.fn((table: unknown) => {
        call.from = table;
        return chain;
      }),
      where: vi.fn((where: unknown) => {
        call.where = where;
        return chain;
      }),
      innerJoin: vi.fn((table: unknown, on: unknown) => {
        const joins = (call.innerJoin ??= []) as Array<Record<string, unknown>>;
        joins.push({ table, on });
        return chain;
      }),
      leftJoin: vi.fn((table: unknown, on: unknown) => {
        const joins = (call.leftJoin ??= []) as Array<Record<string, unknown>>;
        joins.push({ table, on });
        return chain;
      }),
      orderBy: vi.fn((...orderBy: unknown[]) => {
        call.orderBy = orderBy;
        return chain;
      }),
      limit: vi.fn((limit: unknown) => {
        call.limit = limit;
        return chain;
      }),
      offset: vi.fn((offset: unknown) => {
        call.offset = offset;
        return chain;
      }),
      then: (onfulfilled?: (value: unknown) => unknown, onrejected?: (reason: unknown) => unknown) =>
        Promise.resolve(
          (call.from as { __table?: string } | undefined)?.__table === 'scope_targets'
            ? []
            : next(selectResults, 'select'),
        ).then(onfulfilled, onrejected),
    };

    return chain;
  };

  const db: any = {
    select: vi.fn((fields?: unknown) => {
      const call: Record<string, unknown> = { fields };
      selectCalls.push(call);
      return createChain(call);
    }),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        const call: Record<string, unknown> = { table, values };
        insertCalls.push(call);
        return {
          returning: vi.fn((returning: unknown) => {
            call.returning = returning;
            return Promise.resolve(next(insertReturningResults, 'insert returning'));
          }),
          onConflictDoNothing: vi.fn((payload: unknown) => {
            call.onConflictDoNothing = payload;
            return Promise.resolve();
          }),
          onConflictDoUpdate: vi.fn((payload: unknown) => {
            call.onConflictDoUpdate = payload;
            return Promise.resolve();
          }),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: unknown) => ({
        where: vi.fn((where: unknown) => {
          updateCalls.push({ table, values, where });
          return Promise.resolve();
        }),
      })),
    })),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
  };

  const eqMock = vi.fn((field: unknown, value: unknown) => ({ op: 'eq', field, value }));
  const andMock = vi.fn((...clauses: unknown[]) => ({ op: 'and', clauses }));
  const descMock = vi.fn((field: unknown) => ({ op: 'desc', field }));
  const inArrayMock = vi.fn((field: unknown, values: unknown[]) => ({ op: 'inArray', field, values }));
  const isNullMock = vi.fn((field: unknown) => ({ op: 'isNull', field }));
  const likeMock = vi.fn((field: unknown, value: unknown) => ({ op: 'like', field, value }));
  const ltMock = vi.fn((field: unknown, value: unknown) => ({ op: 'lt', field, value }));
  const sqlMock: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    op: 'sql',
    strings: [...strings],
    values,
  }));
  sqlMock.join = vi.fn((parts: unknown[], separator: unknown) => ({ op: 'sql.join', parts, separator }));

  return {
    db,
    selectResults,
    insertReturningResults,
    selectCalls,
    insertCalls,
    updateCalls,
    automationEvaluate,
    loadAssetFocusEnrichments,
    loadVersionAcquisitionByAssetIds,
    loggerWarn,
    loggerInfo,
    loggerError,
    recordFailure,
    eqMock,
    andMock,
    descMock,
    inArrayMock,
    isNullMock,
    likeMock,
    ltMock,
    sqlMock,
  };
});

vi.mock('drizzle-orm', () => ({
  and: mocks.andMock,
  desc: mocks.descMock,
  eq: mocks.eqMock,
  inArray: mocks.inArrayMock,
  isNull: mocks.isNullMock,
  like: mocks.likeMock,
  lt: mocks.ltMock,
  sql: mocks.sqlMock,
}));

vi.mock('@/shared/logger', () => ({
  logger: {
    child: vi.fn(() => ({
      info: mocks.loggerInfo,
      warn: mocks.loggerWarn,
      error: mocks.loggerError,
    })),
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

vi.mock('@/domains/security-ops/assets/assetFocus', async (importOriginal) => {
  const actual = await importOriginal<typeof AssetFocusModule>();
  return {
    ...actual,
    loadAssetFocusEnrichments: mocks.loadAssetFocusEnrichments,
  };
});

// The query service falls back to a db-backed acquisition loader when none is
// injected, which would issue a select this harness has no queued result for.
vi.mock('@/domains/security-ops/components/componentVersionAcquisition', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/domains/security-ops/components/componentVersionAcquisition')
  >();
  return {
    ...actual,
    createVersionAcquisitionLoader: () => mocks.loadVersionAcquisitionByAssetIds,
  };
});

vi.mock('@/domains/security-ops/resilience/FailedEventService', () => ({
  FailedEventService: class {
    async recordFailure(input: unknown): Promise<void> {
      mocks.recordFailure(input);
    }
  },
}));

vi.mock('@/db/schema', () => {
  const createTable = <T extends Record<string, string>>(name: string, columns: T): T & { __table: string } => ({
    __table: name,
    ...columns,
  });

  const assets = createTable('assets', {
    id: 'assets.id',
    userId: 'assets.user_id',
    organizationId: 'assets.organization_id',
    scopeId: 'assets.scope_id',
    kind: 'assets.kind',
    value: 'assets.value',
    parentAssetId: 'assets.parent_asset_id',
    tags: 'assets.tags',
    evidence: 'assets.evidence',
    firstSeenAt: 'assets.first_seen_at',
    lastScannedAt: 'assets.last_scanned_at',
    lastSeenAt: 'assets.last_seen_at',
    createdAt: 'assets.created_at',
    updatedAt: 'assets.updated_at',
  });
  const inventoryComponents = createTable('inventory_components', {
    id: 'inventory_components.id',
    organizationId: 'inventory_components.organization_id',
    assetId: 'inventory_components.asset_id',
    componentKey: 'inventory_components.component_key',
    displayName: 'inventory_components.display_name',
    ecosystem: 'inventory_components.ecosystem',
    resolvedVersion: 'inventory_components.resolved_version',
    versionReadAttempts: 'inventory_components.version_read_attempts',
  });
  const organizations = createTable('organizations', {
    id: 'organizations.id',
    operationalContext: 'organizations.operational_context',
  });
  const scopes = createTable('scopes', {
    id: 'scopes.id',
    organizationId: 'scopes.organization_id',
    roeDocument: 'scopes.roe_document',
  });
  const assetObservations = createTable('asset_observations', {
    id: 'asset_observations.id',
    userId: 'asset_observations.user_id',
    assetId: 'asset_observations.asset_id',
    sessionId: 'asset_observations.session_id',
    organizationId: 'asset_observations.organization_id',
    firstSeenAt: 'asset_observations.first_seen_at',
    lastSeenAt: 'asset_observations.last_seen_at',
    createdAt: 'asset_observations.created_at',
    updatedAt: 'asset_observations.updated_at',
  });
  const assetScopeMemberships = createTable('asset_scope_memberships', {
    id: 'asset_scope_memberships.id',
    organizationId: 'asset_scope_memberships.organization_id',
    assetId: 'asset_scope_memberships.asset_id',
    scopeId: 'asset_scope_memberships.scope_id',
    firstSeenAt: 'asset_scope_memberships.first_seen_at',
    lastSeenAt: 'asset_scope_memberships.last_seen_at',
    createdAt: 'asset_scope_memberships.created_at',
    updatedAt: 'asset_scope_memberships.updated_at',
  });
  const findings = createTable('findings', {
    id: 'findings.id',
    userId: 'findings.user_id',
    organizationId: 'findings.organization_id',
    scopeId: 'findings.scope_id',
    assetId: 'findings.asset_id',
    title: 'findings.title',
    severity: 'findings.severity',
    state: 'findings.state',
    summary: 'findings.summary',
    businessImpact: 'findings.business_impact',
    technicalAnalysis: 'findings.technical_analysis',
    pocDescription: 'findings.poc_description',
    pocScriptCode: 'findings.poc_script_code',
    assumptions: 'findings.assumptions',
    fixEffort: 'findings.fix_effort',
    remediation: 'findings.remediation',
    confidenceScore: 'findings.confidence_score',
    cweId: 'findings.cwe_id',
    cveId: 'findings.cve_id',
    cweIds: 'findings.cwe_ids',
    cveIds: 'findings.cve_ids',
    owaspCategory: 'findings.owasp_category',
    cvssVector: 'findings.cvss_vector',
    cvssScore: 'findings.cvss_score',
    dedupeKey: 'findings.dedupe_key',
    endpointId: 'findings.endpoint_id',
    serviceId: 'findings.service_id',
    codeLocations: 'findings.code_locations',
    firstSeenAt: 'findings.first_seen_at',
    lastSeenAt: 'findings.last_seen_at',
    createdAt: 'findings.created_at',
    updatedAt: 'findings.updated_at',
  });
  const findingEvidence = createTable('finding_evidence', {
    id: 'finding_evidence.id',
    findingId: 'finding_evidence.finding_id',
    kind: 'finding_evidence.kind',
    path: 'finding_evidence.path',
    displayPath: 'finding_evidence.display_path',
    sessionId: 'finding_evidence.session_id',
    label: 'finding_evidence.label',
    excerpt: 'finding_evidence.excerpt',
    fileMissing: 'finding_evidence.file_missing',
    data: 'finding_evidence.data',
    createdAt: 'finding_evidence.created_at',
  });
  const findingEvents = createTable('finding_events', {
    id: 'finding_events.id',
    findingId: 'finding_events.finding_id',
    organizationId: 'finding_events.organization_id',
    userId: 'finding_events.user_id',
    type: 'finding_events.type',
    fromState: 'finding_events.from_state',
    toState: 'finding_events.to_state',
    note: 'finding_events.note',
    createdAt: 'finding_events.created_at',
  });
  const findingValidationAudit = createTable('finding_validation_audit', {
    id: 'finding_validation_audit.id',
    findingId: 'finding_validation_audit.finding_id',
    evidenceRefs: 'finding_validation_audit.evidence_refs',
    completedAt: 'finding_validation_audit.completed_at',
  });
  const inventoryNotes = createTable('inventory_notes', {
    id: 'inventory_notes.id',
    userId: 'inventory_notes.user_id',
    organizationId: 'inventory_notes.organization_id',
    scopeId: 'inventory_notes.scope_id',
    assetId: 'inventory_notes.asset_id',
    sessionId: 'inventory_notes.session_id',
    dedupeKey: 'inventory_notes.dedupe_key',
    title: 'inventory_notes.title',
    data: 'inventory_notes.data',
    confidence: 'inventory_notes.confidence',
    evidence: 'inventory_notes.evidence',
    firstSeenAt: 'inventory_notes.first_seen_at',
    lastSeenAt: 'inventory_notes.last_seen_at',
    ntype: 'inventory_notes.ntype',
    createdAt: 'inventory_notes.created_at',
    updatedAt: 'inventory_notes.updated_at',
  });
  const inventoryServices = createTable('inventory_services', {
    id: 'inventory_services.id',
    userId: 'inventory_services.user_id',
    organizationId: 'inventory_services.organization_id',
    assetId: 'inventory_services.asset_id',
    protocol: 'inventory_services.protocol',
    port: 'inventory_services.port',
    serviceName: 'inventory_services.service_name',
    product: 'inventory_services.product',
    version: 'inventory_services.version',
    lastSeenAt: 'inventory_services.last_seen_at',
  });
  const scannerObservations = createTable('scanner_observations', {
    id: 'scanner_observations.id',
    organizationId: 'scanner_observations.organization_id',
    scopeId: 'scanner_observations.scope_id',
    runId: 'scanner_observations.run_id',
    parser: 'scanner_observations.parser',
    observationType: 'scanner_observations.observation_type',
    title: 'scanner_observations.title',
    severity: 'scanner_observations.severity',
    artifactPath: 'scanner_observations.artifact_path',
    findingId: 'scanner_observations.finding_id',
    lastSeenAt: 'scanner_observations.last_seen_at',
  });
  const agentArtifacts = createTable('agent_artifacts', {
    id: 'agent_artifacts.id',
    sessionId: 'agent_artifacts.session_id',
    filePath: 'agent_artifacts.file_path',
    originalName: 'agent_artifacts.original_name',
    fileType: 'agent_artifacts.file_type',
    sizeBytes: 'agent_artifacts.size_bytes',
    createdAt: 'agent_artifacts.created_at',
  });
  const runs = createTable('runs', {
    id: 'runs.id',
    organizationId: 'runs.organization_id',
    scopeId: 'runs.scope_id',
    status: 'runs.status',
    inventoryAdded: 'runs.inventory_added',
    findingsCount: 'runs.findings_count',
    createdAt: 'runs.created_at',
    completedAt: 'runs.completed_at',
    updatedAt: 'runs.updated_at',
  });
  const runEvents = createTable('run_events', {
    runId: 'run_events.run_id',
    type: 'run_events.type',
    message: 'run_events.message',
    createdAt: 'run_events.created_at',
  });
  const runPhases = createTable('run_phases', {
    id: 'run_phases.id',
    runId: 'run_phases.run_id',
    ordinal: 'run_phases.ordinal',
    phaseKey: 'run_phases.phase_key',
    status: 'run_phases.status',
    sessionId: 'run_phases.session_id',
    lastError: 'run_phases.last_error',
    completedAt: 'run_phases.completed_at',
    updatedAt: 'run_phases.updated_at',
  });
  const scopeTargets = createTable('scope_targets', {
    scopeId: 'scope_targets.scope_id',
    type: 'scope_targets.type',
    value: 'scope_targets.value',
    verified: 'scope_targets.verified',
  });

  return {
    inventoryComponents,
    organizations,
    scopes,
    assets,
    assetObservations,
    assetScopeMemberships,
    inventoryServices,
    inventoryNotes,
    scannerObservations,
    agentArtifacts,
    findings,
    findingEvidence,
    findingEvents,
    findingValidationAudit,
    runs,
    runEvents,
    runPhases,
    scopeTargets,
  };
});

import { SecurityOpsToolService } from '@/domains/security-ops/tools/SecurityOpsToolService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SCOPE_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const findingContractFields = {
  businessImpact: 'Attacker can execute script in another user session.',
  technicalAnalysis: 'User-controlled search input is reflected into HTML without output encoding.',
  pocDescription: '1. Submit a crafted search value. 2. Observe script execution in the reflected response.',
  pocScriptCode: 'print("<script>alert(1)</script>")',
  assumptions: 'Attacker can reach the search page without authentication.',
  fixEffort: 'medium' as const,
  remediation: 'Apply context-appropriate output encoding to the reflected search value.',
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
};

const buildTestInventoryFingerprint = (params: {
  assetValue: string;
  services: Array<Record<string, unknown>>;
  techs: Array<Record<string, unknown>>;
}): string => {
  const stableSort = (values: unknown[]): unknown[] =>
    [...values].sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));

  return createHash('sha256')
    .update(
      stableStringify({
        assetValue: params.assetValue,
        services: stableSort(params.services),
        techs: stableSort(params.techs),
      }),
    )
    .digest('hex');
};

const writeAuthoredCloseoutFiles = async (workspaceDir: string, options?: {
  summary?: string;
  report?: string;
}) => {
  await writeFile(
    join(workspaceDir, 'summary.md'),
    options?.summary ??
      [
        '# Run Summary',
        '',
        'Outcome: completed.',
        'Reportable findings: one low-severity issue was validated.',
        'Recommended next run: Test authenticated workflows on https://example.com/login.',
      ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(workspaceDir, 'report.md'),
    options?.report ??
      [
        '# Security Assessment Report',
        '',
        '## Executive Summary',
        'The assessment validated the public web baseline and confirmed one reportable finding: Missing security headers.',
        '',
        '## Findings',
        'Missing security headers were observed on the root response. The finding is backed by finding-1 and the retained HTTP exchange evidence.',
        '',
        '## Next Steps',
        'Add HSTS and CSP, then test authenticated workflows on https://example.com/login.',
      ].join('\n'),
    'utf8',
  );
};

describe('SecurityOpsToolService', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.selectResults.length = 0;
    mocks.insertReturningResults.length = 0;
    mocks.selectCalls.length = 0;
    mocks.insertCalls.length = 0;
    mocks.updateCalls.length = 0;
    mocks.loadAssetFocusEnrichments.mockReset();
    mocks.loadAssetFocusEnrichments.mockResolvedValue(new Map());
    mocks.loadVersionAcquisitionByAssetIds.mockReset();
    mocks.loadVersionAcquisitionByAssetIds.mockResolvedValue(new Map());
    workspaceDir = await mkdtemp(join(tmpdir(), 'security-ops-tool-service-'));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('creates a new finding, records evidence, and emits the finding_created event', async () => {
    await mkdir(join(workspaceDir, '.artifacts'), { recursive: true });
    await writeFile(join(workspaceDir, '.artifacts', 'proof.txt'), 'proof');

    mocks.selectResults.push([], [], [], [], []);
    mocks.insertReturningResults.push([{ id: 'asset-1' }], [{ id: 'finding-1' }]);

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T05:00:00.000Z'),
      automationService: { evaluateEvent: mocks.automationEvaluate },
    } as never);

    const result = await service.reportFinding({
      userId: 'user-1',
      workspaceDir,
      sessionId: SESSION_ID,
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
        runId: RUN_ID,
      },
      input: {
        assetRef: { kind: 'domain', value: 'api.example.com' },
        title: 'Cross-site scripting in search',
        severity: 'high',
        summary: 'Reflected XSS in the search parameter',
        ...findingContractFields,
        owaspCategory: 'A03:2021-Injection',
        confidence: 0.9,
        evidence: [
          {
            path: '/workspace/.artifacts/proof.txt',
            label: 'PoC response',
            excerpt: '<script>alert(1)</script>',
          },
        ],
      },
    });

    expect(result).toEqual(expect.objectContaining({
      findingId: 'finding-1',
      created: true,
      dedupeKey: expect.any(String),
      state: 'potential',
      lifecycleStage: 'candidate',
      evidenceGate: expect.objectContaining({ passed: true }),
    }));

    const assetInsert = mocks.insertCalls.find((call) => (call.table as { __table: string }).__table === 'assets');
    expect(assetInsert).toMatchObject({
      values: expect.objectContaining({
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
        userId: 'user-1',
        kind: 'domain',
        value: 'api.example.com',
      }),
    });

    const findingInsert = mocks.insertCalls.find(
      (call) => (call.table as { __table: string }).__table === 'findings',
    );
    expect(findingInsert).toMatchObject({
      values: expect.objectContaining({
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
        userId: 'user-1',
        assetId: 'asset-1',
        title: 'Cross-site scripting in search',
        severity: 'high',
        sourceKind: 'assessment',
        state: 'potential',
        summary: 'Reflected XSS in the search parameter',
        businessImpact: findingContractFields.businessImpact,
        technicalAnalysis: findingContractFields.technicalAnalysis,
        pocDescription: findingContractFields.pocDescription,
        pocScriptCode: findingContractFields.pocScriptCode,
        assumptions: findingContractFields.assumptions,
        fixEffort: findingContractFields.fixEffort,
        remediation: findingContractFields.remediation,
        owaspCategory: 'A03:2021-Injection',
        confidenceScore: 0.9,
      }),
    });

    const evidenceInsert = mocks.insertCalls.find(
      (call) => (call.table as { __table: string }).__table === 'finding_evidence',
    );
    expect(evidenceInsert).toMatchObject({
      values: expect.objectContaining({
        findingId: 'finding-1',
        sessionId: SESSION_ID,
        path: '.artifacts/proof.txt',
        label: 'PoC response',
        excerpt: '<script>alert(1)</script>',
        fileMissing: false,
      }),
      onConflictDoNothing: expect.anything(),
    });

    expect(mocks.automationEvaluate).toHaveBeenCalledWith(ORG_ID, {
      type: 'finding_created',
      payload: {
        findingId: 'finding-1',
        severity: 'high',
        assetId: 'asset-1',
        confidenceScore: 0.9,
      },
    });
    const runUpdates = mocks.updateCalls.filter((call) => (call.table as { __table: string }).__table === 'runs');
    expect(runUpdates).toHaveLength(2);
  });

  it('accepts a candidate finding at observation level without heavy narrative fields (PRD 2.0-B)', async () => {
    await mkdir(join(workspaceDir, '.artifacts'), { recursive: true });
    await writeFile(join(workspaceDir, '.artifacts', 'observation.txt'), 'observed: id=1 vs id=2 returned different bodies');

    mocks.selectResults.push([], [], [], [], []);
    mocks.insertReturningResults.push([{ id: 'asset-1' }], [{ id: 'finding-obs-1' }]);

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T05:00:00.000Z'),
      automationService: { evaluateEvent: mocks.automationEvaluate },
    } as never);

    const result = await service.reportFinding({
      userId: 'user-1',
      workspaceDir,
      sessionId: SESSION_ID,
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
        runId: RUN_ID,
      },
      input: {
        assetRef: { kind: 'domain', value: 'api.example.com' },
        title: 'IDOR candidate: GET /api/orders/{orderId} shows id-variance',
        severity: 'medium',
        summary: 'GET /api/orders/{orderId} returns 200 with different order-shaped bodies for id=1 vs id=2 in the same auth context.',
        signalClass: 'id-variance-with-pii',
        hypothesis: 'orderId is an unprotected object reference enumerating orders across users.',
        differentialEvidence: [
          { parameter: 'orderId', baselineValue: '1', observedValue: '2', signal: 'body_diff', note: 'different order numbers' },
        ],
        confidence: 0.6,
        evidence: [
          {
            path: '/workspace/.artifacts/observation.txt',
            label: 'differential observation',
            excerpt: 'id=1 vs id=2 body delta=312 bytes',
          },
        ],
      },
    });

    expect(result).toEqual(expect.objectContaining({
      findingId: 'finding-obs-1',
      created: true,
      lifecycleStage: 'candidate',
      warnings: [expect.stringContaining('remediation is missing')],
    }));
    const findingInsert = mocks.insertCalls.find(
      (call) => (call.table as { __table: string }).__table === 'findings',
    );
    expect(findingInsert).toMatchObject({
      values: expect.objectContaining({
        title: 'IDOR candidate: GET /api/orders/{orderId} shows id-variance',
        severity: 'medium',
        confidenceScore: 0.6,
      }),
    });
    const stored = (findingInsert?.values as Record<string, unknown>) ?? {};
    expect(stored.businessImpact).toBe('');
    expect(stored.technicalAnalysis).toBe('');
    expect(stored.pocScriptCode).toBe('');
    expect(stored.remediation).toBe('');
  });

  it('rejects only findings with confidence below the theoretical floor (0.3)', async () => {
    await mkdir(join(workspaceDir, '.artifacts'), { recursive: true });
    await writeFile(join(workspaceDir, '.artifacts', 'noise.txt'), 'noise');

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T05:00:00.000Z'),
      automationService: { evaluateEvent: mocks.automationEvaluate },
    } as never);

    await expect(
      service.reportFinding({
        userId: 'user-1',
        workspaceDir,
        sessionId: SESSION_ID,
        context: { organizationId: ORG_ID, scopeId: SCOPE_ID, runId: RUN_ID },
        input: {
          assetRef: { kind: 'domain', value: 'api.example.com' },
          title: 'noise',
          severity: 'info',
          summary: 'noise',
          confidence: 0.2,
          evidence: [{ path: '/workspace/.artifacts/noise.txt', label: 'noise' }],
        },
      }),
    ).rejects.toThrow(/below the theoretical floor/);
  });

  it('accepts candidate filings at confidence 0.4 (observation-level, was previously rejected by 0.5 floor)', async () => {
    await mkdir(join(workspaceDir, '.artifacts'), { recursive: true });
    await writeFile(join(workspaceDir, '.artifacts', 'evidence.txt'), 'evidence');

    mocks.selectResults.push([], [], [], [], []);
    mocks.insertReturningResults.push([{ id: 'asset-1' }], [{ id: 'finding-obs-2' }]);

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T05:00:00.000Z'),
      automationService: { evaluateEvent: mocks.automationEvaluate },
    } as never);

    const result = await service.reportFinding({
      userId: 'user-1',
      workspaceDir,
      sessionId: SESSION_ID,
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID, runId: RUN_ID },
      input: {
        assetRef: { kind: 'domain', value: 'api.example.com' },
        title: 'user-enum undifferentiated on password reset',
        severity: 'low',
        summary: 'POST /api/user/password/send-reset-email returns 200 "Email sent" for arbitrary emails. Lack of differential is consistent on first observation; validation should confirm across 10 emails.',
        signalClass: 'user-enum-undifferentiated',
        confidence: 0.4,
        evidence: [{ path: '/workspace/.artifacts/evidence.txt', label: 'observation' }],
      },
    });

    expect(result.findingId).toBe('finding-obs-2');
  });

  it('ingests OpenAPI specs into endpoint notes and validation leads', async () => {
    await mkdir(join(workspaceDir, '.artifacts'), { recursive: true });
    await writeFile(
      join(workspaceDir, '.artifacts', 'openapi.json'),
      JSON.stringify({
        openapi: '3.0.0',
        servers: [{ url: 'https://api.example.com' }],
        paths: {
          '/api/orders/{orderId}': {
            get: {
              operationId: 'getOrder',
              summary: 'Get order',
              parameters: [{ name: 'orderId', in: 'path' }],
            },
          },
        },
      }),
    );

    const existingAsset = {
      id: 'asset-1',
      tags: [],
      evidence: [],
      parentAssetId: null,
    };
    mocks.selectResults.push([existingAsset], [], [existingAsset], []);
    mocks.insertReturningResults.push([{ id: 'note-endpoint-1' }], [{ id: 'note-lead-1' }]);

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T05:00:00.000Z'),
    } as never);

    const result = await service.ingestScanArtifact({
      userId: 'user-1',
      workspaceDir,
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
        runId: RUN_ID,
      },
      input: {
        parser: 'openapi',
        artifactPath: '.artifacts/openapi.json',
        rootAssetRef: { kind: 'domain', value: 'api.example.com' },
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        parser: 'openapi',
        endpointNotesCreated: 1,
        observationsCreated: 1,
      }),
    );
    const noteInserts = mocks.insertCalls.filter(
      (call) => (call.table as { __table: string }).__table === 'inventory_notes',
    );
    expect(noteInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          values: expect.objectContaining({
            ntype: 'http.endpoint',
            data: expect.objectContaining({
              url: 'https://api.example.com/api/orders/{orderId}',
              method: 'GET',
              source: 'openapi',
              sourceArtifact: '.artifacts/openapi.json',
              summary: 'Get order',
              tags: [],
              urlTemplate: '/api/orders/{orderId}',
              pathParams: ['orderId'],
              queryParams: [],
              bodyParams: [],
              authHint: 'unspecified',
              confidence: 0.9,
            }),
          }),
        }),
        expect.objectContaining({
          values: expect.objectContaining({
            ntype: 'validation.lead',
            data: expect.objectContaining({
              source: 'openapi',
              riskFamily: 'idor',
              method: 'GET',
              path: '/api/orders/{orderId}',
              parameter: 'orderId',
            }),
          }),
        }),
      ]),
    );
  });

  it('parses YAML OpenAPI specs into rich route records and priority lead families', async () => {
    await mkdir(join(workspaceDir, '.artifacts'), { recursive: true });
    await writeFile(
      join(workspaceDir, '.artifacts', 'openapi.yaml'),
      [
        'openapi: 3.0.0',
        'security:',
        '  - bearerAuth: []',
        'servers:',
        '  - url: https://api.example.com/{version}',
        'paths:',
        '  /api/admin/users/{userId}:',
        '    patch:',
        '      operationId: updateAdminUser',
        '      security: []',
        '      parameters:',
        '        - name: userId',
        '          in: path',
        '      requestBody:',
        '        content:',
        '          application/json:',
        '            schema:',
        '              type: object',
        '              properties:',
        '                role:',
        '                  type: string',
        '                isAdmin:',
        '                  type: boolean',
        '  /api/reports/{reportId}:',
        '    get:',
        '      operationId: downloadReport',
        '      security: []',
        '      tags:',
        '        - reporting',
        '      parameters:',
        '        - name: reportId',
        '          in: path',
      ].join('\n'),
    );

    const existingAsset = {
      id: 'asset-1',
      tags: [],
      evidence: [],
      parentAssetId: null,
    };
    for (let index = 0; index < 9; index += 1) {
      mocks.selectResults.push([existingAsset], []);
      mocks.insertReturningResults.push([{ id: `note-${index + 1}` }]);
    }

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T05:00:00.000Z'),
    } as never);

    const result = await service.ingestScanArtifact({
      userId: 'user-1',
      workspaceDir,
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
        runId: RUN_ID,
      },
      input: {
        parser: 'openapi',
        artifactPath: '.artifacts/openapi.yaml',
        rootAssetRef: { kind: 'domain', value: 'api.example.com' },
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        parser: 'openapi',
        endpointNotesCreated: 2,
        observationsCreated: 7,
      }),
    );
    const noteInserts = mocks.insertCalls.filter(
      (call) => (call.table as { __table: string }).__table === 'inventory_notes',
    );
    const endpointInsert = noteInserts.find(
      (call) => (call.values as { ntype?: string }).ntype === 'http.endpoint',
    );
    expect(endpointInsert).toEqual(
      expect.objectContaining({
        values: expect.objectContaining({
          data: expect.objectContaining({
            url: 'https://api.example.com/api/admin/users/{userId}',
            sourceArtifact: '.artifacts/openapi.yaml',
            urlTemplate: '/api/admin/users/{userId}',
            method: 'PATCH',
            pathParams: ['userId'],
            bodyParams: ['isAdmin', 'role'],
            authHint: 'anonymous',
          }),
        }),
      }),
    );
    const leadFamilies = noteInserts
      .filter((call) => (call.values as { ntype?: string }).ntype === 'validation.lead')
      .map((call) => ((call.values as { data: { riskFamily: string } }).data.riskFamily))
      .sort();
    expect(leadFamilies).toEqual([
      'admin-boundary',
      'broken-auth',
      'idor',
      'idor',
      'information-disclosure',
      'mass-assignment',
      'sensitive-public-endpoint',
    ]);
    const reportEndpoint = noteInserts.find(
      (call) =>
        (call.values as { ntype?: string; data?: { url?: string } }).ntype === 'http.endpoint' &&
        (call.values as { data?: { url?: string } }).data?.url ===
          'https://api.example.com/api/reports/{reportId}',
    );
    expect(reportEndpoint).toEqual(
      expect.objectContaining({
        values: expect.objectContaining({
          data: expect.objectContaining({
            tags: ['reporting'],
            summary: 'downloadReport',
            authHint: 'anonymous',
          }),
        }),
      }),
    );
  });

  it('caps OpenAPI validation lead creation from large route catalogs', async () => {
    await mkdir(join(workspaceDir, '.artifacts'), { recursive: true });
    const paths = Object.fromEntries(
      Array.from({ length: 85 }, (_value, index) => {
        const number = index + 1;
        return [
          `/api/orders/${number}/{orderId}`,
          {
            get: {
              operationId: `getOrder${number}`,
              parameters: [{ name: 'orderId', in: 'path' }],
            },
          },
        ];
      }),
    );
    await writeFile(
      join(workspaceDir, '.artifacts', 'large-openapi.json'),
      JSON.stringify({
        openapi: '3.0.0',
        servers: [{ url: 'https://api.example.com' }],
        paths,
      }),
    );

    const existingAsset = {
      id: 'asset-1',
      tags: [],
      evidence: [],
      parentAssetId: null,
    };
    for (let index = 0; index < 165; index += 1) {
      mocks.selectResults.push([existingAsset], []);
      mocks.insertReturningResults.push([{ id: `note-${index + 1}` }]);
    }

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T05:00:00.000Z'),
    } as never);

    const result = await service.ingestScanArtifact({
      userId: 'user-1',
      workspaceDir,
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
        runId: RUN_ID,
      },
      input: {
        parser: 'openapi',
        artifactPath: '.artifacts/large-openapi.json',
        rootAssetRef: { kind: 'domain', value: 'api.example.com' },
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        parser: 'openapi',
        endpointNotesCreated: 85,
        observationsCreated: 80,
        skipped: 5,
      }),
    );
    const validationLeadInserts = mocks.insertCalls.filter(
      (call) =>
        (call.table as { __table: string }).__table === 'inventory_notes' &&
        (call.values as { ntype?: string }).ntype === 'validation.lead',
    );
    expect(validationLeadInserts).toHaveLength(80);
  });

  it('reopens a resolved finding and keeps validation when only excerpt evidence remains', async () => {
    mocks.selectResults.push(
      [{ id: 'asset-1', tags: ['prod'], evidence: [] }],
      [
        {
          id: 'finding-1',
          dedupeKey: 'existing-dedupe-key',
          state: 'resolved',
          title: 'Cross-site scripting in search',
          severity: 'high',
          summary: 'Reflected XSS in the search parameter',
          businessImpact: null,
          technicalAnalysis: null,
          pocDescription: null,
          pocScriptCode: null,
          assumptions: null,
          fixEffort: null,
          remediation: null,
          confidenceScore: 0.4,
          cweId: null,
          cveId: null,
          cweIds: null,
          cveIds: null,
          owaspCategory: null,
          cvssVector: null,
          cvssScore: null,
        },
      ],
      [],
    );

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T05:30:00.000Z'),
      automationService: { evaluateEvent: mocks.automationEvaluate },
    } as never);

    const result = await service.reportFinding({
      userId: 'user-1',
      workspaceDir,
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID },
      input: {
        assetRef: { kind: 'domain', value: 'api.example.com' },
        title: 'Cross-site scripting in search',
        severity: 'high',
        summary: 'Reflected XSS in the search parameter',
        ...findingContractFields,
        evidence: [
          {
            path: '/workspace/.artifacts/missing-proof.txt',
            excerpt: 'Stored excerpt when artifact no longer exists',
          },
        ],
      },
    });

    expect(result).toEqual(expect.objectContaining({
      findingId: 'finding-1',
      created: false,
      dedupeKey: expect.any(String),
      state: 'confirmed',
      lifecycleStage: 'reportable',
      evidenceGate: expect.objectContaining({ passed: false }),
    }));

    const findingUpdate = mocks.updateCalls.find(
      (call) => (call.table as { __table: string }).__table === 'findings',
    );
    expect(findingUpdate).toMatchObject({
      values: expect.objectContaining({
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
        assetId: 'asset-1',
        title: 'Cross-site scripting in search',
        severity: 'high',
        state: 'confirmed',
        summary: 'Reflected XSS in the search parameter',
        businessImpact: findingContractFields.businessImpact,
        technicalAnalysis: findingContractFields.technicalAnalysis,
        pocDescription: findingContractFields.pocDescription,
        pocScriptCode: findingContractFields.pocScriptCode,
        assumptions: findingContractFields.assumptions,
        fixEffort: findingContractFields.fixEffort,
        remediation: findingContractFields.remediation,
        confidenceScore: 0.4,
      }),
    });

    const findingEventInserts = mocks.insertCalls.filter(
      (call) => (call.table as { __table: string }).__table === 'finding_events',
    );
    expect(findingEventInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          values: expect.objectContaining({
            findingId: 'finding-1',
            type: 'state_changed',
            fromState: 'resolved',
            toState: 'confirmed',
            note: 'Auto-reopened on re-detection',
          }),
        }),
        expect.objectContaining({
          values: expect.objectContaining({
            findingId: 'finding-1',
            type: 'dedup_merged',
          }),
        }),
      ]),
    );

    const evidenceInsert = mocks.insertCalls.find(
      (call) => (call.table as { __table: string }).__table === 'finding_evidence',
    );
    expect(evidenceInsert).toMatchObject({
      values: expect.objectContaining({
        findingId: 'finding-1',
        path: '.artifacts/missing-proof.txt',
        excerpt: 'Stored excerpt when artifact no longer exists',
        fileMissing: true,
      }),
      onConflictDoNothing: expect.anything(),
    });

    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      {
        evidencePath: '/workspace/.artifacts/missing-proof.txt',
        relativePath: '.artifacts/missing-proof.txt',
      },
      '[security-ops] Missing evidence file; storing excerpt-only evidence',
    );
    expect(mocks.automationEvaluate).not.toHaveBeenCalled();
  });

  it('rejects invalid fixEffort values before writing a finding', async () => {
    const service = new SecurityOpsToolService({ db: mocks.db } as never);

    await expect(
      service.reportFinding({
        userId: 'user-1',
        workspaceDir,
        context: { organizationId: ORG_ID, scopeId: SCOPE_ID },
        input: {
          assetRef: { kind: 'domain', value: 'api.example.com' },
          title: 'Invalid fix effort',
          severity: 'medium',
          summary: 'Should fail schema validation.',
          businessImpact: findingContractFields.businessImpact,
          technicalAnalysis: findingContractFields.technicalAnalysis,
          pocDescription: findingContractFields.pocDescription,
          pocScriptCode: findingContractFields.pocScriptCode,
          assumptions: findingContractFields.assumptions,
          fixEffort: 'impossible',
          remediation: findingContractFields.remediation,
          evidence: [{ path: '/workspace/.artifacts/proof.txt', excerpt: 'proof' }],
        },
      }),
    ).rejects.toThrowError(/fixEffort/i);
  });

  it('merges into an existing finding when the duplicate judge confirms a semantic duplicate', async () => {
    const duplicateJudge = {
      checkDuplicate: vi.fn().mockResolvedValue({
        isDuplicate: true,
        duplicateId: 'finding-2',
        confidence: 0.97,
        reason: 'Same endpoint and root cause',
      }),
    };
    mocks.selectResults.push(
      [{ id: 'asset-1', tags: ['prod'], evidence: [] }],
      [],
      [],
      [
        {
          id: 'finding-2',
          dedupeKey: 'existing-dedupe-key',
          title: 'Stored XSS in search',
          severity: 'medium',
          state: 'potential',
          summary: 'Existing canonical summary',
          businessImpact: null,
          technicalAnalysis: null,
          pocDescription: null,
          pocScriptCode: null,
          assumptions: null,
          fixEffort: null,
          remediation: null,
          confidenceScore: 0.4,
          cweId: null,
          cveId: null,
          cweIds: null,
          cveIds: null,
          owaspCategory: null,
          cvssVector: null,
          cvssScore: null,
          endpointId: null,
          serviceId: null,
        },
      ],
    );

    const service = new SecurityOpsToolService({
      db: mocks.db,
      duplicateJudge,
      now: () => new Date('2026-03-21T05:45:00.000Z'),
    } as never);

    const result = await service.reportFinding({
      userId: 'user-1',
      workspaceDir,
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID },
      input: {
        assetRef: { kind: 'domain', value: 'api.example.com' },
        title: 'Reflected XSS via search',
        severity: 'high',
        summary: 'A second wording of the same issue.',
        ...findingContractFields,
        evidence: [{ path: '/workspace/.artifacts/missing-proof.txt', excerpt: 'proof' }],
      },
    });

    expect(result).toEqual(expect.objectContaining({
      findingId: 'finding-2',
      created: false,
      dedupeKey: 'existing-dedupe-key',
      dedupe: expect.objectContaining({
        matchedBy: 'llm_judge',
        mergedFindingId: 'finding-2',
        parts: expect.objectContaining({
          target: expect.any(String),
          surface: expect.any(String),
          vulnerabilityClass: expect.any(String),
        }),
      }),
      warnings: expect.arrayContaining([
        expect.stringContaining('different title'),
      ]),
      state: 'potential',
      lifecycleStage: 'candidate',
    }));
    expect(duplicateJudge.checkDuplicate).toHaveBeenCalledTimes(1);

    const findingInsert = mocks.insertCalls.find(
      (call) => (call.table as { __table: string }).__table === 'findings',
    );
    expect(findingInsert).toBeUndefined();

    const findingUpdate = mocks.updateCalls.find(
      (call) => (call.table as { __table: string }).__table === 'findings',
    );
    expect(findingUpdate).toMatchObject({
      values: expect.objectContaining({
        title: 'Stored XSS in search',
        summary: 'Existing canonical summary',
        businessImpact: findingContractFields.businessImpact,
        technicalAnalysis: findingContractFields.technicalAnalysis,
        pocDescription: findingContractFields.pocDescription,
        pocScriptCode: findingContractFields.pocScriptCode,
        assumptions: findingContractFields.assumptions,
        fixEffort: findingContractFields.fixEffort,
        remediation: findingContractFields.remediation,
        severity: 'high',
      }),
    });
  });

  it('requires explicit confirmation before LLM dedupe merges a different finding family', async () => {
    const duplicateJudge = {
      checkDuplicate: vi.fn().mockResolvedValue({
        isDuplicate: true,
        duplicateId: 'finding-2',
        confidence: 0.91,
        reason: 'Over-broad semantic match',
      }),
    };
    mocks.selectResults.push(
      [{ id: 'asset-1', tags: ['prod'], evidence: [] }],
      [],
      [],
      [
        {
          id: 'finding-2',
          dedupeKey: 'existing-dedupe-key',
          title: 'Grafana version disclosure',
          severity: 'medium',
          state: 'potential',
          summary: 'Grafana exposes a version banner.',
          businessImpact: null,
          technicalAnalysis: null,
          pocDescription: null,
          pocScriptCode: null,
          assumptions: null,
          fixEffort: null,
          remediation: null,
          confidenceScore: 0.4,
          cweId: null,
          cveId: null,
          cweIds: null,
          cveIds: null,
          owaspCategory: null,
          cvssVector: null,
          cvssScore: null,
          endpointId: null,
          serviceId: null,
        },
      ],
    );

    const service = new SecurityOpsToolService({
      db: mocks.db,
      duplicateJudge,
      now: () => new Date('2026-03-21T05:46:00.000Z'),
    } as never);

    await expect(
      service.reportFinding({
        userId: 'user-1',
        workspaceDir,
        context: { organizationId: ORG_ID, scopeId: SCOPE_ID },
        input: {
          assetRef: { kind: 'domain', value: 'api.example.com' },
          title: 'WordPress plugin SSRF pattern',
          severity: 'high',
          summary: 'A JavaScript route suggests an SSRF-like fetch pattern.',
          ...findingContractFields,
          evidence: [{ path: '/workspace/.artifacts/missing-proof.txt', excerpt: 'proof' }],
        },
      }),
    ).rejects.toThrow(/requires explicit confirmation/);

    expect(duplicateJudge.checkDuplicate).toHaveBeenCalledTimes(1);
    expect(mocks.updateCalls.find((call) => (call.table as { __table: string }).__table === 'findings')).toBeUndefined();
  });

  it('falls back to exact dedupe behavior when the duplicate judge does not confirm a match', async () => {
    const duplicateJudge = {
      checkDuplicate: vi.fn().mockResolvedValue({
        isDuplicate: false,
        duplicateId: '',
        confidence: 0,
        reason: 'judge failure fallback',
        error: 'timeout',
      }),
    };
    mocks.selectResults.push(
      [{ id: 'asset-1', tags: ['prod'], evidence: [] }],
      [],
      [],
      [
        {
          id: 'finding-2',
          dedupeKey: 'existing-dedupe-key',
          title: 'Another finding',
          severity: 'medium',
          state: 'potential',
          summary: 'Existing unrelated issue',
          businessImpact: null,
          technicalAnalysis: null,
          pocDescription: null,
          pocScriptCode: null,
          assumptions: null,
          fixEffort: null,
          remediation: null,
          confidenceScore: null,
          cweId: null,
          cveId: null,
          cweIds: null,
          cveIds: null,
          owaspCategory: null,
          cvssVector: null,
          cvssScore: null,
          endpointId: null,
          serviceId: null,
        },
      ],
    );
    mocks.insertReturningResults.push([{ id: 'finding-new' }]);

    const service = new SecurityOpsToolService({
      db: mocks.db,
      duplicateJudge,
      now: () => new Date('2026-03-21T05:50:00.000Z'),
    } as never);

    const result = await service.reportFinding({
      userId: 'user-1',
      workspaceDir,
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID },
      input: {
        assetRef: { kind: 'domain', value: 'api.example.com' },
        title: 'Distinct finding after judge failure',
        severity: 'medium',
        summary: 'Should create a new finding.',
        ...findingContractFields,
        evidence: [{ path: '/workspace/.artifacts/missing-proof.txt', excerpt: 'proof' }],
      },
    });

    expect(result).toEqual(expect.objectContaining({
      findingId: 'finding-new',
      created: true,
      dedupeKey: expect.any(String),
      state: 'potential',
      lifecycleStage: 'candidate',
    }));
    expect(duplicateJudge.checkDuplicate).toHaveBeenCalledTimes(1);
  });

  it('merges structurally identical findings on the same canonical target without duplicate judging', async () => {
    mocks.selectResults.push(
      [{ id: 'asset-2', tags: ['prod'], evidence: [] }],
      [],
      [],
      [
        {
          id: 'finding-existing',
          assetKind: 'domain',
          assetValue: 'api.example.com',
          dedupeKey: 'legacy-dedupe-key',
          title: 'Internal backend IP address exposed',
          severity: 'medium',
          state: 'confirmed',
          summary: 'Existing canonical summary',
          businessImpact: null,
          technicalAnalysis: null,
          pocDescription: null,
          pocScriptCode: null,
          assumptions: null,
          fixEffort: null,
          remediation: null,
          confidenceScore: 0.8,
          cweId: 'CWE-200',
          cveId: null,
          cweIds: ['CWE-200'],
          cveIds: null,
          owaspCategory: null,
          cvssVector: null,
          cvssScore: null,
          endpointId: null,
          serviceId: null,
          codeLocations: [],
        },
      ],
    );

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T05:52:00.000Z'),
    } as never);

    const result = await service.reportFinding({
      userId: 'user-1',
      workspaceDir,
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID, runId: RUN_ID },
      input: {
        assetRef: { kind: 'domain', value: 'https://api.example.com/frame' },
        title: 'Internal backend IP address exposed',
        severity: 'medium',
        summary: 'Same exposure observed again.',
        ...findingContractFields,
        cweIds: ['CWE-200'],
        evidence: [{ path: '/workspace/.artifacts/missing-proof.txt', excerpt: '10.0.0.5' }],
      },
    });

    expect(result).toEqual(expect.objectContaining({
      findingId: 'finding-existing',
      created: false,
      state: 'confirmed',
      lifecycleStage: 'reportable',
    }));
    expect(
      mocks.insertCalls.some(
        (call) =>
          (call.table as { __table: string }).__table === 'finding_events' &&
          (call.values as Record<string, unknown>).type === 'dedup_merged',
      ),
    ).toBe(true);
  });

  it('bypasses duplicate judging when validatesFindingId is provided', async () => {
    const duplicateJudge = {
      checkDuplicate: vi.fn(),
    };
    mocks.selectResults.push(
      [{ id: 'asset-1', tags: ['prod'], evidence: [] }],
      [
        {
          id: '55555555-5555-4555-8555-555555555555',
          dedupeKey: 'validated-dedupe-key',
          title: 'Existing finding',
          severity: 'high',
          state: 'confirmed',
          summary: 'Existing summary',
          businessImpact: findingContractFields.businessImpact,
          technicalAnalysis: findingContractFields.technicalAnalysis,
          pocDescription: findingContractFields.pocDescription,
          pocScriptCode: findingContractFields.pocScriptCode,
          assumptions: findingContractFields.assumptions,
          fixEffort: findingContractFields.fixEffort,
          remediation: findingContractFields.remediation,
          confidenceScore: 0.8,
          cweId: null,
          cveId: null,
          cweIds: null,
          cveIds: null,
          owaspCategory: null,
          cvssVector: null,
          cvssScore: null,
          endpointId: null,
          serviceId: null,
        },
      ],
    );

    const service = new SecurityOpsToolService({
      db: mocks.db,
      duplicateJudge,
      now: () => new Date('2026-03-21T05:55:00.000Z'),
    } as never);

    const result = await service.reportFinding({
      userId: 'user-1',
      workspaceDir,
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID },
      input: {
        assetRef: { kind: 'domain', value: 'api.example.com' },
        title: 'Existing finding',
        severity: 'high',
        summary: 'Validated rerun evidence',
        ...findingContractFields,
        validatesFindingId: '55555555-5555-4555-8555-555555555555',
        evidence: [{ path: '/workspace/.artifacts/missing-proof.txt', excerpt: 'proof' }],
      },
    });

    expect(result).toEqual(expect.objectContaining({
      findingId: '55555555-5555-4555-8555-555555555555',
      created: false,
      dedupeKey: 'validated-dedupe-key',
      state: 'confirmed',
      lifecycleStage: 'reportable',
    }));
    expect(duplicateJudge.checkDuplicate).not.toHaveBeenCalled();
  });

  it('prevents report_finding from creating new rows in the reporting phase', async () => {
    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T05:56:00.000Z'),
    } as never);

    await expect(
      service.reportFinding({
        userId: 'user-1',
        workspaceDir,
        context: { organizationId: ORG_ID, scopeId: SCOPE_ID, runId: RUN_ID, activePhaseKey: 'reporting' },
        input: {
          assetRef: { kind: 'domain', value: 'api.example.com' },
          title: 'Reporter-created finding should be rejected',
          severity: 'medium',
          summary: 'Reporting must repair canonical rows, not create new candidate rows.',
          ...findingContractFields,
          evidence: [{ path: '/workspace/.artifacts/missing-proof.txt', excerpt: 'proof' }],
        },
      }),
    ).rejects.toThrow(/repair-only in the reporting phase/);

    expect(mocks.insertCalls).toHaveLength(0);
    expect(mocks.updateCalls).toHaveLength(0);
  });

  it('requires reporting phase report_finding repairs to include canonical report fields', async () => {
    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T05:57:00.000Z'),
    } as never);

    await expect(
      service.reportFinding({
        userId: 'user-1',
        workspaceDir,
        context: { organizationId: ORG_ID, scopeId: SCOPE_ID, runId: RUN_ID, activePhaseKey: 'reporting' },
        input: {
          assetRef: { kind: 'domain', value: 'api.example.com' },
          title: 'Existing sparse finding',
          severity: 'high',
          summary: 'Fresh evidence without report prose is not enough in reporting.',
          validatesFindingId: '55555555-5555-4555-8555-555555555555',
          evidence: [{ path: '/workspace/.artifacts/missing-proof.txt', excerpt: 'proof' }],
        },
      }),
    ).rejects.toThrow(/must backfill at least one final-report field/);

    expect(mocks.insertCalls).toHaveLength(0);
    expect(mocks.updateCalls).toHaveLength(0);
  });

  it('allows reporting phase report_finding to backfill an existing sparse canonical finding', async () => {
    mocks.selectResults.push(
      [{ id: 'asset-1', tags: ['prod'], evidence: [] }],
      [
        {
          id: '55555555-5555-4555-8555-555555555555',
          dedupeKey: 'validated-dedupe-key',
          title: 'Existing sparse finding',
          severity: 'high',
          state: 'confirmed',
          summary: 'Existing sparse summary',
          businessImpact: null,
          technicalAnalysis: null,
          pocDescription: null,
          pocScriptCode: null,
          assumptions: null,
          fixEffort: null,
          remediation: null,
          confidenceScore: 0.8,
          cweId: null,
          cveId: null,
          cweIds: null,
          cveIds: null,
          owaspCategory: null,
          cvssVector: null,
          cvssScore: null,
          endpointId: null,
          serviceId: null,
          codeLocations: [],
        },
      ],
    );

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T05:58:00.000Z'),
    } as never);

    const result = await service.reportFinding({
      userId: 'user-1',
      workspaceDir,
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID, runId: RUN_ID, activePhaseKey: 'reporting' },
      input: {
        assetRef: { kind: 'domain', value: 'api.example.com' },
        title: 'Existing sparse finding',
        severity: 'high',
        summary: 'Existing sparse summary',
        businessImpact: 'Authenticated users can read another account order by changing the orderId value.',
        technicalAnalysis: 'The order detail endpoint trusts orderId before enforcing ownership and returns data instead of 403.',
        pocDescription: 'Use the same account to request GET /orders/1001 and GET /orders/1002; the second request returns another account order instead of 403.',
        assumptions: 'The attacker has a valid account and can guess or observe sequential order identifiers.',
        remediation: 'Enforce server-side ownership checks on order reads, derive scope from the authenticated principal, return 403 for cross-account IDs, and add regression tests.',
        validatesFindingId: '55555555-5555-4555-8555-555555555555',
        evidence: [{ path: '/workspace/.artifacts/missing-proof.txt', excerpt: 'proof' }],
      },
    });

    expect(result).toEqual(expect.objectContaining({
      findingId: '55555555-5555-4555-8555-555555555555',
      created: false,
      state: 'confirmed',
      lifecycleStage: 'reportable',
    }));
    expect(result.reportCompleteness.missingReportFields).toEqual([]);

    const findingUpdate = mocks.updateCalls.find(
      (call) => (call.table as { __table: string }).__table === 'findings',
    );
    expect(findingUpdate).toMatchObject({
      values: expect.objectContaining({
        businessImpact: 'Authenticated users can read another account order by changing the orderId value.',
        technicalAnalysis: 'The order detail endpoint trusts orderId before enforcing ownership and returns data instead of 403.',
        pocDescription: 'Use the same account to request GET /orders/1001 and GET /orders/1002; the second request returns another account order instead of 403.',
        assumptions: 'The attacker has a valid account and can guess or observe sequential order identifiers.',
        remediation: 'Enforce server-side ownership checks on order reads, derive scope from the authenticated principal, return 403 for cross-account IDs, and add regression tests.',
      }),
    });
  });

  it('queues independent validation when a candidate finding has durable evidence', async () => {
    mocks.selectResults.push(
      [
        {
          id: 'finding-1',
          title: 'Missing security headers',
          severity: 'low',
          dedupeKey: 'dedupe-1',
          state: 'potential',
          organizationId: ORG_ID,
        },
      ],
      [{ kind: 'http_exchange', fileMissing: false }],
      [],
    );

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T06:00:00.000Z'),
    } as never);

    const result = await service.promoteFinding({
      userId: 'user-1',
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID },
      input: {
        findingId: '55555555-5555-4555-8555-555555555555',
        rationale: 'Structured request and response prove the issue.',
      },
    });

    expect(result).toEqual({
      findingId: '55555555-5555-4555-8555-555555555555',
      promoted: false,
      alreadyReportable: false,
      state: 'verifying',
      lifecycleStage: 'candidate',
      dedupeKey: 'dedupe-1',
      durableEvidenceCount: 1,
      validationPending: true,
      action: 'queued',
      nextAction: 'submit_validation_outcome',
      reportCompleteness: {
        missingReportFields: ['businessImpact', 'technicalAnalysis', 'pocDescription', 'assumptions', 'remediation'],
        advisoryMissingFields: ['fixEffort', 'cweIds', 'cvss', 'owaspCategory'],
        canFinalizeReportable: false,
        repairInstruction: expect.stringContaining('validatesFindingId="finding-1"'),
      },
    });
    expect(mocks.updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          values: expect.objectContaining({ state: 'verifying' }),
        }),
      ]),
    );
    expect(
      mocks.insertCalls.some(
        (call) =>
          (call.table as { __table: string }).__table === 'finding_events' &&
          (call.values as Record<string, unknown>).type === 'state_changed' &&
          typeof (call.values as Record<string, unknown>).note === 'string' &&
          ((call.values as Record<string, unknown>).note as string).includes('Validation requested'),
      ),
    ).toBe(true);
  });

  it('is idempotent when the finding is already reportable and durable evidence is present', async () => {
    mocks.selectResults.push(
      [
        {
          id: 'finding-1',
          title: 'Missing security headers',
          severity: 'low',
          dedupeKey: 'dedupe-1',
          state: 'confirmed',
          organizationId: ORG_ID,
        },
      ],
      [{ kind: 'http_exchange', fileMissing: false }],
      [],
    );

    const service = new SecurityOpsToolService({ db: mocks.db } as never);

    const result = await service.promoteFinding({
      userId: 'user-1',
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID },
      input: { findingId: '55555555-5555-4555-8555-555555555555' },
    });

    expect(result).toEqual({
      findingId: '55555555-5555-4555-8555-555555555555',
      promoted: false,
      alreadyReportable: true,
      state: 'confirmed',
      lifecycleStage: 'reportable',
      dedupeKey: 'dedupe-1',
      durableEvidenceCount: 1,
      action: 'already_validated',
      nextAction: 'none',
      reportCompleteness: {
        missingReportFields: ['businessImpact', 'technicalAnalysis', 'pocDescription', 'assumptions', 'remediation'],
        advisoryMissingFields: ['fixEffort', 'cweIds', 'cvss', 'owaspCategory'],
        canFinalizeReportable: false,
        repairInstruction: expect.stringContaining('validatesFindingId="finding-1"'),
      },
    });
    expect(mocks.updateCalls).toHaveLength(0);
  });

  it('rejects promote_finding when durable evidence is missing', async () => {
    mocks.selectResults.push(
      [
        {
          id: 'finding-1',
          title: 'Missing security headers',
          severity: 'low',
          dedupeKey: 'dedupe-1',
          state: 'potential',
          organizationId: ORG_ID,
        },
      ],
      [],
    );

    const service = new SecurityOpsToolService({ db: mocks.db } as never);

    await expect(
      service.promoteFinding({
        userId: 'user-1',
        context: { organizationId: ORG_ID, scopeId: SCOPE_ID },
        input: {
          findingId: '55555555-5555-4555-8555-555555555555',
        },
      }),
    ).rejects.toThrow(
      'Durable evidence means at least one http_exchange entry, or a non-missing artifact',
    );
    expect(mocks.updateCalls).toHaveLength(0);
  });

  it('rejects duplicate promotion and points new evidence at the existing reportable finding', async () => {
    mocks.selectResults.push(
      [
        {
          id: 'finding-2',
          title: 'Duplicate security headers',
          severity: 'low',
          dedupeKey: 'dedupe-1',
          state: 'potential',
          organizationId: ORG_ID,
        },
      ],
      [{ kind: 'http_exchange', fileMissing: false }],
      [{ id: 'finding-1', title: 'Missing security headers', severity: 'low' }],
    );

    const service = new SecurityOpsToolService({ db: mocks.db } as never);

    await expect(
      service.promoteFinding({
        userId: 'user-1',
        context: { organizationId: ORG_ID, scopeId: SCOPE_ID },
        input: {
          findingId: '66666666-6666-4666-8666-666666666666',
        },
      }),
    ).rejects.toThrow(
      'duplicates an already-reportable finding',
    );
    expect(mocks.updateCalls).toHaveLength(0);
  });

  it('accepts validation lead closeout without promptSha256 when the stored lead has one', async () => {
    const leadId = '11111111-1111-4111-8111-111111111111';
    const storedPromptSha = 'a'.repeat(64);
    mocks.selectResults.push(
      [
        {
          id: leadId,
          data: {
            source: 'validation.lead',
            riskFamily: 'idor',
            hypothesis: 'Validate whether order IDs are tenant-isolated.',
            status: 'open',
            promptSha256: storedPromptSha,
            promptPath: '.artifacts/lead-prompts/lead.md',
          },
        },
      ],
      [],
    );

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T06:00:00.000Z'),
    } as never);

    const result = await service.submitValidationLeadOutcome({
      userId: 'user-1',
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID, runId: RUN_ID },
      input: {
        leadId,
        outcome: 'blocked',
        blockerCode: 'needs-auth',
        nextPrerequisite: 'Valid tenant credentials',
      },
    });

    expect(result).toEqual(expect.objectContaining({
      leadId,
      outcome: 'blocked',
      requestedOutcome: 'blocked',
      blockerCode: 'needs-auth',
      canonicalBlockerCode: 'auth_required',
      promptSha256: storedPromptSha,
      attempts: 1,
      remainingOpenLeadIds: [],
    }));
    expect(mocks.updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: expect.objectContaining({ __table: 'inventory_notes' }),
          values: expect.objectContaining({
            data: expect.objectContaining({
              status: 'blocked',
              lastBlockerCode: 'needs-auth',
              lastCanonicalBlockerCode: 'auth_required',
              nextPrerequisite: 'Valid tenant credentials',
            }),
          }),
        }),
      ]),
    );
  });

  it('canonicalizes free-form validation lead blockers while preserving the raw blocker code', async () => {
    const leadId = '11111111-1111-4111-8111-111111111111';
    mocks.selectResults.push(
      [
        {
          id: leadId,
          data: {
            source: 'validation.lead',
            riskFamily: 'broken-auth',
            hypothesis: 'Validate whether account state permits authenticated proof.',
            status: 'blocked',
            attempts: 2,
            lastBlockerCode: 'missing_verified_account',
            lastCanonicalBlockerCode: 'account_state_required',
            blockerRepeatCount: 2,
            observations: [],
          },
        },
      ],
      [],
    );

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T06:00:00.000Z'),
    } as never);

    const result = await service.submitValidationLeadOutcome({
      userId: 'user-1',
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID, runId: RUN_ID },
      input: {
        leadId,
        outcome: 'blocked',
        blockerCode: 'no_verified_account',
      },
    });

    expect(result).toEqual(expect.objectContaining({
      leadId,
      outcome: 'deferred',
      requestedOutcome: 'blocked',
      blockerCode: 'no_verified_account',
      canonicalBlockerCode: 'account_state_required',
      attempts: 3,
      autoDeferred: true,
    }));
    expect(mocks.updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          values: expect.objectContaining({
            data: expect.objectContaining({
              status: 'deferred',
              lastBlockerCode: 'no_verified_account',
              lastCanonicalBlockerCode: 'account_state_required',
              blockerRepeatCount: 3,
              observations: [
                expect.objectContaining({
                  technique: 'blocked_prerequisite',
                  result: 'inconclusive',
                }),
              ],
            }),
          }),
        }),
      ]),
    );
  });

  it('rejects validation lead closeout when a provided promptSha256 does not match the stored prompt', async () => {
    const leadId = '11111111-1111-4111-8111-111111111111';
    mocks.selectResults.push([
      {
        id: leadId,
        data: {
          source: 'validation.lead',
          riskFamily: 'idor',
          hypothesis: 'Validate whether order IDs are tenant-isolated.',
          status: 'open',
          promptSha256: 'a'.repeat(64),
        },
      },
    ]);

    const service = new SecurityOpsToolService({ db: mocks.db } as never);

    await expect(
      service.submitValidationLeadOutcome({
        userId: 'user-1',
        context: { organizationId: ORG_ID, scopeId: SCOPE_ID },
        input: {
          leadId,
          promptSha256: 'b'.repeat(64),
          outcome: 'blocked',
          blockerCode: 'needs-auth',
        },
      }),
    ).rejects.toThrow('promptSha256 does not match rendered lead prompt');
    expect(mocks.updateCalls).toHaveLength(0);
  });

  it('blocks final artifacts when RunCompletion has incomplete work or promotable candidates', async () => {
    mocks.selectResults.push(
      [
        {
          id: 'finding-1',
          assetId: 'asset-1',
          title: 'Missing security headers',
          severity: 'low',
          state: 'potential',
          summary: 'Headers are missing.',
          businessImpact: 'Browsers cannot enforce modern client-side protections.',
          technicalAnalysis: 'The response lacks HSTS and CSP headers.',
          pocDescription: 'Request the landing page and inspect response headers.',
          pocScriptCode: 'curl -I https://example.com',
          assumptions: 'The observed response is representative of the public surface.',
          fixEffort: 'low',
          remediation: 'Add headers.',
          cvssVector: null,
          cvssScore: null,
          confidenceScore: 0.8,
          cweId: 'CWE-693',
          cveId: null,
          cweIds: ['CWE-693'],
          cveIds: null,
          owaspCategory: 'A05:2021-Security Misconfiguration',
          endpointId: null,
          serviceId: null,
          codeLocations: [],
          firstSeenAt: new Date('2026-03-21T06:00:00.000Z'),
          lastSeenAt: new Date('2026-03-21T06:15:00.000Z'),
          dedupeKey: 'dedupe-1',
        },
      ],
      [],
      [{ findingId: 'finding-1', kind: 'http_exchange', fileMissing: false }],
      [],
    );

    const service = new SecurityOpsToolService({ db: mocks.db } as never);

    await expect(
      service.finalizeRunArtifacts({
        userId: 'user-1',
        workspaceDir,
        context: { organizationId: ORG_ID, scopeId: SCOPE_ID },
        input: { mode: 'final' },
        reportedFindingIds: ['finding-1'],
        plan: [{ id: 'task-1', title: 'Validate IDOR', status: 'running' }],
      }),
    ).rejects.toThrow('Cannot finalize run as final');
  });

  it('blocks final artifacts when a validated finding is missing canonical report fields', async () => {
    mocks.selectResults.push(
      [
        {
          id: 'finding-1',
          assetId: 'asset-1',
          title: 'Missing security headers',
          severity: 'low',
          state: 'confirmed',
          summary: 'Headers are missing.',
          businessImpact: '',
          technicalAnalysis: '',
          pocDescription: '',
          pocScriptCode: '',
          assumptions: '',
          fixEffort: null,
          remediation: '',
          cvssVector: null,
          cvssScore: null,
          confidenceScore: 0.8,
          cweId: null,
          cveId: null,
          cweIds: null,
          cveIds: null,
          owaspCategory: null,
          endpointId: null,
          serviceId: null,
          codeLocations: [],
          firstSeenAt: new Date('2026-03-21T06:00:00.000Z'),
          lastSeenAt: new Date('2026-03-21T06:15:00.000Z'),
          dedupeKey: 'dedupe-1',
        },
      ],
      [],
      [{ findingId: 'finding-1', kind: 'http_exchange', fileMissing: false }],
      [],
    );

    const service = new SecurityOpsToolService({ db: mocks.db } as never);

    await expect(
      service.finalizeRunArtifacts({
        userId: 'user-1',
        workspaceDir,
        context: { organizationId: ORG_ID, scopeId: SCOPE_ID },
        input: { mode: 'final' },
        reportedFindingIds: ['finding-1'],
        plan: [{ id: 'task-1', title: 'Validate finding', status: 'completed' }],
      }),
    ).rejects.toThrow(
      'validated finding finding-1 missing report fields: businessImpact, technicalAnalysis, pocDescription, assumptions, remediation',
    );
  });

  it('uses canonical completed run phases instead of stale session plan steps for finalizer readiness', async () => {
    mocks.selectResults.push(
      [
        { id: 'phase-recon', phaseKey: 'recon', status: 'completed', sessionId: 'session-recon', lastError: null },
        { id: 'phase-reporting', phaseKey: 'reporting', status: 'completed', sessionId: SESSION_ID, lastError: null },
      ],
      [{ findingId: 'finding-1' }],
      [
        {
          id: 'finding-1',
          assetId: 'asset-1',
          title: 'Missing security headers',
          severity: 'low',
          state: 'confirmed',
          summary: 'Headers are missing.',
          businessImpact: 'Browsers lose defense-in-depth protection.',
          technicalAnalysis: 'HSTS and CSP are absent from the root response.',
          pocDescription: 'Request the root page and inspect response headers.',
          pocScriptCode: 'curl -I https://example.com',
          assumptions: 'The sampled root page is representative of the public surface.',
          fixEffort: 'low',
          remediation: 'Add HSTS and CSP headers.',
          cvssVector: null,
          cvssScore: null,
          confidenceScore: 0.8,
          cweId: 'CWE-693',
          cveId: null,
          cweIds: ['CWE-693'],
          cveIds: null,
          owaspCategory: 'A05:2021-Security Misconfiguration',
          endpointId: null,
          serviceId: null,
          codeLocations: [],
          firstSeenAt: new Date('2026-03-21T06:00:00.000Z'),
          lastSeenAt: new Date('2026-03-21T06:15:00.000Z'),
          dedupeKey: 'dedupe-1',
        },
      ],
      [],
      [{ findingId: 'finding-1', kind: 'http_exchange', fileMissing: false }],
      [],
      [],
      [],
    );

    const service = new SecurityOpsToolService({ db: mocks.db } as never);

    const result = await service.reportFinalizerPreflight({
      userId: 'user-1',
      workspaceDir,
      sessionId: SESSION_ID,
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID, runId: RUN_ID },
      input: {},
      reportedFindingIds: ['finding-1'],
      plan: [{ id: 'stale-reporting-step', title: 'Write report', status: 'pending' }],
    });

    expect({
      canFinalizeFinal: result.canFinalizeFinal,
      blockers: result.finalizerBlockers,
      runCompletion: result.runCompletion,
      missingReportFieldBlockers: result.missingReportFieldBlockers,
      missingDurableEvidenceBlockers: result.missingDurableEvidenceBlockers,
    }).toEqual({
      canFinalizeFinal: true,
      blockers: [],
      runCompletion: expect.objectContaining({
        state: 'ready_for_finalization',
        incompletePlanSteps: [],
      }),
      missingReportFieldBlockers: [],
      missingDurableEvidenceBlockers: [],
    });
    expect(result.requiredMode).toBe('final');
    expect(result.runCompletion.state).toBe('ready_for_finalization');
    expect(result.runCompletion.incompletePlanSteps).toEqual([]);
  });

  it('prepares reporter handoff artifacts from canonical state', async () => {
    mocks.selectResults.push(
      [
        {
          id: 'finding-1',
          assetId: 'asset-1',
          title: 'Missing security headers',
          severity: 'low',
          state: 'confirmed',
          summary: 'Headers are missing.',
          businessImpact: 'Limited browser-side defense in depth.',
          technicalAnalysis: 'HSTS and CSP are absent on the root response.',
          pocDescription: 'curl -I https://example.com',
          pocScriptCode: 'curl -I https://example.com',
          assumptions: 'Root page is representative.',
          fixEffort: 'low',
          remediation: 'Add HSTS and CSP.',
          cvssVector: null,
          cvssScore: null,
          confidenceScore: 0.8,
          cweId: 'CWE-693',
          cveId: null,
          cweIds: ['CWE-693'],
          cveIds: null,
          owaspCategory: 'A05:2021-Security Misconfiguration',
          endpointId: null,
          serviceId: null,
          codeLocations: [],
          firstSeenAt: new Date('2026-03-21T06:00:00.000Z'),
          lastSeenAt: new Date('2026-03-21T06:15:00.000Z'),
          dedupeKey: 'dedupe-1',
        },
      ],
      [
        {
          ntype: 'run.digest',
          title: 'Run digest',
          data: {
            goal: 'Validate public web baseline for example.com.',
            outcome: 'completed',
          },
          evidence: [],
          lastSeenAt: new Date('2026-03-21T06:14:00.000Z'),
        },
      ],
      [
        {
          findingId: 'finding-1',
          kind: 'http_exchange',
          path: 'http-exchange://finding-1/root',
          displayPath: 'HTTP GET https://example.com/',
          label: 'Header response',
          excerpt: 'missing',
          fileMissing: false,
          data: {
            request: { method: 'GET', url: 'https://example.com/' },
            response: { statusCode: 200 },
          },
          createdAt: new Date('2026-03-21T06:13:00.000Z'),
        },
      ],
      [],
      [{ operationalContext: null }],
      [{ roeDocument: null }],
    );

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T06:15:00.000Z'),
    } as never);
    await mkdir(join(workspaceDir, '.artifacts', 'browser', 'bundles'), { recursive: true });
    await mkdir(join(workspaceDir, '.artifacts', 'browser', 'screenshots'), { recursive: true });
    await mkdir(join(workspaceDir, '.artifacts', 'browser', 'network'), { recursive: true });
    await mkdir(join(workspaceDir, '.artifacts', 'browser', 'traces'), { recursive: true });
    await mkdir(join(workspaceDir, '.artifacts', 'browser', 'state'), { recursive: true });
    await writeFile(join(workspaceDir, '.artifacts', 'browser', 'screenshots', 'login.png'), 'png');
    await writeFile(join(workspaceDir, '.artifacts', 'browser', 'network', 'browser.har.json'), '{}');
    await writeFile(join(workspaceDir, '.artifacts', 'browser', 'traces', 'challenge.zip'), 'zip');
    await writeFile(join(workspaceDir, '.artifacts', 'browser', 'state', 'auth.json'), '{}');
    await writeFile(
      join(workspaceDir, '.artifacts', 'browser', 'bundles', 'challenge-evidence-bundle.json'),
      JSON.stringify({
        url: 'https://example.com/login',
        title: 'Checking your browser',
        challenge: {
          kind: 'cloudflare_challenge',
          confidence: 'high',
          blocking_stage: 'render',
          evidence_summary: 'cloudflare_challenge: Cloudflare challenge markers in rendered page or URL',
          recommended_authorized_path: 'Use an authorized path; do not attempt generic challenge evasion.',
        },
      }),
    );
    mocks.insertReturningResults.push(
      [{ id: 'artifact-report-context' }],
      [{ id: 'artifact-compliance-context' }],
      [{ id: 'artifact-report-brief' }],
    );

    const result = await service.prepareReportContext({
      userId: 'user-1',
      sessionId: SESSION_ID,
      workspaceDir,
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID },
      input: { detail: 'brief' },
      reportedFindingIds: ['finding-1'],
      plan: [{ id: 'task-1', title: 'Validate finding', status: 'completed' }],
    });

    expect(result.reportableFindingCount).toBe(1);
    expect(result.recommendedSections).toContain('findings-narrative');
    await expect(readFile(join(workspaceDir, '.artifacts', 'report', 'brief.md'), 'utf8')).resolves.toContain('Reporter Handoff');
    await expect(readFile(join(workspaceDir, '.artifacts', 'report', 'brief.md'), 'utf8')).resolves.toContain('Browser Evidence');
    await expect(readFile(join(workspaceDir, '.artifacts', 'report', 'brief.md'), 'utf8')).resolves.toContain('![Login](.artifacts/browser/screenshots/login.png)');
    await expect(readFile(join(workspaceDir, '.artifacts', 'report', 'brief.md'), 'utf8')).resolves.toContain('cloudflare_challenge');
    await expect(readFile(join(workspaceDir, '.artifacts', 'report', 'context.json'), 'utf8')).resolves.toContain('Missing security headers');
    await expect(readFile(join(workspaceDir, '.artifacts', 'report', 'context.json'), 'utf8')).resolves.toContain('"browserEvidence"');
    await expect(readFile(join(workspaceDir, '.artifacts', 'report', 'context.json'), 'utf8')).resolves.toContain('"sensitiveStateArtifactCount": 1');
  });

  it('focuses report-only compliance context to the requested framework', () => {
    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T06:15:00.000Z'),
    } as never);

    const readiness = {
      generatedAt: '2026-03-21T06:15:00.000Z',
      organizationId: ORG_ID,
      scopeId: SCOPE_ID,
      runId: null,
      selectedFrameworks: [
        { key: 'soc2', label: 'SOC 2 Technical Readiness', sources: ['organization_profile'] },
        { key: 'hipaa', label: 'HIPAA Security Rule Readiness', sources: ['organization_profile'] },
      ],
      supportedFrameworks: ['soc2', 'hipaa'],
      frameworks: [
        { key: 'soc2', label: 'SOC 2 Technical Readiness', selected: true, supported: true, score: 50, statusCounts: {}, controls: [], gaps: [], coverageLimitations: [] },
        { key: 'hipaa', label: 'HIPAA Security Rule Readiness', selected: true, supported: true, score: 48, statusCounts: {}, controls: [], gaps: [], coverageLimitations: [] },
      ],
      latestCompletedRunId: 'run-1',
      reportRequest: {
        canStart: true,
        scopeId: SCOPE_ID,
        latestCompletedRunId: 'run-1',
        reason: null,
      },
    };

    const focused = (service as any).focusComplianceReadinessForReportContext(readiness, 'hipaa');

    expect(focused.selectedFrameworks.map((framework: { key: string }) => framework.key)).toEqual(['hipaa']);
    expect(focused.frameworks.map((framework: { key: string }) => framework.key)).toEqual(['hipaa']);
  });

  it('finalizes authored artifacts from canonical promoted findings when RunCompletion is ready', async () => {
    mocks.selectResults.push(
      [
        {
          id: 'finding-1',
          assetId: 'asset-1',
          title: 'Missing security headers',
          severity: 'low',
          state: 'confirmed',
          summary: 'Headers are missing.',
          businessImpact: 'Browsers cannot enforce modern client-side protections, increasing exposure to downgrade and injection attacks.',
          technicalAnalysis: 'The root page response omitted Strict-Transport-Security and Content-Security-Policy headers.',
          pocDescription: 'Request the root page and inspect the response headers for missing HSTS and CSP.',
          pocScriptCode: 'curl -I https://example.com',
          assumptions: 'The sampled root page is representative of the public web surface.',
          fixEffort: 'low',
          remediation: 'Add HSTS and CSP.',
          cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:L/A:N',
          cvssScore: 4.6,
          confidenceScore: 0.9,
          cweId: 'CWE-693',
          cveId: null,
          cweIds: ['CWE-693'],
          cveIds: null,
          owaspCategory: 'A05:2021-Security Misconfiguration',
          endpointId: null,
          serviceId: null,
          codeLocations: [],
          firstSeenAt: new Date('2026-03-21T06:00:00.000Z'),
          lastSeenAt: new Date('2026-03-21T06:15:00.000Z'),
          dedupeKey: 'dedupe-1',
        },
      ],
      [
        {
          ntype: 'run.digest',
          title: 'Run digest',
          data: {
            goal: 'Validate public web baseline for example.com.',
            outcome: 'completed',
            completed_tasks: ['Validate finding'],
          },
          evidence: [],
          lastSeenAt: new Date('2026-03-21T06:14:00.000Z'),
        },
        {
          ntype: 'approach.tried',
          title: 'Header review',
          data: {
            technique: 'security-header-review',
            endpoint: 'https://example.com/',
            result: 'success',
            reason: 'Response headers were retrieved and reviewed.',
          },
          evidence: [],
          lastSeenAt: new Date('2026-03-21T06:13:00.000Z'),
        },
        {
          ntype: 'report.section',
          title: 'Management summary',
          data: {
            section: 'executive-summary',
            heading: 'Management Summary',
            content: [
              'The public web surface has one validated configuration weakness with straightforward remediation.',
              '',
              '- Evidence-backed finding: missing security headers on `admin.psut.edu.jo`.',
              '- Blockers: none for the validated finding.',
              '',
              '```mermaid',
              'flowchart TD',
              '  admin["admin.psut.edu.jo"] --> finding["missing security headers"]',
              '```',
            ].join('\n'),
            evidence_refs: ['finding-1'],
          },
          evidence: [],
          lastSeenAt: new Date('2026-03-21T06:12:00.000Z'),
        },
      ],
      [
        {
          findingId: 'finding-1',
          kind: 'http_exchange',
          path: 'http-exchange://finding-1/root',
          displayPath: 'HTTP GET https://example.com/',
          label: 'Header response',
          excerpt: 'Strict-Transport-Security: missing; Content-Security-Policy: missing',
          fileMissing: false,
          data: {
            request: { method: 'GET', url: 'https://example.com/' },
            response: { statusCode: 200 },
          },
          createdAt: new Date('2026-03-21T06:13:00.000Z'),
        },
      ],
      [],
    );

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T06:15:00.000Z'),
    } as never);
    await writeAuthoredCloseoutFiles(workspaceDir, {
      summary: [
        '# Run Summary',
        '',
        'Outcome: completed.',
        'Reportable findings: one low-severity issue was validated.',
        'Recommended next run: Test authenticated workflows on https://example.com/login.',
      ].join('\n'),
      report: [
        '# Security Assessment Report',
        '',
        '## Executive Summary',
        'The public web surface has one validated configuration weakness with straightforward remediation.',
        '',
        '## Finding: Missing security headers',
        'Missing security headers were confirmed on the root response. Evidence reference: finding-1 and HTTP GET https://example.com/.',
        '',
        '```mermaid',
        'flowchart TD',
        '  site["example.com"] --> finding["Missing security headers"]',
        '```',
        '',
        '## Remediation',
        'Add HSTS and CSP, then retest the public web baseline.',
      ].join('\n'),
    });

    const result = await service.finalizeRunArtifacts({
      userId: 'user-1',
      sessionId: SESSION_ID,
      workspaceDir,
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID },
      input: { mode: 'final' },
      reportedFindingIds: ['finding-1'],
      shellJobs: {
        'job-nuclei': {
          jobId: 'job-nuclei',
          command: 'nuclei -u https://example.com -jsonl',
          status: 'failed',
          outcome: 'failed',
          exitCode: 1,
          stdoutPath: '.artifacts/nuclei.out',
          stderrPath: '.artifacts/nuclei.err',
        },
      },
      plan: [
        { id: 'task-1', title: 'Validate finding', status: 'completed' },
        {
          id: 'task-final',
          title: 'Write report',
          status: 'running',
          mission: {
            question: 'What evidence-backed report narrative should be delivered?',
            assignedSkills: ['security-reporting'],
          },
        },
      ],
    });

    expect(result.runCompletion.state).toBe('completed');
    expect(result.reportableFindingCount).toBe(1);
    await expect(readFile(join(workspaceDir, 'summary.md'), 'utf8')).resolves.toContain('Reportable findings: one low-severity issue');
    const report = await readFile(join(workspaceDir, 'report.md'), 'utf8');
    expect(report).toContain('# Security Assessment Report');
    expect(report).toContain('Missing security headers');
    expect(report).toContain('flowchart TD');
    expect(report).not.toContain('task-final: Write report');
    await expect(readFile(join(workspaceDir, '.artifacts', 'report', 'validation.json'), 'utf8')).resolves.toContain('"reportableFindingCount": 1');
  });

  it('finalizes authored artifacts when remaining plan work is blocked but settled', async () => {
    mocks.selectResults.push(
      [
        {
          id: 'finding-1',
          assetId: 'asset-1',
          title: 'Missing security headers',
          severity: 'low',
          state: 'confirmed',
          summary: 'Headers are missing.',
          businessImpact: 'Browsers cannot enforce modern client-side protections.',
          technicalAnalysis: 'The root page response omitted HSTS and CSP.',
          pocDescription: 'Request the root page and inspect the response headers.',
          pocScriptCode: 'curl -I https://example.com',
          assumptions: 'The sampled root page is representative of the public web surface.',
          fixEffort: 'low',
          remediation: 'Add HSTS and CSP.',
          cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:L/A:N',
          cvssScore: 4.6,
          confidenceScore: 0.9,
          cweId: 'CWE-693',
          cveId: null,
          cweIds: ['CWE-693'],
          cveIds: null,
          owaspCategory: 'A05:2021-Security Misconfiguration',
          endpointId: null,
          serviceId: null,
          codeLocations: [],
          firstSeenAt: new Date('2026-03-21T06:00:00.000Z'),
          lastSeenAt: new Date('2026-03-21T06:15:00.000Z'),
          dedupeKey: 'dedupe-1',
        },
      ],
      [
        {
          ntype: 'run.digest',
          title: 'Run digest',
          data: {
            goal: 'Validate the public web baseline for example.com.',
            outcome: 'completed',
          },
          evidence: [],
          lastSeenAt: new Date('2026-03-21T06:14:00.000Z'),
        },
      ],
      [
        {
          findingId: 'finding-1',
          kind: 'http_exchange',
          path: 'http-exchange://finding-1/root',
          displayPath: 'HTTP GET https://example.com/',
          label: 'Header response',
          excerpt: 'missing',
          fileMissing: false,
          data: {
            request: { method: 'GET', url: 'https://example.com/' },
            response: { statusCode: 200 },
          },
          createdAt: new Date('2026-03-21T06:13:00.000Z'),
        },
      ],
      [],
    );

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T06:15:00.000Z'),
    } as never);
    await writeAuthoredCloseoutFiles(workspaceDir);

    const result = await service.finalizeRunArtifacts({
      userId: 'user-1',
      sessionId: SESSION_ID,
      workspaceDir,
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID },
      input: { mode: 'final' },
      reportedFindingIds: ['finding-1'],
      plan: [
        { id: 'task-1', title: 'Validate authenticated flow', status: 'blocked', blockedReason: 'missing credentials' },
        {
          id: 'task-final',
          title: 'Write report',
          status: 'running',
          mission: {
            question: 'What evidence-backed report narrative should be delivered?',
            assignedSkills: ['security-reporting'],
          },
        },
      ],
    });

    expect(result.mode).toBe('final');
    expect(result.runCompletion.state).toBe('completed');
    expect(result.reportableFindingCount).toBe(1);
  });

  it('rejects finalization when authored markdown files are missing', async () => {
    mocks.selectResults.push(
      [
        {
          id: 'finding-1',
          assetId: 'asset-1',
          title: 'Missing security headers',
          severity: 'low',
          state: 'confirmed',
          summary: 'Headers are missing.',
          businessImpact: 'Limited browser-side defense in depth.',
          technicalAnalysis: 'HSTS and CSP are absent on the root response.',
          pocDescription: 'curl -I https://example.com',
          pocScriptCode: 'curl -I https://example.com',
          assumptions: 'Root page is representative.',
          fixEffort: 'low',
          remediation: 'Add HSTS and CSP.',
          cvssVector: null,
          cvssScore: null,
          confidenceScore: 0.5,
          cweId: 'CWE-693',
          cveId: null,
          cweIds: ['CWE-693'],
          cveIds: null,
          owaspCategory: 'A05:2021-Security Misconfiguration',
          endpointId: null,
          serviceId: null,
          codeLocations: [],
          firstSeenAt: new Date('2026-03-21T06:00:00.000Z'),
          lastSeenAt: new Date('2026-03-21T06:15:00.000Z'),
          dedupeKey: 'dedupe-1',
        },
      ],
      [],
      [
        {
          findingId: 'finding-1',
          kind: 'http_exchange',
          path: 'http-exchange://finding-1/root',
          displayPath: 'HTTP GET https://example.com/',
          label: 'Header response',
          excerpt: 'missing',
          fileMissing: false,
          data: {
            request: { method: 'GET', url: 'https://example.com/' },
            response: { statusCode: 200 },
          },
          createdAt: new Date('2026-03-21T06:13:00.000Z'),
        },
      ],
      [],
    );

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T06:15:00.000Z'),
    } as never);

    await expect(
      service.finalizeRunArtifacts({
        userId: 'user-1',
        sessionId: SESSION_ID,
        workspaceDir,
        context: { organizationId: ORG_ID, scopeId: SCOPE_ID },
        input: { mode: 'final' },
        reportedFindingIds: ['finding-1'],
        plan: [{ id: 'task-1', title: 'Validate finding', status: 'completed' }],
      }),
    ).rejects.toThrow('authored summary.md is missing');
  });

  it('labels interim artifacts with blockers and open coverage debts', async () => {
    mocks.selectResults.push(
      [],
      [
        {
          ntype: 'approach.blocker',
          title: 'Credentials required',
          data: { reason: 'Valid user credentials are required to continue auth testing.' },
          evidence: [],
          lastSeenAt: new Date('2026-03-21T06:15:00.000Z'),
        },
        {
          ntype: 'run.digest',
          title: 'Blocked run digest',
          data: {
            goal: 'Validate auth bypass on example.com.',
            outcome: 'blocked',
            blocker_summary: 'Valid user credentials are required to continue auth testing.',
            blocked_tasks: ['task-1'],
            next_prerequisites: ['Valid user credentials'],
          },
          evidence: [],
          lastSeenAt: new Date('2026-03-21T06:16:00.000Z'),
        },
      ],
    );

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T06:15:00.000Z'),
    } as never);
    await writeAuthoredCloseoutFiles(workspaceDir, {
      summary: [
        '# Run Summary',
        '',
        'Outcome: blocked.',
        'Reportable findings: none.',
        'Next prerequisites: Valid user credentials.',
      ].join('\n'),
      report: [
        '# Interim Security Assessment Report',
        '',
        '## Executive Summary',
        'The run was blocked before auth bypass validation because valid user credentials were not available.',
        '',
        '## Blocker',
        'Credentials required: valid user credentials are required to continue auth testing.',
        '',
        '## Next Steps',
        'No agent-actionable next assessment path remains until valid user credentials are available.',
      ].join('\n'),
    });

    const result = await service.finalizeRunArtifacts({
      userId: 'user-1',
      sessionId: '11111111-1111-4111-8111-111111111111',
      workspaceDir,
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID },
      input: { mode: 'interim', reason: 'Credentials are required to continue.' },
      reportedFindingIds: [],
      plan: [{ id: 'task-1', title: 'Validate auth bypass', status: 'blocked', blockedReason: 'missing credentials' }],
    });

    expect(result.mode).toBe('interim');
    expect(result.runCompletion).toEqual(
      expect.objectContaining({ state: 'completed', finalized: true }),
    );
    const summary = await readFile(join(workspaceDir, 'summary.md'), 'utf8');
    expect(summary).toContain('Outcome: blocked');
    const report = await readFile(join(workspaceDir, 'report.md'), 'utf8');
    expect(report).toContain('Credentials required');
    const validation = await readFile(join(workspaceDir, '.artifacts', 'report', 'validation.json'), 'utf8');
    expect(validation).toContain('"mode": "interim"');
    expect(validation).toContain('"state": "completed"');
  });

  it('reconciles automated closeout to final when run completion is ready', async () => {
    const findings = [
      {
        id: 'finding-1',
        assetId: 'asset-1',
        title: 'Missing security headers',
        severity: 'low',
        state: 'confirmed',
        summary: 'Headers are missing.',
        businessImpact: 'Browsers cannot enforce modern client-side protections.',
        technicalAnalysis: 'The root page response omitted HSTS and CSP.',
        pocDescription: 'Request the root page and inspect the headers.',
        pocScriptCode: 'curl -I https://example.com',
        assumptions: 'The root page is representative.',
        fixEffort: 'low',
        remediation: 'Add HSTS and CSP.',
        cvssVector: null,
        cvssScore: null,
        confidenceScore: 0.8,
        cweId: 'CWE-693',
        cveId: null,
        cweIds: ['CWE-693'],
        cveIds: null,
        owaspCategory: 'A05:2021-Security Misconfiguration',
        endpointId: null,
        serviceId: null,
        codeLocations: [],
        firstSeenAt: new Date('2026-03-21T06:00:00.000Z'),
        lastSeenAt: new Date('2026-03-21T06:15:00.000Z'),
        dedupeKey: 'dedupe-1',
      },
    ];
    const notes = [
      {
        ntype: 'run.digest',
        title: 'Run digest',
        data: {
          goal: 'Validate public web baseline for example.com.',
          outcome: 'completed',
        },
        evidence: [],
        lastSeenAt: new Date('2026-03-21T06:14:00.000Z'),
      },
    ];
    const evidence = [
      {
        findingId: 'finding-1',
        kind: 'http_exchange',
        path: 'http-exchange://finding-1/root',
        displayPath: 'HTTP GET https://example.com/',
        label: 'Header response',
        excerpt: 'Strict-Transport-Security: missing',
        fileMissing: false,
        data: {
          request: { method: 'GET', url: 'https://example.com/' },
          response: { statusCode: 200 },
        },
        createdAt: new Date('2026-03-21T06:13:00.000Z'),
      },
    ];

    const completedPhaseRows = [
      { id: 'phase-validation', phaseKey: 'validation', status: 'completed', sessionId: SESSION_ID, lastError: null },
      { id: 'phase-reporting', phaseKey: 'reporting', status: 'completed', sessionId: SESSION_ID, lastError: null },
    ];
    mocks.selectResults.push(
      completedPhaseRows,
      [{ findingId: 'finding-1' }],
      findings,
      notes,
      evidence,
      [],
      [],
      completedPhaseRows,
      [{ findingId: 'finding-1' }],
      findings,
      notes,
      evidence,
      [],
      [],
      [],
      [],
    );
    await writeAuthoredCloseoutFiles(workspaceDir, {
      summary: [
        '# Run Summary',
        '',
        'Outcome: completed.',
        'Reportable findings: one low-severity issue was validated.',
        'Recommended next run: Test authenticated workflows on https://example.com/login.',
      ].join('\n'),
      report: [
        '# Security Assessment Report',
        '',
        '## Executive Summary',
        'The public web surface has one validated configuration weakness with straightforward remediation.',
        '',
        '## Finding: Missing security headers',
        'Missing security headers were confirmed on the root response. Evidence reference: finding-1 and HTTP GET https://example.com/.',
        '',
        '## Remediation',
        'Add HSTS and CSP, then retest the public web baseline.',
        '',
        '## Next Steps',
        'Test authenticated workflows on https://example.com/login once the baseline hardening changes have been applied and verified.',
      ].join('\n'),
    });

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T06:15:00.000Z'),
    } as never);

    const result = await service.reconcileAutomatedRunCloseout({
      userId: 'user-1',
      sessionId: SESSION_ID,
      workspaceDir,
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID, runId: RUN_ID },
      reportedFindingIds: ['finding-1'],
      plan: [{ id: 'task-1', title: 'Validate finding', status: 'completed' }],
    });

    expect(result.outcome).toBe('finalized');
    expect(result.mode).toBe('final');
    expect(result.runCompletion.state).toBe('completed');
    expect(mocks.updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: expect.objectContaining({ __table: 'runs' }),
          values: expect.objectContaining({ status: 'completed' }),
        }),
        expect.objectContaining({
          table: expect.objectContaining({ __table: 'run_phases' }),
          values: expect.objectContaining({ status: 'completed' }),
        }),
      ]),
    );
  });

  it('reconciles automated closeout to completed interim when authored interim artifacts are valid', async () => {
    mocks.selectResults.push(
      [{ id: 'phase-reporting', phaseKey: 'reporting', status: 'active', sessionId: SESSION_ID, lastError: null }],
      [],
      [
        {
          ntype: 'run.digest',
          title: 'Blocked run digest',
          data: {
            goal: 'Validate auth bypass on example.com.',
            outcome: 'blocked',
            blocker_summary: 'Valid credentials are required to continue auth bypass testing.',
            blocked_tasks: ['task-1'],
            next_prerequisites: ['Valid credentials'],
          },
          evidence: [],
          lastSeenAt: new Date('2026-03-21T06:16:00.000Z'),
        },
      ],
      [],
    );
    await writeAuthoredCloseoutFiles(workspaceDir, {
      summary: [
        '# Run Summary',
        '',
        'Outcome: blocked.',
        'Reportable findings: none.',
        'Next prerequisites: Valid credentials.',
      ].join('\n'),
      report: [
        '# Interim Security Assessment Report',
        '',
        '## Executive Summary',
        'The run was blocked before auth bypass validation.',
        '',
        '## Scope Context',
        'The assessment stayed within the public application surface and did not proceed into authenticated workflows because operator-controlled credentials were unavailable during the run.',
        '',
        '## Next Steps',
        'No agent-actionable next assessment path remains until valid credentials are available.',
        '',
        '## Evidence',
        'The blocker was recorded in run.digest and no validated findings were produced in this run.',
        '',
        '## Notes',
        'Additional evidence is required before this run can be finalized.',
        '',
        '## Reporting Status',
        'This interim report is intentionally incomplete: it captures the blocker, the current coverage state, and the operator action required to resume testing cleanly in a follow-up session.',
      ].join('\n'),
    });

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T06:15:00.000Z'),
    } as never);

    const result = await service.reconcileAutomatedRunCloseout({
      userId: 'user-1',
      sessionId: SESSION_ID,
      workspaceDir,
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID, runId: RUN_ID },
      plan: [
        { id: 'task-1', title: 'Validate auth bypass', status: 'blocked', blockedReason: 'missing credentials' },
        { id: 'task-final', title: 'Write report', status: 'pending' },
      ],
    });

    expect(result.outcome).toBe('finalized');
    expect(result.mode).toBe('interim');
    expect(result.runCompletion.state).toBe('completed');
    expect(result.runCompletion.finalized).toBe(true);
    expect(result.runCompletion.reasons).toContain('automated closeout completed interim report artifacts');
    expect(mocks.updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: expect.objectContaining({ __table: 'runs' }),
          values: expect.objectContaining({ status: 'completed' }),
        }),
      ]),
    );
  });

  it('completes interim closeout with warnings instead of pausing when authored files exist but validation fails', async () => {
    mocks.selectResults.push([], [], [], []);
    await writeAuthoredCloseoutFiles(workspaceDir, {
      summary: [
        '# Run Summary',
        '',
        'Outcome: blocked.',
        'Reportable findings: none.',
        'The run reached a bounded interim closeout and authored the expected operator summary.',
      ].join('\n'),
      report: [
        '# Interim Security Assessment Report',
        '',
        '## Executive Summary',
        'The run completed an interim report after validation could not continue. The authored report is preserved so the operator has the current coverage state and next action even when backend validation records a warning.',
        '',
        '## Scope Context',
        'The assessment stayed within the approved public application surface. No validated findings were produced before the interim closeout point.',
        '',
        '## Next Steps',
        'Resume with the missing prerequisite or rerun validation from the saved evidence bundle.',
        '',
        '## Reporting Status',
        'This interim report intentionally records the blocker and should complete the run with validation warnings rather than leave the run in a recoverable pause.',
      ].join('\n'),
    });

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T06:15:00.000Z'),
    } as never);

    const result = await service.reconcileAutomatedRunCloseout({
      userId: 'user-1',
      sessionId: SESSION_ID,
      workspaceDir,
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID, runId: RUN_ID },
      plan: [
        { id: 'task-1', title: 'Validate auth bypass', status: 'running' },
      ],
    });

    expect(result.outcome).toBe('finalized');
    expect(result.mode).toBe('interim');
    expect(result.runCompletion.state).toBe('completed');
    expect(result.reason).toContain('run.digest is required');
    const validation = JSON.parse(
      await readFile(join(workspaceDir, '.artifacts', 'report', 'validation.json'), 'utf8'),
    );
    expect(validation.warnings).toEqual([expect.stringContaining('run.digest is required')]);
    expect(mocks.updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: expect.objectContaining({ __table: 'runs' }),
          values: expect.objectContaining({ status: 'completed' }),
        }),
      ]),
    );
    expect(
      mocks.updateCalls.some(
        (call) =>
          (call.table as { __table?: string }).__table === 'runs' &&
          (call.values as { status?: string }).status === 'system_paused',
      ),
    ).toBe(false);
  });

  it('returns a reasoned closeout pause without writing run lifecycle state', async () => {
    mocks.selectResults.push([], [], [], []);
    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T06:15:00.000Z'),
    } as never);

    const result = await service.reconcileAutomatedRunCloseout({
      userId: 'user-1',
      sessionId: SESSION_ID,
      workspaceDir,
      context: { organizationId: ORG_ID, scopeId: SCOPE_ID, runId: RUN_ID },
      plan: [{ id: 'task-1', title: 'Write report', status: 'running' }],
    });

    expect(result.outcome).toBe('paused');
    expect(result.reason).toContain('authored summary.md is missing');
    expect(mocks.updateCalls.some(
      (call) => (call.table as { __table?: string }).__table === 'runs',
    )).toBe(false);
    expect(mocks.insertCalls.some(
      (call) =>
        (call.table as { __table?: string }).__table === 'run_events' &&
        (call.values as { type?: string }).type === 'system_paused',
    )).toBe(false);
  });

  it('returns inventory with merged services and endpoints when those expansions are requested', async () => {
    mocks.loadAssetFocusEnrichments.mockResolvedValueOnce(new Map([
      [
        'asset-1',
        {
          focus: {
            score: 92,
            label: 'critical',
            reasons: ['Open critical finding on this asset'],
          },
          needsBroadScan: true,
          serviceCount: 1,
          openFindings: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
          exactVerifiedTargetMatch: false,
        },
      ],
      [
        'asset-2',
        {
          focus: {
            score: 0,
            label: 'low',
            reasons: [],
          },
          needsBroadScan: true,
          serviceCount: 0,
          openFindings: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
          exactVerifiedTargetMatch: false,
        },
      ],
    ]));
    mocks.selectResults.push(
      [
        {
          id: 'asset-1',
          kind: 'domain',
          value: 'api.example.com',
          isLead: false,
          tags: ['prod'],
          lastScannedAt: new Date('2026-03-19T06:00:00.000Z'),
          lastSeenAt: new Date('2026-03-21T06:00:00.000Z'),
        },
        {
          id: 'asset-2',
          kind: 'ip',
          value: '203.0.113.10',
          isLead: false,
          tags: null,
          lastScannedAt: null,
          lastSeenAt: '2026-03-20T06:00:00.000Z',
        },
      ],
      [
        {
          id: 'svc-1',
          assetId: 'asset-1',
          protocol: 'https',
          port: 443,
          serviceName: 'https',
          product: 'nginx',
          version: '1.25.3',
          lastSeenAt: new Date('2026-03-21T06:10:00.000Z'),
        },
      ],
      [
        {
          id: 'note-1',
          assetId: 'asset-1',
          title: null,
          data: {
            url: 'https://api.example.com/login',
            method: 'post',
            statusCode: '302',
            title: 'Login',
          },
          lastSeenAt: new Date('2026-03-21T06:20:00.000Z'),
        },
        {
          id: 'note-2',
          assetId: 'asset-2',
          title: 'Default title',
          data: {
            url: 'http://203.0.113.10/',
            method: '',
            statusCode: 200,
          },
          lastSeenAt: '2026-03-20T06:20:00.000Z',
        },
      ],
      [],
      [],
    );

    const service = new SecurityOpsToolService({ db: mocks.db } as never);
    const result = await service.queryInventory({
      userId: 'user-1',
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
      },
      input: {
        includeServices: true,
        includeEndpoints: true,
        staleThresholdDays: 7,
      },
    });

    expect(result).toEqual({
      assets: [
        {
          id: 'asset-1',
          kind: 'domain',
          value: 'api.example.com',
          isLead: false,
          tags: ['prod'],
          lastSeenAt: '2026-03-21T06:00:00.000Z',
          lastScannedAt: '2026-03-19T06:00:00.000Z',
          needsBroadScan: true,
          needsVersionAcquisition: false,
          focus: {
            score: 92,
            label: 'critical',
            reasons: ['Open critical finding on this asset'],
          },
          services: [
            {
              id: 'svc-1',
              assetId: 'asset-1',
              protocol: 'https',
              port: 443,
              serviceName: 'https',
              product: 'nginx',
              version: '1.25.3',
              lastSeenAt: '2026-03-21T06:10:00.000Z',
            },
          ],
          endpoints: [
            {
              id: 'note-1',
              assetId: 'asset-1',
              url: 'https://api.example.com/login',
              method: 'post',
              statusCode: 302,
              title: 'Login',
              lastSeenAt: '2026-03-21T06:20:00.000Z',
            },
          ],
        },
        {
          id: 'asset-2',
          kind: 'ip',
          value: '203.0.113.10',
          isLead: false,
          tags: [],
          lastSeenAt: '2026-03-20T06:00:00.000Z',
          lastScannedAt: null,
          needsBroadScan: true,
          needsVersionAcquisition: false,
          focus: { score: 0, label: 'low', reasons: [] },
          services: [],
          endpoints: [
            {
              id: 'note-2',
              assetId: 'asset-2',
              url: 'http://203.0.113.10/',
              method: 'GET',
              statusCode: 200,
              title: 'Default title',
              lastSeenAt: '2026-03-20T06:20:00.000Z',
            },
          ],
        },
      ],
      totalCount: 2,
      leadCount: 0,
    });

    expect(mocks.ltMock).toHaveBeenCalledWith('assets.last_seen_at', expect.any(Date));
    expect(mocks.inArrayMock).toHaveBeenCalledWith('inventory_services.asset_id', ['asset-1', 'asset-2']);
    expect(mocks.inArrayMock).toHaveBeenCalledWith('inventory_notes.asset_id', ['asset-1', 'asset-2']);
  });

  it('marks assets as covered when broad scan coverage is fresh and matches the current inventory fingerprint', async () => {
    const now = new Date('2026-03-21T10:00:00.000Z');
    const coverageFingerprint = buildTestInventoryFingerprint({
      assetValue: 'api.example.com',
      services: [
        {
          protocol: 'https',
          port: 443,
          serviceName: 'https',
          product: 'nginx',
          version: '1.25.3',
        },
      ],
      techs: [
        {
          product: 'next.js',
          version: '15.0.0',
          category: 'framework',
        },
      ],
    });

    mocks.selectResults.push(
      [
        {
          id: 'asset-1',
          kind: 'domain',
          value: 'api.example.com',
          isLead: false,
          tags: ['prod'],
          lastScannedAt: new Date('2026-03-20T10:00:00.000Z'),
          lastSeenAt: new Date('2026-03-21T09:00:00.000Z'),
        },
      ],
      [
        {
          id: 'svc-1',
          assetId: 'asset-1',
          protocol: 'https',
          port: 443,
          serviceName: 'https',
          product: 'nginx',
          version: '1.25.3',
          lastSeenAt: new Date('2026-03-21T09:05:00.000Z'),
        },
      ],
      [
        {
          id: 'note-endpoint-1',
          assetId: 'asset-1',
          title: 'Home',
          data: {
            url: 'https://api.example.com/',
            method: 'GET',
            statusCode: 200,
          },
          lastSeenAt: new Date('2026-03-21T09:10:00.000Z'),
        },
      ],
      [
        {
          id: 'note-tech-1',
          assetId: 'asset-1',
          data: {
            product: 'next.js',
            version: '15.0.0',
            category: 'framework',
            confidence: 0.9,
          },
          lastSeenAt: new Date('2026-03-21T09:15:00.000Z'),
        },
      ],
      [
        {
          id: 'note-coverage-1',
          assetId: 'asset-1',
          data: {
            family: 'broad-surface',
            status: 'completed',
            profileVersion: 'broad-surface-scan/v1',
            inventoryFingerprint: coverageFingerprint,
            toolset: ['httpx', 'katana'],
          },
          lastSeenAt: new Date('2026-03-21T09:20:00.000Z'),
        },
      ],
    );

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => now,
    } as never);

    const result = await service.queryInventory({
      userId: 'user-1',
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
      },
      input: {
        includeServices: true,
        includeEndpoints: true,
      },
    });

    expect(result).toEqual({
      assets: [
        {
          id: 'asset-1',
          kind: 'domain',
          value: 'api.example.com',
          isLead: false,
          tags: ['prod'],
          lastSeenAt: '2026-03-21T09:00:00.000Z',
          lastScannedAt: '2026-03-20T10:00:00.000Z',
          needsBroadScan: false,
          needsVersionAcquisition: false,
          focus: { score: 0, label: 'low', reasons: [] },
          services: [
            {
              id: 'svc-1',
              assetId: 'asset-1',
              protocol: 'https',
              port: 443,
              serviceName: 'https',
              product: 'nginx',
              version: '1.25.3',
              lastSeenAt: '2026-03-21T09:05:00.000Z',
            },
          ],
          endpoints: [
            {
              id: 'note-endpoint-1',
              assetId: 'asset-1',
              url: 'https://api.example.com/',
              method: 'GET',
              statusCode: 200,
              title: 'Home',
              lastSeenAt: '2026-03-21T09:10:00.000Z',
            },
          ],
        },
      ],
      totalCount: 1,
      leadCount: 0,
    });
  });

  it('marks matching broad scan coverage as stale after twenty-one days', async () => {
    const now = new Date('2026-04-15T10:00:00.000Z');
    const coverageFingerprint = buildTestInventoryFingerprint({
      assetValue: 'api.example.com',
      services: [
        {
          protocol: 'https',
          port: 443,
          serviceName: 'https',
          product: 'nginx',
          version: '1.25.3',
        },
      ],
      techs: [],
    });

    mocks.selectResults.push(
      [
        {
          id: 'asset-1',
          kind: 'domain',
          value: 'api.example.com',
          isLead: false,
          tags: ['prod'],
          lastScannedAt: new Date('2026-03-21T10:00:00.000Z'),
          lastSeenAt: new Date('2026-03-21T09:00:00.000Z'),
        },
      ],
      [
        {
          id: 'svc-1',
          assetId: 'asset-1',
          protocol: 'https',
          port: 443,
          serviceName: 'https',
          product: 'nginx',
          version: '1.25.3',
          lastSeenAt: new Date('2026-03-21T09:05:00.000Z'),
        },
      ],
      [
        {
          id: 'note-endpoint-1',
          assetId: 'asset-1',
          title: 'Home',
          data: {
            url: 'https://api.example.com/',
            method: 'GET',
            statusCode: 200,
          },
          lastSeenAt: new Date('2026-03-21T09:10:00.000Z'),
        },
      ],
      [],
      [
        {
          id: 'note-coverage-1',
          assetId: 'asset-1',
          data: {
            family: 'broad-surface',
            status: 'completed',
            profileVersion: 'broad-surface-scan/v1',
            inventoryFingerprint: coverageFingerprint,
            toolset: ['httpx', 'katana'],
          },
          lastSeenAt: new Date('2026-03-21T09:20:00.000Z'),
        },
      ],
    );

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => now,
    } as never);

    const result = await service.queryInventory({
      userId: 'user-1',
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
      },
      input: {},
    });

    expect(result).toEqual({
      assets: [
        {
          id: 'asset-1',
          kind: 'domain',
          value: 'api.example.com',
          isLead: false,
          tags: ['prod'],
          lastSeenAt: '2026-03-21T09:00:00.000Z',
          lastScannedAt: '2026-03-21T10:00:00.000Z',
          needsBroadScan: true,
          needsVersionAcquisition: false,
          focus: { score: 0, label: 'low', reasons: [] },
        },
      ],
      totalCount: 1,
      leadCount: 0,
    });
  });

  it('treats fresh completed broad scan coverage as sufficient even when lastScannedAt is missing', async () => {
    const now = new Date('2026-03-21T10:00:00.000Z');
    const coverageFingerprint = buildTestInventoryFingerprint({
      assetValue: 'api.example.com',
      services: [
        {
          protocol: 'https',
          port: 443,
          serviceName: 'https',
          product: 'nginx',
          version: '1.25.3',
        },
      ],
      techs: [],
    });

    mocks.selectResults.push(
      [
        {
          id: 'asset-1',
          kind: 'domain',
          value: 'api.example.com',
          isLead: false,
          tags: ['prod'],
          lastScannedAt: null,
          lastSeenAt: new Date('2026-03-21T09:00:00.000Z'),
        },
      ],
      [
        {
          id: 'svc-1',
          assetId: 'asset-1',
          protocol: 'https',
          port: 443,
          serviceName: 'https',
          product: 'nginx',
          version: '1.25.3',
          lastSeenAt: new Date('2026-03-21T09:05:00.000Z'),
        },
      ],
      [],
      [
        {
          id: 'note-coverage-1',
          assetId: 'asset-1',
          data: {
            family: 'broad-surface',
            status: 'completed',
            profileVersion: 'broad-surface-scan/v1',
            inventoryFingerprint: coverageFingerprint,
            toolset: ['httpx', 'katana'],
          },
          lastSeenAt: new Date('2026-03-21T09:20:00.000Z'),
        },
      ],
    );

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => now,
    } as never);

    const result = await service.queryInventory({
      userId: 'user-1',
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
      },
      input: {},
    });

    expect(result).toEqual({
      assets: [
        {
          id: 'asset-1',
          kind: 'domain',
          value: 'api.example.com',
          isLead: false,
          tags: ['prod'],
          lastSeenAt: '2026-03-21T09:00:00.000Z',
          lastScannedAt: '2026-03-21T09:20:00.000Z',
          needsBroadScan: false,
          needsVersionAcquisition: false,
          focus: { score: 0, label: 'low', reasons: [] },
        },
      ],
      totalCount: 1,
      leadCount: 0,
    });
  });

  it('auto-fills scan coverage fingerprints and updates asset lastScannedAt on completed coverage notes', async () => {
    mocks.selectResults.push(
      [
        {
          id: 'asset-1',
          tags: ['prod'],
          evidence: [],
        },
      ],
      [
        {
          id: 'svc-1',
          assetId: 'asset-1',
          protocol: 'https',
          port: 443,
          serviceName: 'https',
          product: 'nginx',
          version: '1.25.3',
          lastSeenAt: new Date('2026-03-21T11:05:00.000Z'),
        },
      ],
      [
        {
          id: 'note-tech-1',
          assetId: 'asset-1',
          data: {
            product: 'next.js',
            version: '15.0.0',
            category: 'framework',
            confidence: 0.9,
          },
          lastSeenAt: new Date('2026-03-21T11:12:00.000Z'),
        },
      ],
      [],
    );
    mocks.insertReturningResults.push([{ id: 'note-coverage-1' }]);

    const now = new Date('2026-03-21T11:15:00.000Z');
    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => now,
    } as never);

    const result = await service.reportNote({
      userId: 'user-1',
      workspaceDir,
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
      },
      input: {
        assetRef: { kind: 'domain', value: 'API.EXAMPLE.COM' },
        ntype: 'scan.coverage',
        data: {
          family: 'broad-surface',
          status: 'completed',
          profileVersion: 'broad-surface-scan/v1',
          toolset: ['httpx', 'katana', 'ffuf'],
          stats: {
            endpointsDiscovered: 4,
            findingsCreated: 1,
            techsDetected: 2,
          },
        },
      },
    });

    expect(result).toEqual({
      noteId: 'note-coverage-1',
      created: true,
      dedupeKey: expect.any(String),
    });

    const noteInsert = mocks.insertCalls.find(
      (call) => (call.table as { __table: string }).__table === 'inventory_notes',
    );
    expect(noteInsert).toMatchObject({
      values: expect.objectContaining({
        assetId: 'asset-1',
        ntype: 'scan.coverage',
        data: expect.objectContaining({
          family: 'broad-surface',
          status: 'completed',
          profileVersion: 'broad-surface-scan/v1',
          toolset: ['httpx', 'katana', 'ffuf'],
          inventoryFingerprint: expect.any(String),
        }),
      }),
    });

    const assetUpdates = mocks.updateCalls.filter(
      (call) => (call.table as { __table: string }).__table === 'assets',
    );
    expect(assetUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          values: expect.objectContaining({
            lastScannedAt: now,
            updatedAt: now,
          }),
        }),
      ]),
    );
  });

  it('accepts per-tool scan coverage families without forcing weaker approach notes', async () => {
    mocks.selectResults.push([{ id: 'asset-1', tags: [], evidence: [] }], []);
    mocks.insertReturningResults.push([{ id: 'note-coverage-katana-1' }]);

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T11:25:00.000Z'),
    } as never);

    const result = await service.reportNote({
      userId: 'user-1',
      workspaceDir,
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
      },
      input: {
        assetRef: { kind: 'domain', value: 'api.example.com' },
        ntype: 'scan.coverage',
        data: {
          family: 'katana',
          status: 'completed',
          profileVersion: 'katana/v1',
          targetUrl: 'https://api.example.com',
          inventoryFingerprint: 'known-fingerprint',
          stats: {
            rowsParsed: 12,
            rowsKept: 8,
            endpointsDiscovered: 8,
          },
        },
      },
    });

    expect(result).toEqual({
      noteId: 'note-coverage-katana-1',
      created: true,
      dedupeKey: expect.any(String),
    });
    const noteInsert = mocks.insertCalls.find(
      (call) => (call.table as { __table: string }).__table === 'inventory_notes',
    );
    expect(noteInsert).toMatchObject({
      values: expect.objectContaining({
        ntype: 'scan.coverage',
        data: expect.objectContaining({
          family: 'katana',
          profileVersion: 'katana/v1',
          stats: expect.objectContaining({
            rowsParsed: 12,
            rowsKept: 8,
          }),
        }),
      }),
    });
  });

  it('normalizes noncanonical blocked scan coverage status and missing profile version', async () => {
    mocks.selectResults.push([{ id: 'asset-1', tags: [], evidence: [] }], []);
    mocks.insertReturningResults.push([{ id: 'note-coverage-ffuf-1' }]);

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T11:30:00.000Z'),
    } as never);

    const result = await service.reportNote({
      userId: 'user-1',
      workspaceDir,
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
      },
      input: {
        assetRef: { kind: 'domain', value: 'api.example.com' },
        ntype: 'scan.coverage',
        data: {
          family: 'ffuf',
          status: 'partially_blocked',
          targetUrl: 'https://api.example.com',
          inventoryFingerprint: 'known-fingerprint',
        },
      },
    });

    expect(result).toEqual({
      noteId: 'note-coverage-ffuf-1',
      created: true,
      dedupeKey: expect.any(String),
    });
    const noteInsert = mocks.insertCalls.find(
      (call) => (call.table as { __table: string }).__table === 'inventory_notes',
    );
    expect(noteInsert).toMatchObject({
      values: expect.objectContaining({
        ntype: 'scan.coverage',
        data: expect.objectContaining({
          family: 'ffuf',
          status: 'blocked',
          profileVersion: 'ffuf/v1',
          reason: expect.stringContaining('partially_blocked'),
        }),
      }),
    });
  });

  it('suppresses noisy ffuf redirect clusters and duplicate endpoints during ingest', async () => {
    await mkdir(join(workspaceDir, '.artifacts'), { recursive: true });
    const noisyRows = Array.from({ length: 20 }, (_, index) => ({
      url: `https://api.example.com/noise-${index}`,
      status: 302,
      length: 12345,
      words: 200,
      lines: 20,
      redirectlocation: 'https://api.example.com/login',
    }));
    await writeFile(
      join(workspaceDir, '.artifacts', 'ffuf-noise.json'),
      JSON.stringify({
        results: [
          ...noisyRows,
          { url: 'https://api.example.com/admin', status: 200, length: 456, words: 80, lines: 12 },
          { url: 'https://api.example.com/admin', status: 200, length: 456, words: 80, lines: 12 },
        ],
      }),
    );
    mocks.selectResults.push([{ id: 'asset-1', tags: [], evidence: [] }], []);
    mocks.insertReturningResults.push([{ id: 'note-endpoint-1' }]);

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T11:35:00.000Z'),
    } as never);

    const result = await service.ingestScanArtifact({
      userId: 'user-1',
      workspaceDir,
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
      },
      input: {
        parser: 'ffuf',
        artifactPath: '.artifacts/ffuf-noise.json',
      },
    });

    expect(result.endpointNotesCreated).toBe(1);
    expect(result.suppressed).toBe(21);
    expect(result.duplicates).toBe(1);
    expect(result.noise).toMatchObject({
      repeated_response_cluster: 20,
      duplicate_normalized_endpoint: 1,
    });

    const noteInsert = mocks.insertCalls.find(
      (call) => (call.table as { __table: string }).__table === 'inventory_notes',
    );
    expect(noteInsert).toMatchObject({
      values: expect.objectContaining({
        ntype: 'http.endpoint',
        data: expect.objectContaining({
          url: 'https://api.example.com/admin',
          source: 'ffuf',
          sourceArtifact: '.artifacts/ffuf-noise.json',
        }),
      }),
    });
  });

  it('auto-discovers scanner artifacts under .artifacts/scans when artifactPath is omitted', async () => {
    await mkdir(join(workspaceDir, '.artifacts', 'scans', 'ffuf'), { recursive: true });
    await writeFile(
      join(workspaceDir, '.artifacts', 'scans', 'ffuf', 'worker-1.json'),
      JSON.stringify({
        results: [
          { url: 'https://api.example.com/admin', status: 200, length: 456, words: 80, lines: 12 },
        ],
      }),
    );
    mocks.selectResults.push([{ id: 'asset-1', tags: [], evidence: [] }], []);
    mocks.insertReturningResults.push([{ id: 'note-endpoint-1' }]);

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T11:40:00.000Z'),
    } as never);

    const result = await service.ingestScanArtifact({
      userId: 'user-1',
      workspaceDir,
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
      },
      input: {
        parser: 'ffuf',
      },
    });

    expect(result.artifactPath).toBe('.artifacts/scans/ffuf/worker-1.json');
    expect(result.endpointNotesCreated).toBe(1);
    const noteInsert = mocks.insertCalls.find(
      (call) => (call.table as { __table: string }).__table === 'inventory_notes',
    );
    expect(noteInsert).toMatchObject({
      values: expect.objectContaining({
        data: expect.objectContaining({
          sourceArtifact: '.artifacts/scans/ffuf/worker-1.json',
        }),
      }),
    });
  });

  it('returns an empty finding list when the requested asset reference is not found', async () => {
    mocks.selectResults.push([]);

    const service = new SecurityOpsToolService({ db: mocks.db } as never);
    const result = await service.queryFindings({
      userId: 'user-1',
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
      },
      input: {
        assetRef: {
          kind: 'domain',
          value: 'missing.example.com',
        },
      },
    });

    expect(result).toEqual({
      findings: [],
      totalCount: 0,
    });
  });

  it('filters findings by a resolved asset reference and maps the result rows', async () => {
    mocks.selectResults.push(
      [{ id: 'asset-1' }],
      [
        {
          id: 'finding-1',
          title: 'Open redirect',
          severity: 'medium',
          state: 'confirmed',
          validationProof: null,
          assetValue: '203.0.113.10',
          summary: 'Redirects to arbitrary domains.',
          businessImpact: 'Users can be redirected to attacker-controlled phishing domains.',
          technicalAnalysis: 'The redirect parameter is trusted without origin validation.',
          pocDescription: 'Request /redirect?next=https://evil.example and observe the Location header.',
          assumptions: 'Attacker can convince a user to follow a crafted link.',
          remediation: 'Allow-list redirect targets and reject external origins.',
          fixEffort: null,
          cweIds: ['CWE-601'],
          cweId: null,
          owaspCategory: 'A01:2021-Broken Access Control',
          cvssVector: null,
          cvssScore: null,
          lastSeenAt: new Date('2026-03-21T07:00:00.000Z'),
        },
      ],
      [],
    );

    const service = new SecurityOpsToolService({ db: mocks.db } as never);
    const result = await service.queryFindings({
      userId: 'user-1',
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
      },
      input: {
        assetRef: {
          kind: 'ip',
          value: '203.0.113.10',
        },
        severity: 'medium',
        status: 'open',
      },
    });

    expect(result).toEqual({
      findings: [
        {
          id: 'finding-1',
          title: 'Open redirect',
          severity: 'medium',
          state: 'confirmed',
          validationProof: null,
          assetValue: '203.0.113.10',
          summary: 'Redirects to arbitrary domains.',
          businessImpact: 'Users can be redirected to attacker-controlled phishing domains.',
          technicalAnalysis: 'The redirect parameter is trusted without origin validation.',
          pocDescription: 'Request /redirect?next=https://evil.example and observe the Location header.',
          assumptions: 'Attacker can convince a user to follow a crafted link.',
          remediation: 'Allow-list redirect targets and reject external origins.',
          fixEffort: null,
          cweIds: ['CWE-601'],
          owaspCategory: 'A01:2021-Broken Access Control',
          cvssVector: null,
          cvssScore: null,
          reportCompleteness: {
            missingReportFields: [],
            advisoryMissingFields: ['fixEffort', 'cvss'],
            canFinalizeReportable: true,
          },
          missingReportFields: [],
          advisoryMissingFields: ['fixEffort', 'cvss'],
          revalidationHint:
            'If you are re-verifying this finding with fresh evidence, call report_finding with validatesFindingId="finding-1" instead of creating a new finding.',
          lastSeenAt: '2026-03-21T07:00:00.000Z',
        },
      ],
      totalCount: 1,
    });
  });

  it('updates an existing note by deep-merging data and evidence for a known ntype', async () => {
    await mkdir(join(workspaceDir, '.artifacts'), { recursive: true });
    await writeFile(join(workspaceDir, '.artifacts', 'headers.txt'), 'Server: nginx');

    mocks.selectResults.push(
      [{ id: 'asset-1', tags: ['prod'], evidence: [{ path: 'existing-proof.txt', label: 'Existing proof' }] }],
      [
        {
          id: 'note-1',
          data: {
            url: 'https://api.example.com',
            headers: { server: 'nginx' },
            missing: ['x-frame-options'],
          },
          evidence: [{ path: 'existing-proof.txt', label: 'Existing proof', excerpt: 'Initial capture' }],
        },
      ],
    );

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T08:15:00.000Z'),
    } as never);

    const result = await service.reportNote({
      userId: 'user-1',
      workspaceDir,
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
      },
      input: {
        assetRef: { kind: 'domain', value: 'API.EXAMPLE.COM' },
        ntype: 'http.headers',
        title: ' Headers snapshot ',
        confidence: 0.6,
        data: {
          url: 'https://api.example.com',
          headers: { via: 'edge' },
          missing: ['content-security-policy'],
        },
        evidence: [
          {
            path: '/workspace/.artifacts/headers.txt',
            label: ' Latest capture ',
            excerpt: 'Server: nginx',
          },
        ],
      },
    });

    expect(result).toEqual({
      noteId: 'note-1',
      created: false,
      dedupeKey: expect.any(String),
    });
    expect(mocks.eqMock).toHaveBeenCalledWith('assets.value', 'api.example.com');

    const assetUpdate = mocks.updateCalls.find((call) => (call.table as { __table: string }).__table === 'assets');
    expect(assetUpdate).toMatchObject({
      values: expect.objectContaining({
        tags: ['prod'],
        evidence: [{ path: 'existing-proof.txt', label: 'Existing proof' }],
      }),
    });
    // Organization is identity and scope is a membership; re-observing an asset
    // must rewrite neither. See AssetIngestionWriter.touchScopeMembership.
    expect(assetUpdate?.values).not.toHaveProperty('organizationId');
    expect(assetUpdate?.values).not.toHaveProperty('scopeId');

    const noteUpdate = mocks.updateCalls.find(
      (call) => (call.table as { __table: string }).__table === 'inventory_notes',
    );
    expect(noteUpdate).toMatchObject({
      values: expect.objectContaining({
        scopeId: SCOPE_ID,
        title: 'Headers snapshot',
        confidence: 0.6,
        data: {
          url: 'https://api.example.com',
          headers: {
            server: 'nginx',
            via: 'edge',
          },
          missing: ['content-security-policy'],
        },
        evidence: [
          { path: 'existing-proof.txt', label: 'Existing proof', excerpt: 'Initial capture' },
          { path: '.artifacts/headers.txt', label: 'Latest capture', excerpt: 'Server: nginx' },
        ],
      }),
    });
  });

  it('replaces stale scan.coverage material fields instead of deep-merging them', async () => {
    mocks.selectResults.push(
      [{ id: 'asset-1', tags: [], evidence: [] }],
      [
        {
          id: 'note-coverage-1',
          data: {
            family: 'broad-surface',
            status: 'blocked',
            profileVersion: 'broad-surface-scan/v1',
            inventoryFingerprint: 'old-fingerprint',
            reason: 'stale blocked reason',
            toolset: ['httpx'],
            stats: {
              endpointsDiscovered: 1,
              findingsCreated: 0,
            },
          },
          evidence: [],
        },
      ],
    );

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T08:30:00.000Z'),
    } as never);

    const result = await service.reportNote({
      userId: 'user-1',
      workspaceDir,
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
      },
      input: {
        assetRef: { kind: 'domain', value: 'api.example.com' },
        ntype: 'scan.coverage',
        data: {
          family: 'broad-surface',
          status: 'completed',
          profileVersion: 'broad-surface-scan/v1',
          inventoryFingerprint: 'new-fingerprint',
          toolset: ['httpx'],
          stats: {
            endpointsDiscovered: 5,
            techsDetected: 2,
          },
        },
      },
    });

    expect(result).toEqual({
      noteId: 'note-coverage-1',
      created: false,
      dedupeKey: expect.any(String),
    });

    const noteUpdate = mocks.updateCalls.find(
      (call) => (call.table as { __table: string }).__table === 'inventory_notes',
    );
    expect(noteUpdate).toMatchObject({
      values: expect.objectContaining({
        data: {
          family: 'broad-surface',
          status: 'completed',
          profileVersion: 'broad-surface-scan/v1',
          inventoryFingerprint: 'new-fingerprint',
          toolset: ['httpx'],
          stats: {
            endpointsDiscovered: 5,
            techsDetected: 2,
          },
        },
      }),
    });
    expect((noteUpdate?.values as any).data.reason).toBeUndefined();
  });

  it('prunes null optional note fields before schema validation', async () => {
    mocks.selectResults.push([]);
    mocks.insertReturningResults.push([{ id: 'note-run-digest-1' }]);

    const service = new SecurityOpsToolService({
      db: mocks.db,
      now: () => new Date('2026-03-21T08:45:00.000Z'),
    } as never);

    const result = await service.reportNote({
      userId: 'user-1',
      workspaceDir,
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
      },
      input: {
        ntype: 'run.digest',
        title: 'Run digest',
        data: {
          goal: 'Map exposed services',
          outcome: 'completed',
          blocker_summary: null,
          completed_tasks: ['task-1'],
          blocked_tasks: null,
          next_prerequisites: undefined,
          closesCompliance: [{ frameworkKey: 'soc2', controlId: 'CC6.7' }],
        },
      },
    });

    expect(result).toEqual({
      noteId: 'note-run-digest-1',
      created: true,
      dedupeKey: expect.any(String),
    });

    const noteInsert = mocks.insertCalls.find(
      (call) => (call.table as { __table: string }).__table === 'inventory_notes',
    );
    expect(noteInsert).toMatchObject({
      values: expect.objectContaining({
        data: {
          goal: 'Map exposed services',
          outcome: 'completed',
          completed_tasks: ['task-1'],
          closesCompliance: [{ frameworkKey: 'soc2', controlId: 'CC6.7' }],
        },
      }),
    });
  });

  it('validates Code Review run digests with the Code Review recommendation policy', async () => {
    mocks.selectResults.push([]);
    mocks.insertReturningResults.push([{ id: 'note-code-review-digest-1' }]);

    const service = new SecurityOpsToolService({ db: mocks.db } as never);
    const immutableCommitSha = 'a'.repeat(40);

    const result = await service.reportNote({
      userId: 'user-1',
      workspaceDir,
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
        workflowDiscipline: 'code_review',
      },
      input: {
        ntype: 'run.digest',
        title: 'Code Review digest',
        data: {
          workflowDiscipline: 'code_review',
          repositoryId: 'repo-123',
          immutableCommitSha,
          goal: 'Review the authentication data flow.',
          outcome: 'completed',
        },
      },
    });

    expect(result).toEqual({
      noteId: 'note-code-review-digest-1',
      created: true,
      dedupeKey: expect.any(String),
    });
    const noteInsert = mocks.insertCalls.find(
      (call) => (call.table as { __table: string }).__table === 'inventory_notes',
    );
    expect(noteInsert).toMatchObject({
      values: expect.objectContaining({
        data: expect.objectContaining({
          workflowDiscipline: 'code_review',
          repositoryId: 'repo-123',
          immutableCommitSha,
        }),
      }),
    });
  });

  it('rejects invalid payloads for typed notes before writing inventory data', async () => {
    const service = new SecurityOpsToolService({ db: mocks.db } as never);

    await expect(
      service.reportNote({
        userId: 'user-1',
        workspaceDir,
        context: {
          organizationId: ORG_ID,
          scopeId: SCOPE_ID,
        },
        input: {
          ntype: 'http.endpoint',
          data: {
            url: 'https://api.example.com/login',
            statusCode: '302',
          },
        },
      }),
    ).rejects.toThrow(/report_note validation failed for http\.endpoint: .*Example:/i);
    expect(mocks.selectCalls).toHaveLength(0);
    expect(mocks.insertCalls).toHaveLength(0);
    expect(mocks.updateCalls).toHaveLength(0);
  });

  it('rejects validation.lead closeout without observations before writing inventory data', async () => {
    const service = new SecurityOpsToolService({ db: mocks.db } as never);

    await expect(
      service.reportNote({
        userId: 'user-1',
        workspaceDir,
        context: {
          organizationId: ORG_ID,
          scopeId: SCOPE_ID,
        },
        input: {
          ntype: 'validation.lead',
          data: {
            source: 'openapi',
            riskFamily: 'idor',
            target: 'https://api.example.com',
            method: 'GET',
            path: '/api/orders/{orderId}',
            parameter: 'orderId',
            hypothesis: 'orderId may expose another user order without authorization checks.',
            status: 'false_positive',
          },
        },
      }),
    ).rejects.toThrow(/validation\.lead.*observations/i);
    expect(mocks.selectCalls).toHaveLength(0);
    expect(mocks.insertCalls).toHaveLength(0);
    expect(mocks.updateCalls).toHaveLength(0);
  });

  it('accepts validation.lead closeout when the disproving observation is recorded', async () => {
    mocks.selectResults.push([]);
    mocks.insertReturningResults.push([{ id: 'lead-note-1' }]);
    const service = new SecurityOpsToolService({ db: mocks.db } as never);

    const result = await service.reportNote({
      userId: 'user-1',
      workspaceDir,
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
      },
      input: {
        ntype: 'validation.lead',
        data: {
          source: 'openapi',
          riskFamily: 'idor',
          target: 'https://api.example.com',
          method: 'GET',
          path: '/api/orders/{orderId}',
          parameter: 'orderId',
          hypothesis: 'orderId may expose another user order without authorization checks.',
          status: 'false_positive',
          supersedesLeadId: '11111111-1111-4111-8111-111111111111',
          observations: [
            {
              technique: 'http_differential',
              probe: 'orderId baseline=1 variants=2,99999999',
              result: 'contradicted',
              note: 'All variants returned the same 401 response.',
            },
          ],
        },
      },
    });

    expect(result).toEqual({
      noteId: 'lead-note-1',
      created: true,
      dedupeKey: expect.any(String),
    });
    const noteInsert = mocks.insertCalls.find(
      (call) => (call.table as { __table: string }).__table === 'inventory_notes',
    );
    expect(noteInsert).toMatchObject({
      values: expect.objectContaining({
        ntype: 'validation.lead',
        data: expect.objectContaining({
          status: 'false_positive',
          supersedesLeadId: '11111111-1111-4111-8111-111111111111',
          observations: [
            expect.objectContaining({
              technique: 'http_differential',
              result: 'contradicted',
            }),
          ],
        }),
      }),
    });
  });

  it('rejects report_note payloads that omit the top-level data object with a template-guided error', async () => {
    const service = new SecurityOpsToolService({ db: mocks.db } as never);

    await expect(
      service.reportNote({
        userId: 'user-1',
        workspaceDir,
        context: {
          organizationId: ORG_ID,
          scopeId: SCOPE_ID,
        },
        input: {
          ntype: 'run.digest',
          title: 'Run digest for api.example.com',
        },
      }),
    ).rejects.toThrow(/The `data` object is always required for report_note.*run\.digest/i);
    expect(mocks.selectCalls).toHaveLength(0);
    expect(mocks.insertCalls).toHaveLength(0);
    expect(mocks.updateCalls).toHaveLength(0);
  });

  it('rejects partial run.digest notes with a concrete example payload', async () => {
    const service = new SecurityOpsToolService({ db: mocks.db } as never);

    await expect(
      service.reportNote({
        userId: 'user-1',
        workspaceDir,
        context: {
          organizationId: ORG_ID,
          scopeId: SCOPE_ID,
        },
        input: {
          ntype: 'run.digest',
          data: {
            outcome: 'completed',
          },
        },
      }),
    ).rejects.toThrow(/report_note validation failed for run\.digest: goal: Required.*Example:/i);
    expect(mocks.selectCalls).toHaveLength(0);
    expect(mocks.insertCalls).toHaveLength(0);
    expect(mocks.updateCalls).toHaveLength(0);
  });

  it('queries notes by asset reference, prefix ntype, and since filters', async () => {
    mocks.selectResults.push(
      [{ id: 'asset-1' }],
      [
        {
          id: 'note-1',
          assetId: 'asset-1',
          ntype: 'dns.subdomain',
          title: null,
          data: { hostname: 'api.example.com' },
          confidence: 0.7,
          firstSeenAt: new Date('2026-03-18T09:00:00.000Z'),
          lastSeenAt: '2026-03-21T09:30:00.000Z',
        },
      ],
    );

    const service = new SecurityOpsToolService({ db: mocks.db } as never);
    const result = await service.queryNotes({
      userId: 'user-1',
      context: {
        organizationId: ORG_ID,
        scopeId: SCOPE_ID,
      },
      input: {
        assetRef: {
          kind: 'domain',
          value: 'https://API.EXAMPLE.COM/login',
        },
        ntype: 'dns.',
        since: '2026-03-20T00:00:00.000Z',
        limit: 50,
      },
    });

    expect(result).toEqual({
      notes: [
        {
          id: 'note-1',
          assetId: 'asset-1',
          ntype: 'dns.subdomain',
          title: null,
          data: { hostname: 'api.example.com' },
          confidence: 0.7,
          firstSeenAt: '2026-03-18T09:00:00.000Z',
          lastSeenAt: '2026-03-21T09:30:00.000Z',
        },
      ],
      totalCount: 1,
    });

    expect(mocks.eqMock).toHaveBeenCalledWith('assets.value', 'api.example.com');
    expect(mocks.likeMock).toHaveBeenCalledWith('inventory_notes.ntype', 'dns.%');
    expect(mocks.selectCalls[1]).toMatchObject({ limit: 50 });
  });

  it('rejects query_notes IP references that are really UUID-like asset ids', async () => {
    const service = new SecurityOpsToolService({ db: mocks.db } as never);

    await expect(
      service.queryNotes({
        userId: 'user-1',
        context: {
          organizationId: ORG_ID,
          scopeId: SCOPE_ID,
        },
        input: {
          assetRef: {
            kind: 'ip',
            value: '11111111-1111-4111-8111-111111111111',
          },
        },
      }),
    ).rejects.toThrow(/It looks like a UUID/i);
    expect(mocks.selectCalls).toHaveLength(0);
  });
});
