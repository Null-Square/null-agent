import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { and, eq } from 'drizzle-orm';

import { setupTestDb } from '../../helpers/testDb';
import {
  agentSessions,
  assets as assetsTable,
  findingEvidence as findingEvidenceTable,
  findings as findingsTable,
  inventoryNotes as inventoryNotesTable,
  inventoryServices as inventoryServicesTable,
  organizations,
  scannerObservations as scannerObservationsTable,
  users,
} from '@/db/schema';
import { SecurityOpsToolService } from '@/domains/security-ops/tools/SecurityOpsToolService';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'ingestion');
const FIXED_NOW = new Date('2026-06-11T00:00:00.000Z');

const INGESTION_CASES = [
  { parser: 'subfinder', fixture: 'subfinder.jsonl', rootAssetRef: { kind: 'domain', value: 'example.com' } },
  { parser: 'naabu', fixture: 'naabu.txt' },
  { parser: 'httpx', fixture: 'httpx.jsonl' },
  { parser: 'nuclei', fixture: 'nuclei.jsonl' },
  { parser: 'katana', fixture: 'katana.jsonl' },
  { parser: 'ffuf', fixture: 'ffuf.json' },
  { parser: 'openapi', fixture: 'openapi.json' },
  { parser: 'nmap', fixture: 'nmap.xml' },
  { parser: 'dalfox', fixture: 'dalfox.json' },
  { parser: 'gitleaks', fixture: 'gitleaks.json' },
  { parser: 'trufflehog', fixture: 'trufflehog.jsonl' },
  { parser: 'trivy', fixture: 'trivy.json' },
  { parser: 'semgrep', fixture: 'semgrep.sarif' },
  { parser: 'sqlmap', fixture: 'sqlmap.txt' },
] as const;

type Parser = (typeof INGESTION_CASES)[number]['parser'];
type IngestSummarySnapshot = Record<string, unknown>;

const baseSummary = (parser: Parser, artifactPath: string): IngestSummarySnapshot => ({
  parser,
  artifactPath,
  assetsCreated: 0,
  assetsTouched: 0,
  servicesCreated: 0,
  servicesTouched: 0,
  subdomainNotesCreated: 0,
  subdomainNotesTouched: 0,
  endpointNotesCreated: 0,
  endpointNotesTouched: 0,
  techNotesCreated: 0,
  techNotesTouched: 0,
  observationsCreated: 0,
  observationsTouched: 0,
  findingsCreated: 0,
  findingsTouched: 0,
  skipped: 0,
  suppressed: 0,
  duplicates: 0,
  noise: {},
});

const artifactPathFor = (parser: Parser, fixture: string) => `.artifacts/scans/${parser}/${fixture}`;

const expectedSummary = (parser: Parser, fixture: string): IngestSummarySnapshot => {
  const summary = baseSummary(parser, artifactPathFor(parser, fixture));
  switch (parser) {
    case 'subfinder':
      return { ...summary, assetsCreated: 1, assetsTouched: 1, subdomainNotesCreated: 2 };
    case 'naabu':
      return { ...summary, assetsCreated: 1, servicesCreated: 2 };
    case 'httpx':
      return { ...summary, assetsCreated: 1, servicesCreated: 1, endpointNotesCreated: 1, techNotesCreated: 2 };
    case 'katana':
    case 'ffuf':
      return { ...summary, endpointNotesCreated: 1 };
    case 'openapi':
      return { ...summary, endpointNotesCreated: 1, observationsCreated: 3 };
    case 'nmap':
      return { ...summary, assetsCreated: 1, servicesCreated: 1 };
    case 'nuclei':
    case 'dalfox':
    case 'gitleaks':
    case 'trufflehog':
    case 'trivy':
    case 'semgrep':
    case 'sqlmap':
      return { ...summary, observationsCreated: 1, findingsCreated: 1 };
  }
};

const rootAssetRef = { kind: 'domain' as const, value: 'api.example.com' };

type SnapshotRows = {
  assets: unknown[];
  services: unknown[];
  notes: unknown[];
  scannerObservations: unknown[];
  findings: unknown[];
  findingEvidence: unknown[];
};

const emptyRows = (): SnapshotRows => ({
  assets: [],
  services: [],
  notes: [],
  scannerObservations: [],
  findings: [],
  findingEvidence: [],
});

const evidence = (parser: Parser, fixture: string, label: string) => [
  { path: artifactPathFor(parser, fixture), label },
];

const expectedRows = (parser: Parser, fixture: string): SnapshotRows => {
  const artifactPath = artifactPathFor(parser, fixture);
  const rows = emptyRows();

  switch (parser) {
    case 'subfinder':
      rows.assets = [{ kind: 'domain', value: 'example.com', parentAsset: null, evidence: [] }];
      rows.notes = [
        {
          asset: 'example.com',
          ntype: 'dns.subdomain',
          title: null,
          confidence: null,
          data: { hostname: 'admin.example.com' },
          evidence: evidence(parser, fixture, 'subfinder artifact'),
        },
        {
          asset: 'example.com',
          ntype: 'dns.subdomain',
          title: null,
          confidence: null,
          data: { hostname: 'api.example.com' },
          evidence: evidence(parser, fixture, 'subfinder artifact'),
        },
      ];
      return rows;
    case 'naabu':
      rows.assets = [
        {
          kind: 'domain',
          value: 'api.example.com',
          parentAsset: null,
          evidence: evidence(parser, fixture, 'naabu artifact'),
        },
      ];
      rows.services = [
        { asset: 'api.example.com', protocol: 'tcp', port: 443, serviceName: null, product: null, version: null, evidence: evidence(parser, fixture, 'naabu artifact') },
        { asset: 'api.example.com', protocol: 'tcp', port: 8443, serviceName: null, product: null, version: null, evidence: evidence(parser, fixture, 'naabu artifact') },
      ];
      return rows;
    case 'httpx':
      rows.assets = [
        {
          kind: 'domain',
          value: 'api.example.com',
          parentAsset: null,
          evidence: evidence(parser, fixture, 'httpx artifact'),
        },
      ];
      rows.services = [
        { asset: 'api.example.com', protocol: 'https', port: 443, serviceName: 'https', product: 'nginx', version: '1.25.3', evidence: evidence(parser, fixture, 'httpx artifact') },
      ];
      rows.notes = [
        {
          asset: 'api.example.com',
          ntype: 'http.endpoint',
          title: 'Login',
          confidence: null,
          data: { method: 'GET', statusCode: 200, title: 'Login', url: 'https://api.example.com/login' },
          evidence: evidence(parser, fixture, 'httpx artifact'),
        },
        {
          asset: 'api.example.com',
          ntype: 'tech.fingerprint',
          title: null,
          confidence: null,
          data: { product: 'react' },
          evidence: evidence(parser, fixture, 'httpx artifact'),
        },
        {
          asset: 'api.example.com',
          ntype: 'tech.fingerprint',
          title: null,
          confidence: null,
          data: { category: 'web-server', product: 'nginx', version: '1.25.3' },
          evidence: evidence(parser, fixture, 'httpx artifact'),
        },
      ];
      return rows;
    case 'katana':
      rows.assets = [
        { kind: 'domain', value: 'api.example.com', parentAsset: null, evidence: [] },
      ];
      rows.notes = [
        {
          asset: 'api.example.com',
          ntype: 'http.endpoint',
          title: null,
          confidence: null,
          data: { method: 'GET', source: 'katana', url: 'https://api.example.com/static/app.js' },
          evidence: evidence(parser, fixture, 'katana artifact'),
        },
      ];
      return rows;
    case 'ffuf':
      rows.assets = [
        { kind: 'domain', value: 'api.example.com', parentAsset: null, evidence: [] },
      ];
      rows.notes = [
        {
          asset: 'api.example.com',
          ntype: 'http.endpoint',
          title: null,
          confidence: 0.7,
          data: {
            method: 'GET',
            signal: 'high',
            source: 'ffuf',
            sourceArtifact: artifactPath,
            statusCode: 200,
            url: 'https://api.example.com/admin',
          },
          evidence: evidence(parser, fixture, 'ffuf artifact'),
        },
      ];
      return rows;
    case 'openapi':
      rows.assets = [
        { kind: 'domain', value: 'api.example.com', parentAsset: null, evidence: [] },
      ];
      rows.notes = [
        {
          asset: 'api.example.com',
          ntype: 'http.endpoint',
          title: 'Get user',
          confidence: null,
          data: {
            authHint: 'anonymous',
            bodyParams: [],
            confidence: 0.9,
            method: 'GET',
            pathParams: ['id'],
            queryParams: ['include'],
            source: 'openapi',
            sourceArtifact: artifactPath,
            summary: 'Get user',
            tags: [],
            title: 'Get user',
            url: 'https://api.example.com/users/{id}',
            urlTemplate: '/users/{id}',
          },
          evidence: [{ path: artifactPath, label: 'OpenAPI artifact' }],
        },
        {
          asset: 'api.example.com',
          ntype: 'validation.lead',
          title: 'idor lead for GET /users/{id}',
          confidence: null,
          data: {
            evidenceRefs: [artifactPath],
            hypothesis: 'GET /users/{id} exposes object identifier "id" and needs authorization-boundary validation for cross-tenant or cross-user access.',
            method: 'GET',
            parameter: 'id',
            path: '/users/{id}',
            priority: 'high',
            requiredControls: [
              'unauthenticated baseline',
              'same-user authorized baseline when credentials exist',
              'different-user or different-tenant object access attempt when credentials exist',
            ],
            requiredPrerequisites: ['two comparable authorized principals for promotion beyond unauthenticated/access-wall evidence'],
            riskFamily: 'idor',
            source: 'openapi',
            status: 'open',
            target: 'https://api.example.com/users/{id}',
          },
          evidence: [{ path: artifactPath, label: 'OpenAPI artifact' }],
        },
        {
          asset: 'api.example.com',
          ntype: 'validation.lead',
          title: 'information-disclosure lead for GET /users/{id}',
          confidence: null,
          data: {
            evidenceRefs: [artifactPath],
            hypothesis: 'GET /users/{id} may expose sensitive data with authHint=anonymous; validate unauthenticated and least-privilege response contents.',
            method: 'GET',
            path: '/users/{id}',
            priority: 'high',
            requiredControls: ['unauthenticated baseline', 'authorized baseline when credentials exist', 'sensitive-field response review'],
            requiredPrerequisites: ['credentialed role material for role-boundary proof when the endpoint requires authentication'],
            riskFamily: 'information-disclosure',
            source: 'openapi',
            status: 'open',
            target: 'https://api.example.com/users/{id}',
          },
          evidence: [{ path: artifactPath, label: 'OpenAPI artifact' }],
        },
        {
          asset: 'api.example.com',
          ntype: 'validation.lead',
          title: 'sensitive-public-endpoint lead for GET /users/{id}',
          confidence: null,
          data: {
            evidenceRefs: [artifactPath],
            hypothesis: 'GET /users/{id} handles sensitive objects with authHint=anonymous; validate public exposure and least-privilege access.',
            method: 'GET',
            path: '/users/{id}',
            priority: 'high',
            requiredControls: ['unauthenticated baseline', 'least-privilege role check when credentials exist', 'sensitive field exposure review'],
            requiredPrerequisites: ['credentialed role material for role-boundary proof'],
            riskFamily: 'sensitive-public-endpoint',
            source: 'openapi',
            status: 'open',
            target: 'https://api.example.com/users/{id}',
          },
          evidence: [{ path: artifactPath, label: 'OpenAPI artifact' }],
        },
      ];
      return rows;
    case 'nmap':
      rows.assets = [
        {
          kind: 'domain',
          value: 'api.example.com',
          parentAsset: null,
          evidence: evidence(parser, fixture, 'nmap artifact'),
        },
      ];
      rows.services = [
        { asset: 'api.example.com', protocol: 'tcp', port: 8443, serviceName: 'https', product: 'nginx', version: '1.25', evidence: evidence(parser, fixture, 'nmap artifact') },
      ];
      return rows;
    case 'nuclei':
      return expectedScannerFindingRows(parser, fixture, {
        title: 'Test exposed admin panel',
        severity: 'high',
        summary: 'Test exposed admin panel was reported by nuclei template cves/2026/test-cve.',
        cweIds: ['CWE-200'],
        cveIds: ['CVE-2026-0001'],
      });
    case 'dalfox':
      return expectedScannerFindingRows(parser, fixture, {
        title: 'Reflected XSS',
        severity: 'medium',
        summary: 'Reflected XSS was produced by dalfox.',
      });
    case 'gitleaks':
      return expectedScannerFindingRows(parser, fixture, {
        title: 'Generic API key',
        severity: 'high',
        summary: 'Generic API key was produced by gitleaks.',
      });
    case 'trufflehog':
      return expectedScannerFindingRows(parser, fixture, {
        title: 'AWS secret',
        severity: 'high',
        summary: 'AWS secret was produced by trufflehog.',
      });
    case 'trivy':
      return expectedScannerFindingRows(parser, fixture, {
        title: 'Vulnerable dependency',
        severity: 'high',
        summary: 'Vulnerable dependency was produced by trivy.',
        cveIds: ['CVE-2026-1111'],
      });
    case 'semgrep':
      return expectedScannerFindingRows(parser, fixture, {
        title: 'javascript.express.security.audit.xss',
        severity: 'medium',
        summary: 'javascript.express.security.audit.xss was produced by semgrep.',
        codeLocations: [{
          pathKind: 'workspace',
          repository: null,
          ref: null,
          filePath: 'src/app.ts',
          startLine: 12,
          endLine: 13,
          label: 'javascript.express.security.audit.xss',
          fixBefore: 'See scanner artifact for vulnerable code context.',
          fixAfter: 'Apply the remediation recommended for this rule and rerun Semgrep.',
        }],
      });
    case 'sqlmap':
      return expectedScannerFindingRows(parser, fixture, {
        title: 'SQL injection signal from sqlmap',
        severity: 'high',
        summary: 'SQL injection signal from sqlmap was produced by sqlmap.',
        cweIds: ['CWE-89'],
      });
  }
};

function expectedScannerFindingRows(
  parser: Parser,
  fixture: string,
  finding: {
    title: string;
    severity: string;
    summary: string;
    cweIds?: string[];
    cveIds?: string[];
    codeLocations?: unknown[];
  },
): SnapshotRows {
  const rows = emptyRows();
  rows.assets = [
    {
      kind: 'domain',
      value: 'api.example.com',
      parentAsset: null,
      evidence: evidence(parser, fixture, `${parser} artifact`),
    },
  ];
  rows.scannerObservations = [
    {
      parser,
      asset: 'api.example.com',
      artifactPath: artifactPathFor(parser, fixture),
      observationType: 'vulnerability',
      title: finding.title,
      severity: finding.severity,
      evidence: evidence(parser, fixture, `${parser} artifact`),
    },
  ];
  rows.findings = [
    {
      asset: 'api.example.com',
      title: finding.title,
      severity: finding.severity,
      state: 'potential',
      sourceKind: 'assessment',
      summary: finding.summary,
      cweIds: finding.cweIds ?? [],
      cveIds: finding.cveIds ?? [],
      codeLocations: finding.codeLocations ?? [],
    },
  ];
  rows.findingEvidence = [
    {
      finding: finding.title,
      kind: 'artifact',
      path: artifactPathFor(parser, fixture),
      displayPath: artifactPathFor(parser, fixture),
      label: `${parser} artifact`,
      fileMissing: false,
    },
  ];
  return rows;
}

maybeDescribe('SecurityOpsToolService scanner ingestion characterization', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let skip = false;

  beforeAll(async () => {
    try {
      harness = await setupTestDb();
      if (!harness) {
        skip = true;
      }
    } catch {
      skip = true;
    }
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  for (const testCase of INGESTION_CASES) {
    it(`pins ${testCase.parser} ingestion rows`, async () => {
      if (skip || !harness) return;

      const fixture = await createSecurityOpsFixture(harness);
      try {
        const artifactPath = await copyFixtureArtifact({
          workspaceDir: fixture.workspaceDir,
          parser: testCase.parser,
          fixture: testCase.fixture,
        });

        const summary = await fixture.service.ingestScanArtifact({
          userId: fixture.userId,
          sessionId: fixture.sessionId,
          workspaceDir: fixture.workspaceDir,
          context: fixture.context,
          input: {
            parser: testCase.parser,
            artifactPath,
            rootAssetRef: 'rootAssetRef' in testCase ? testCase.rootAssetRef : rootAssetRef,
          },
        });

        expect(summary).toEqual(expectedSummary(testCase.parser, testCase.fixture));
        await expect(snapshotIngestionRows(fixture)).resolves.toEqual(finalizeExpectedRows(expectedRows(testCase.parser, testCase.fixture)));
      } finally {
        await fixture.cleanup();
      }
    });
  }

  it('derives leads from durable facts instead of stored lifecycle state', async () => {
    if (skip || !harness) return;

    const fixture = await createSecurityOpsFixture(harness);
    try {
      await fixture.service.reportAsset({
        userId: fixture.userId,
        sessionId: fixture.sessionId,
        workspaceDir: fixture.workspaceDir,
        context: fixture.context,
        input: { kind: 'domain', value: 'lead.example.com' },
      });

      const confirmedOnly = await fixture.service.queryInventory({
        userId: fixture.userId,
        context: fixture.context,
        input: {},
      });
      expect(confirmedOnly.assets).toEqual([]);

      const withLeads = await fixture.service.queryInventory({
        userId: fixture.userId,
        context: fixture.context,
        input: { includeLeads: true },
      });
      expect(withLeads.assets).toEqual([
        expect.objectContaining({ value: 'lead.example.com', isLead: true }),
      ]);

      await fixture.service.reportService({
        userId: fixture.userId,
        sessionId: fixture.sessionId,
        workspaceDir: fixture.workspaceDir,
        context: fixture.context,
        input: {
          assetRef: { kind: 'domain', value: 'lead.example.com' },
          protocol: 'https',
          port: 443,
        },
      });

      const afterConfirmation = await fixture.service.queryInventory({
        userId: fixture.userId,
        context: fixture.context,
        input: {},
      });
      expect(afterConfirmation.assets).toEqual([
        expect.objectContaining({ value: 'lead.example.com', isLead: false }),
      ]);
    } finally {
      await fixture.cleanup();
    }
  });
});

async function createSecurityOpsFixture(harness: NonNullable<Awaited<ReturnType<typeof setupTestDb>>>) {
  const db = harness.db as any;
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `scanner-characterization-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    password_hash: 'test',
  });

  const [{ id: organizationId }] = await db
    .insert(organizations)
    .values({
      name: 'Scanner Characterization Org',
      slug: `scanner-characterization-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    })
    .returning({ id: organizations.id });

  const scopeInsert = await harness.pool.query<{ id: string }>(
    'INSERT INTO scopes (organization_id, name) VALUES ($1, $2) RETURNING id',
    [organizationId, 'Primary Scope'],
  );
  const scopeId = scopeInsert.rows[0]?.id;
  if (!scopeId) {
    throw new Error('Failed to create scope for scanner characterization');
  }

  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ns-ingestion-characterization-'));
  const [{ id: sessionId }] = await db
    .insert(agentSessions)
    .values({
      userId,
      workspaceDir,
    })
    .returning({ id: agentSessions.id });

  return {
    db,
    service: new SecurityOpsToolService({ db, now: () => FIXED_NOW }),
    userId,
    organizationId,
    scopeId,
    sessionId,
    workspaceDir,
    context: { organizationId, scopeId },
    cleanup: async () => {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    },
  };
}

async function copyFixtureArtifact(params: { workspaceDir: string; parser: Parser; fixture: string }): Promise<string> {
  const relativePath = artifactPathFor(params.parser, params.fixture);
  const absolutePath = path.join(params.workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.copyFile(path.join(FIXTURE_ROOT, params.fixture), absolutePath);
  return relativePath;
}

async function snapshotIngestionRows(fixture: Awaited<ReturnType<typeof createSecurityOpsFixture>>): Promise<SnapshotRows> {
  const db = fixture.db as any;
  const assetRows = await db
    .select()
    .from(assetsTable)
    .where(and(eq(assetsTable.userId, fixture.userId), eq(assetsTable.scopeId, fixture.scopeId)));
  const assetById = new Map<string, any>(assetRows.map((row: any) => [row.id, row]));

  const serviceRows = await db
    .select()
    .from(inventoryServicesTable)
    .where(eq(inventoryServicesTable.userId, fixture.userId));
  const noteRows = await db
    .select()
    .from(inventoryNotesTable)
    .where(and(eq(inventoryNotesTable.userId, fixture.userId), eq(inventoryNotesTable.scopeId, fixture.scopeId)));
  const observationRows = await db
    .select()
    .from(scannerObservationsTable)
    .where(and(eq(scannerObservationsTable.userId, fixture.userId), eq(scannerObservationsTable.scopeId, fixture.scopeId)));
  const findingRows = await db
    .select()
    .from(findingsTable)
    .where(and(eq(findingsTable.userId, fixture.userId), eq(findingsTable.scopeId, fixture.scopeId)));
  const findingById = new Map<string, any>(findingRows.map((row: any) => [row.id, row]));
  const evidenceRows = await db
    .select()
    .from(findingEvidenceTable)
    .where(eq(findingEvidenceTable.userId, fixture.userId));

  return {
    assets: sortSnapshotRows(assetRows.map((row: any) => ({
      kind: row.kind,
      value: row.value,
      parentAsset: row.parentAssetId ? assetById.get(row.parentAssetId)?.value ?? null : null,
      evidence: normalizeEvidence(row.evidence),
    }))),
    services: sortSnapshotRows(serviceRows.map((row: any) => ({
      asset: assetById.get(row.assetId)?.value ?? null,
      protocol: row.protocol,
      port: row.port,
      serviceName: row.serviceName ?? null,
      product: row.product ?? null,
      version: row.version ?? null,
      evidence: normalizeEvidence(row.evidence),
    }))),
    notes: sortSnapshotRows(noteRows.map((row: any) => ({
      asset: row.assetId ? assetById.get(row.assetId)?.value ?? null : null,
      ntype: row.ntype,
      title: row.title ?? null,
      confidence: normalizeNumber(row.confidence),
      data: normalizeJson(row.data),
      evidence: normalizeEvidence(row.evidence),
    }))),
    scannerObservations: sortSnapshotRows(observationRows.map((row: any) => ({
      parser: row.parser,
      asset: row.assetId ? assetById.get(row.assetId)?.value ?? null : null,
      artifactPath: row.artifactPath,
      observationType: row.observationType,
      title: row.title,
      severity: row.severity,
      evidence: normalizeEvidence(row.evidence),
    }))),
    findings: sortSnapshotRows(findingRows.map((row: any) => ({
      asset: assetById.get(row.assetId)?.value ?? null,
      title: row.title,
      severity: row.severity,
      state: row.state,
      sourceKind: row.sourceKind,
      summary: row.summary,
      cweIds: row.cweIds ?? [],
      cveIds: row.cveIds ?? [],
      codeLocations: normalizeJson(row.codeLocations ?? []),
    }))),
    findingEvidence: sortSnapshotRows(evidenceRows.map((row: any) => ({
      finding: findingById.get(row.findingId)?.title ?? null,
      kind: row.kind,
      path: row.path,
      displayPath: row.displayPath ?? null,
      label: row.label ?? null,
      fileMissing: row.fileMissing,
    }))),
  };
}

function normalizeEvidence(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return sortSnapshotRows(value.map((entry) => normalizeJson(entry)));
}

function finalizeExpectedRows(rows: SnapshotRows): SnapshotRows {
  return {
    assets: sortSnapshotRows(rows.assets.map((row) => normalizeJson(row))),
    services: sortSnapshotRows(rows.services.map((row) => normalizeJson(row))),
    notes: sortSnapshotRows(rows.notes.map((row) => normalizeJson(row))),
    scannerObservations: sortSnapshotRows(rows.scannerObservations.map((row) => normalizeJson(row))),
    findings: sortSnapshotRows(rows.findings.map((row) => normalizeJson(row))),
    findingEvidence: sortSnapshotRows(rows.findingEvidence.map((row) => normalizeJson(row))),
  };
}

function normalizeJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJson(entry)) as T;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, normalizeJson(entryValue)]),
  ) as T;
}

function normalizeNumber(value: unknown): number | null {
  return typeof value === 'number' ? Number(value.toFixed(3)) : null;
}

function sortSnapshotRows<T>(rows: T[]): T[] {
  return rows
    .map((row) => normalizeJson(row))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
