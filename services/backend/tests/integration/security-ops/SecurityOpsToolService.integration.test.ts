import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import { setupTestDb } from '../../helpers/testDb';
import {
  users,
  organizations,
  agentSessions,
  assets as assetsTable,
  assetObservations as assetObservationsTable,
  inventoryNotes as inventoryNotesTable,
  inventoryServices as inventoryServicesTable,
  findings as findingsTable,
  findingEvidence as findingEvidenceTable,
  scannerObservations as scannerObservationsTable,
} from '@/db/schema';
import { SecurityOpsToolService } from '@/domains/security-ops/tools/SecurityOpsToolService';
import { and, eq } from 'drizzle-orm';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const findingContractFields = {
  businessImpact: 'Attacker can execute arbitrary script in another user context.',
  technicalAnalysis: 'Unsanitized user-controlled input reaches a sensitive sink without the required protection.',
  pocDescription: '1. Send the crafted request. 2. Observe the vulnerable behavior. 3. Confirm the impact in the response.',
  pocScriptCode: 'print("proof-of-concept")',
  assumptions: 'Attacker can reach the affected endpoint from the authorized execution network.',
  fixEffort: 'medium' as const,
  remediation: 'Apply the missing validation or output encoding at the vulnerable sink.',
};

maybeDescribe('SecurityOpsToolService (integration)', () => {
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

  const itMaybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (skip || !harness) return;
      await fn();
    });

  const createSecurityOpsFixture = async () => {
    const db = harness!.db as any;
    const service = new SecurityOpsToolService({ db });

    await harness!.pool.query(`
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS cvss_vector TEXT;
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS cvss_score REAL;
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS confidence_score REAL;
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS cwe_ids TEXT[];
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS cve_ids TEXT[];
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS owasp_category TEXT;
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS technical_analysis TEXT;
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS poc_description TEXT;
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS poc_script_code TEXT;
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS assumptions TEXT;
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS fix_effort TEXT;
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS code_locations jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE finding_evidence ADD COLUMN IF NOT EXISTS file_missing boolean DEFAULT false;
      ALTER TABLE finding_evidence ADD COLUMN IF NOT EXISTS kind text DEFAULT 'artifact';
      ALTER TABLE finding_evidence ADD COLUMN IF NOT EXISTS display_path text;
      ALTER TABLE finding_evidence ADD COLUMN IF NOT EXISTS data jsonb;
    `);

    const lockClient: PoolClient = await harness!.pool.connect();
    let lockActive = false;
    try {
      await lockClient.query('BEGIN');
      await lockClient.query(
        'LOCK TABLE users, organizations, scopes, agent_sessions, assets, asset_observations, inventory_notes, inventory_services, findings, finding_evidence, finding_events IN ACCESS SHARE MODE',
      );
      lockActive = true;

      const userId = randomUUID();
      await db.insert(users).values({
        id: userId,
        email: `securityops-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
        password_hash: 'test',
      });

      const [{ id: organizationId }] = await db
        .insert(organizations)
        .values({
          name: 'SecurityOps Test Org',
          slug: `securityops-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        })
        .returning({ id: organizations.id });

      const scopeColumnsResult = await harness!.pool.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'scopes'
      `);
      const scopeColumns = new Set(scopeColumnsResult.rows.map((row) => row.column_name));

      const insertColumns = ['organization_id', 'name'];
      const insertValues: Array<string | boolean> = [organizationId, 'Primary Scope'];

      if (scopeColumns.has('user_id')) {
        insertColumns.push('user_id');
        insertValues.push(userId);
      }
      if (scopeColumns.has('kind')) {
        insertColumns.push('kind');
        insertValues.push('domain');
      }
      if (scopeColumns.has('safe_mode')) {
        insertColumns.push('safe_mode');
        insertValues.push(true);
      }
      if (scopeColumns.has('status')) {
        insertColumns.push('status');
        insertValues.push('active');
      }

      const placeholders = insertColumns.map((_, index) => `$${index + 1}`).join(', ');
      const scopeInsert = await harness!.pool.query<{ id: string }>(
        `INSERT INTO scopes (${insertColumns.join(', ')}) VALUES (${placeholders}) RETURNING id`,
        insertValues,
      );
      const scopeId = scopeInsert.rows[0]?.id;
      if (!scopeId) {
        throw new Error('Failed to create scope for SecurityOps integration test');
      }

      const context = { organizationId, scopeId };
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ns-securityops-'));
      const [{ id: sessionId }] = await db
        .insert(agentSessions)
        .values({
          userId,
          workspaceDir,
        })
        .returning({ id: agentSessions.id });

      await fs.mkdir(path.join(workspaceDir, '.artifacts'), { recursive: true });

      const writeArtifact = async (relativePath: string, content = 'evidence') => {
        const absolutePath = path.join(workspaceDir, relativePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, content);
        return `/workspace/${relativePath.replace(/\\/g, '/')}`;
      };

      const cleanup = async () => {
        try {
          await fs.rm(workspaceDir, { recursive: true, force: true });
        } finally {
          if (lockActive) {
            lockActive = false;
            await lockClient.query('ROLLBACK');
          }
          lockClient.release();
        }
      };

      return {
        db,
        service,
        userId,
        organizationId,
        scopeId,
        context,
        workspaceDir,
        sessionId,
        writeArtifact,
        cleanup,
      };
    } catch (error) {
      if (lockActive) {
        await lockClient.query('ROLLBACK').catch(() => undefined);
      }
      lockClient.release();
      throw error;
    }
  };

  itMaybe('reports inventory + findings and can query them back', async () => {
    const db = harness!.db as any;
    const service = new SecurityOpsToolService({ db });
    await harness!.pool.query(`
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS cvss_vector TEXT;
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS cvss_score REAL;
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS confidence_score REAL;
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS cwe_ids TEXT[];
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS cve_ids TEXT[];
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS owasp_category TEXT;
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS technical_analysis TEXT;
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS poc_description TEXT;
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS poc_script_code TEXT;
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS assumptions TEXT;
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS fix_effort TEXT;
      ALTER TABLE findings ADD COLUMN IF NOT EXISTS code_locations jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE finding_evidence ADD COLUMN IF NOT EXISTS file_missing boolean DEFAULT false;
      ALTER TABLE finding_evidence ADD COLUMN IF NOT EXISTS kind text DEFAULT 'artifact';
      ALTER TABLE finding_evidence ADD COLUMN IF NOT EXISTS display_path text;
      ALTER TABLE finding_evidence ADD COLUMN IF NOT EXISTS data jsonb;
    `);

    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `securityops-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
      password_hash: 'test',
    });

    const [{ id: organizationId }] = await db
      .insert(organizations)
      .values({
        name: 'SecurityOps Test Org',
        slug: `securityops-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      })
      .returning({ id: organizations.id });

    const scopeColumnsResult = await harness!.pool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'scopes'
    `);
    const scopeColumns = new Set(scopeColumnsResult.rows.map((row) => row.column_name));

    const insertColumns = ['organization_id', 'name'];
    const insertValues: Array<string | boolean> = [organizationId, 'Primary Scope'];

    if (scopeColumns.has('user_id')) {
      insertColumns.push('user_id');
      insertValues.push(userId);
    }
    if (scopeColumns.has('kind')) {
      insertColumns.push('kind');
      insertValues.push('domain');
    }
    if (scopeColumns.has('safe_mode')) {
      insertColumns.push('safe_mode');
      insertValues.push(true);
    }
    if (scopeColumns.has('status')) {
      insertColumns.push('status');
      insertValues.push('active');
    }

    const placeholders = insertColumns.map((_, index) => `$${index + 1}`).join(', ');
    const scopeInsert = await harness!.pool.query<{ id: string }>(
      `INSERT INTO scopes (${insertColumns.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      insertValues,
    );
    const scopeId = scopeInsert.rows[0]?.id;
    if (!scopeId) {
      throw new Error('Failed to create scope for SecurityOps integration test');
    }

    const context = { organizationId, scopeId };

    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ns-securityops-'));
    try {
      const [{ id: sessionId }] = await db
        .insert(agentSessions)
        .values({
          userId,
          workspaceDir,
        })
        .returning({ id: agentSessions.id });

      await fs.mkdir(path.join(workspaceDir, '.artifacts'), { recursive: true });
      const evRel = '.artifacts/evidence.txt';
      await fs.writeFile(path.join(workspaceDir, evRel), 'evidence');

      const asset = await service.reportAsset({
        userId,
        sessionId,
        workspaceDir,
        context,
        input: {
          kind: 'domain',
          value: 'Example.COM',
          evidence: [{ path: `/workspace/${evRel}`, label: 'seed' }],
        },
      });
      expect(asset.created).toBe(true);

      const svc = await service.reportService({
        userId,
        sessionId,
        workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          protocol: 'https',
          port: 443,
          product: 'nginx',
          evidence: [{ path: `/workspace/${evRel}` }],
        },
      });
      expect(typeof svc.serviceId).toBe('string');

      const endpointNote = await service.reportNote({
        userId,
        sessionId,
        workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'http.endpoint',
          title: 'Home',
          data: {
            url: 'https://example.com/',
            method: 'GET',
            statusCode: 200,
            title: 'Home',
          },
          evidence: [{ path: `/workspace/${evRel}` }],
        },
      });
      expect(typeof endpointNote.noteId).toBe('string');

      const finding1 = await service.reportFinding({
        userId,
        sessionId,
        workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          title: 'Missing security headers',
          severity: 'low',
          summary: 'Response is missing recommended security headers.',
          ...findingContractFields,
          remediation: 'Add standard security headers.',
          confidence: 0.82,
          cvss: {
            attackVector: 'N',
            attackComplexity: 'L',
            privilegesRequired: 'N',
            userInteraction: 'N',
            scope: 'U',
            confidentiality: 'H',
            integrity: 'H',
            availability: 'H',
          },
          cweIds: ['CWE-79'],
          cveIds: ['CVE-2024-1234'],
          endpointRef: endpointNote.noteId,
          serviceRef: svc.serviceId,
          evidence: [{ path: `/workspace/${evRel}`, label: 'httpx', excerpt: 'HTTP/1.1 200 OK' }],
        },
      });
      expect(finding1.created).toBe(true);
      expect(typeof finding1.dedupeKey).toBe('string');

      const finding2 = await service.reportFinding({
        userId,
        sessionId,
        workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          title: 'Missing security headers',
          severity: 'low',
          summary: 'Response is missing recommended security headers.',
          ...findingContractFields,
          evidence: [{ path: `/workspace/${evRel}` }],
        },
      });
      expect(finding2.created).toBe(true);
      expect(finding2.dedupeKey).not.toBe(finding1.dedupeKey);
      const [findingRow] = await db
        .select()
        .from(findingsTable)
        .where(eq(findingsTable.id, finding1.findingId))
        .limit(1);
      expect(findingRow).toBeDefined();
      expect(findingRow?.cvssVector).toBe('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H');
      expect(Number(findingRow?.cvssScore ?? 0)).toBeCloseTo(9.8, 1);
      expect(Number(findingRow?.confidenceScore ?? 0)).toBeCloseTo(0.82, 2);
      expect(findingRow?.cweId).toBe('CWE-79');
      expect(findingRow?.cveId).toBe('CVE-2024-1234');
      expect(findingRow?.cweIds ?? []).toContain('CWE-79');
      expect(findingRow?.cveIds ?? []).toContain('CVE-2024-1234');
      expect(findingRow?.owaspCategory).toBe('A03:2021-Injection');

      const inv = await service.queryInventory({
        userId,
        context,
        input: { assetKind: 'domain', includeServices: true, includeEndpoints: true },
      });
      expect(inv.totalCount).toBeGreaterThanOrEqual(1);
      const invAsset = inv.assets.find((a: any) => a.value === 'example.com') as any;
      expect(invAsset).toBeDefined();
      expect(invAsset?.services?.length ?? 0).toBeGreaterThanOrEqual(1);
      expect(invAsset?.endpoints?.length ?? 0).toBeGreaterThanOrEqual(1);

      const found = await service.queryFindings({
        userId,
        context,
        input: { assetRef: { kind: 'domain', value: 'example.com' }, status: 'all', severity: 'all' },
      });
      expect(found.findings.length).toBeGreaterThanOrEqual(1);
      expect(found.findings.some((f) => f.title === 'Missing security headers')).toBe(true);

      const assetRows = await db
        .select()
        .from(assetsTable)
        .where(and(eq(assetsTable.userId, userId), eq(assetsTable.kind, 'domain'), eq(assetsTable.value, 'example.com')));
      expect(assetRows).toHaveLength(1);

      const evidenceRows = await db
        .select()
        .from(findingEvidenceTable)
        .where(eq(findingEvidenceTable.userId, userId));
      expect(evidenceRows.length).toBeGreaterThanOrEqual(1);
      expect(evidenceRows.every((row: any) => row.sessionId === sessionId)).toBe(true);

      const obsRows = await db
        .select()
        .from(assetObservationsTable)
        .where(and(eq(assetObservationsTable.userId, userId), eq(assetObservationsTable.sessionId, sessionId)));
      expect(obsRows.length).toBeGreaterThanOrEqual(1);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  itMaybe('report_finding persists excerpt-only evidence when file is missing', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, workspaceDir, context, db, cleanup } = fixture;
    try {
      const result = await service.reportFinding({
        userId,
        sessionId,
        workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          title: 'Missing file but excerpt exists',
          severity: 'medium',
          summary: 'Finding should still persist with excerpt-only evidence.',
          ...findingContractFields,
          evidence: [
            {
              path: '/workspace/.artifacts/missing-evidence.txt',
              label: 'stdout',
              excerpt: 'nmap output snippet',
            },
          ],
        },
      });
      expect(result.created).toBe(true);

      const [findingRow] = await db
        .select()
        .from(findingsTable)
        .where(eq(findingsTable.id, result.findingId))
        .limit(1);
      expect(findingRow?.state).toBe('potential');

      const evidenceRows = await db
        .select()
        .from(findingEvidenceTable)
        .where(eq(findingEvidenceTable.findingId, result.findingId));
      expect(evidenceRows).toHaveLength(1);
      expect(evidenceRows[0]?.fileMissing).toBe(true);
      expect(evidenceRows[0]?.excerpt).toBe('nmap output snippet');
      expect(evidenceRows[0]?.path).toBe('.artifacts/missing-evidence.txt');
    } finally {
      await cleanup();
    }
  });

  itMaybe('report_finding persists structured HTTP evidence and code locations', async () => {
    const fixture = await createSecurityOpsFixture();
    const { db, userId, sessionId, workspaceDir, context, writeArtifact, cleanup } = fixture;
    const service = new SecurityOpsToolService({
      db,
    });

    try {
      const artifactPath = await writeArtifact('.artifacts/http-proof.txt', 'captured exchange');
      const workspaceCodePath = await writeArtifact('src/local-handler.ts', 'return input;');
      const oversizedBody = 'A'.repeat(17_500);

      const result = await service.reportFinding({
        userId,
        sessionId,
        workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          title: 'Structured proof finding',
          severity: 'high',
          summary: 'Structured HTTP evidence should persist alongside artifact evidence.',
          ...findingContractFields,
          evidence: [
            { path: artifactPath, excerpt: 'captured exchange' },
            {
              kind: 'http_exchange',
              label: 'Exploit request',
              source: 'browser',
              durationMs: 128,
              request: {
                method: 'post',
                url: 'https://example.com/login',
                headers: [
                  { name: 'Authorization', value: 'Bearer secret-token' },
                  { name: 'Accept', value: 'application/json' },
                ],
                body: oversizedBody,
              },
              response: {
                statusCode: 302,
                headers: [
                  { name: 'Set-Cookie', value: 'session=top-secret' },
                  { name: 'Location', value: '/dashboard' },
                ],
                body: 'Redirected',
              },
            },
          ],
          codeLocations: [
            {
              pathKind: 'workspace',
              repository: null,
              filePath: workspaceCodePath,
              startLine: 1,
              endLine: 1,
              label: 'Local reproduction',
              fixBefore: 'return input;',
              fixAfter: 'return sanitize(input);',
            },
          ],
        },
      });
      expect(result.created).toBe(true);

      const [findingRow] = await db
        .select()
        .from(findingsTable)
        .where(eq(findingsTable.id, result.findingId))
        .limit(1);
      expect(findingRow?.state).toBe('potential');
      expect(Array.isArray(findingRow?.codeLocations)).toBe(true);
      expect(findingRow?.codeLocations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pathKind: 'workspace',
            repository: null,
            filePath: 'src/local-handler.ts',
          }),
        ]),
      );

      const promoted = await service.promoteFinding({
        userId,
        context,
        input: {
          findingId: result.findingId,
          rationale: 'Structured HTTP evidence and code locations satisfy the reportable gate.',
        },
      });
      expect(promoted.state).toBe('verifying');

      const validated = await service.submitValidationOutcome({
        userId,
        sessionId,
        workspaceDir,
        context,
        input: {
          findingId: result.findingId,
          outcome: 'validated',
          reason: 'Validator reproduced the structured HTTP evidence.',
          proof: {
            claim: 'Structured HTTP evidence demonstrates the issue.',
            evidenceIds: [artifactPath, 'Exploit request'],
            replayAttempted: false,
          },
        },
      });
      expect(validated.state).toBe('confirmed');

      const evidenceRows = await db
        .select()
        .from(findingEvidenceTable)
        .where(eq(findingEvidenceTable.findingId, result.findingId));
      expect(evidenceRows).toHaveLength(2);

      const artifactEvidence = evidenceRows.find((row: any) => row.kind === 'artifact');
      expect(artifactEvidence?.path).toBe('.artifacts/http-proof.txt');
      expect(artifactEvidence?.displayPath).toBe('.artifacts/http-proof.txt');

      const structuredEvidence = evidenceRows.find((row: any) => row.kind === 'http_exchange');
      expect(structuredEvidence?.path).toMatch(/^http:/);
      expect(structuredEvidence?.displayPath).toBe('POST https://example.com/login');
      expect(structuredEvidence?.data).toMatchObject({
        source: 'browser',
        durationMs: 128,
        request: {
          method: 'POST',
          url: 'https://example.com/login',
        },
        response: {
          statusCode: 302,
        },
      });
      expect(structuredEvidence?.data?.request?.headers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Authorization', value: '[REDACTED]', redacted: true }),
          expect.objectContaining({ name: 'Accept', value: 'application/json' }),
        ]),
      );
      expect(structuredEvidence?.data?.response?.headers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Set-Cookie', value: '[REDACTED]', redacted: true }),
          expect.objectContaining({ name: 'Location', value: '/dashboard' }),
        ]),
      );
      expect(structuredEvidence?.data?.request?.body?.truncated).toBe(true);
      expect(Buffer.byteLength(structuredEvidence?.data?.request?.body?.text ?? '', 'utf8')).toBeLessThanOrEqual(16 * 1024);
    } finally {
      await cleanup();
    }
  });

  itMaybe('report_finding dedupes structured evidence and code locations on validatesFindingId', async () => {
    const fixture = await createSecurityOpsFixture();
    const { db, userId, sessionId, workspaceDir, context, writeArtifact, cleanup } = fixture;
    const service = new SecurityOpsToolService({
      db,
    });

    try {
      const firstCodePath = await writeArtifact('src/first-handler.ts', 'return input;');
      const firstCodeLocation = {
        pathKind: 'workspace' as const,
        repository: null,
        filePath: firstCodePath,
        startLine: 1,
        endLine: 1,
        label: 'First handler',
        fixBefore: 'return input;',
        fixAfter: 'return sanitize(input);',
      };
      const first = await service.reportFinding({
        userId,
        sessionId,
        workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          title: 'Validation merge finding',
          severity: 'high',
          summary: 'Initial finding payload.',
          ...findingContractFields,
          evidence: [
            {
              kind: 'http_exchange',
              label: 'Primary proof',
              request: { method: 'GET', url: 'https://example.com/admin' },
              response: { statusCode: 200, body: 'ok' },
            },
          ],
          codeLocations: [firstCodeLocation],
        },
      });
      expect(first.created).toBe(true);

      const workspaceCodePath = await writeArtifact('src/second-handler.ts', 'return raw;');
      const second = await service.reportFinding({
        userId,
        sessionId,
        workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          title: 'Validation merge follow-up',
          severity: 'high',
          summary: 'Follow-up validation should merge into the same finding.',
          ...findingContractFields,
          validatesFindingId: first.findingId,
          evidence: [
            {
              kind: 'http_exchange',
              label: 'Primary proof',
              request: { method: 'GET', url: 'https://example.com/admin' },
              response: { statusCode: 200, body: 'ok' },
            },
            {
              kind: 'http_exchange',
              label: 'Secondary proof',
              request: { method: 'POST', url: 'https://example.com/admin/reset' },
              response: { statusCode: 403, body: 'blocked' },
            },
          ],
          codeLocations: [
            firstCodeLocation,
            {
              pathKind: 'workspace',
              repository: null,
              filePath: workspaceCodePath,
              startLine: 1,
              endLine: 1,
              label: 'Secondary handler',
              fixBefore: 'return raw;',
              fixAfter: 'return scrub(raw);',
            },
          ],
        },
      });
      expect(second.created).toBe(false);
      expect(second.findingId).toBe(first.findingId);

      const evidenceRows = await db
        .select()
        .from(findingEvidenceTable)
        .where(eq(findingEvidenceTable.findingId, first.findingId));
      expect(evidenceRows).toHaveLength(2);

      const [findingRow] = await db
        .select()
        .from(findingsTable)
        .where(eq(findingsTable.id, first.findingId))
        .limit(1);
      expect(findingRow?.state).toBe('potential');
      expect(findingRow?.codeLocations).toHaveLength(2);

      const promoted = await service.promoteFinding({
        userId,
        context,
        input: {
          findingId: first.findingId,
          rationale: 'Merged structured HTTP evidence satisfies the reportable gate.',
        },
      });
      expect(promoted.state).toBe('verifying');

      const validated = await service.submitValidationOutcome({
        userId,
        sessionId,
        workspaceDir,
        context,
        input: {
          findingId: first.findingId,
          outcome: 'validated',
          reason: 'Validator reproduced merged structured HTTP evidence.',
          proof: {
            claim: 'Merged structured HTTP evidence demonstrates the issue.',
            evidenceIds: ['Primary proof', 'Secondary proof'],
            replayAttempted: false,
          },
        },
      });
      expect(validated.state).toBe('confirmed');
    } finally {
      await cleanup();
    }
  });

  itMaybe('report_finding rejects repository code locations for unlinked repositories', async () => {
    const fixture = await createSecurityOpsFixture();
    const { db, userId, sessionId, workspaceDir, context, writeArtifact, cleanup } = fixture;
    const service = new SecurityOpsToolService({
      db,
    });

    try {
      const evidencePath = await writeArtifact('.artifacts/repo-validation.txt', 'repo validation');

      await expect(
        service.reportFinding({
          userId,
          sessionId,
          workspaceDir,
          context,
          input: {
            assetRef: { kind: 'domain', value: 'example.com' },
            title: 'Unlinked repository code location',
            severity: 'medium',
            summary: 'Repository validation should reject unlinked repositories.',
            ...findingContractFields,
            evidence: [{ path: evidencePath, excerpt: 'repo validation' }],
            codeLocations: [
              {
                pathKind: 'repository',
                repository: 'acme/unknown',
                ref: 'main',
                filePath: 'src/auth/login.ts',
                startLine: 5,
                endLine: 8,
                label: 'Auth handler',
                fixBefore: 'return input;',
                fixAfter: 'return sanitize(input);',
              },
            ],
          },
        }),
      ).rejects.toThrow('not connected to this scope');
    } finally {
      await cleanup();
    }
  });

  itMaybe('report_finding stores and updates confidence score', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, context, writeArtifact, db, cleanup } = fixture;
    try {
      const evidencePath = await writeArtifact('.artifacts/confidence.txt', 'confidence evidence');

      const first = await service.reportFinding({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          title: 'Confidence test finding',
          severity: 'medium',
          summary: 'Initial confidence should be saved.',
          ...findingContractFields,
          confidence: 0.6,
          evidence: [{ path: evidencePath, excerpt: 'initial signal' }],
        },
      });
      expect(first.created).toBe(true);

      const second = await service.reportFinding({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          title: 'Confidence test finding',
          severity: 'medium',
          summary: 'Confidence should update on dedupe hit.',
          ...findingContractFields,
          confidence: 0.9,
          evidence: [{ path: evidencePath, excerpt: 'confirmed signal' }],
        },
      });
      expect(second.created).toBe(false);

      const [findingRow] = await db
        .select()
        .from(findingsTable)
        .where(eq(findingsTable.id, first.findingId))
        .limit(1);
      expect(Number(findingRow?.confidenceScore ?? 0)).toBeCloseTo(0.9, 2);
    } finally {
      await cleanup();
    }
  });

  itMaybe('report_finding rejects only findings below the 0.3 theoretical floor', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, workspaceDir, context, writeArtifact, cleanup } = fixture;
    try {
      const evidencePath = await writeArtifact('.artifacts/low-confidence.txt', 'theoretical evidence');
      await expect(
        service.reportFinding({
          userId,
          sessionId,
          workspaceDir,
          context,
          input: {
            assetRef: { kind: 'domain', value: 'example.com' },
            title: 'Theoretical finding',
            severity: 'medium',
            summary: 'Low confidence theoretical finding should be rejected.',
            ...findingContractFields,
            confidence: 0.2,
            evidence: [{ path: evidencePath, excerpt: 'theoretical signal' }],
          },
        }),
      ).rejects.toThrow('below the theoretical floor');
    } finally {
      await cleanup();
    }
  });

  itMaybe('report_finding skips missing evidence entries that have no excerpt', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, workspaceDir, context, db, cleanup } = fixture;
    try {
      const result = await service.reportFinding({
        userId,
        sessionId,
        workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          title: 'Missing file without excerpt',
          severity: 'low',
          summary: 'Finding should persist and skip evidence row.',
          ...findingContractFields,
          evidence: [{ path: '/workspace/.artifacts/missing-no-excerpt.txt' }],
        },
      });
      expect(result.created).toBe(true);

      const evidenceRows = await db
        .select()
        .from(findingEvidenceTable)
        .where(eq(findingEvidenceTable.findingId, result.findingId));
      expect(evidenceRows).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  itMaybe('report_finding stays record-only when durable proof is later attached until validator confirms', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, context, writeArtifact, db, cleanup } = fixture;
    try {
      const first = await service.reportFinding({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          title: 'Validation upgrade candidate',
          severity: 'medium',
          summary: 'Initial report only has excerpt evidence.',
          ...findingContractFields,
          evidence: [{ path: '/workspace/.artifacts/missing-upgrade.txt', excerpt: 'weak signal' }],
        },
      });
      expect(first.created).toBe(true);

      const [initialRow] = await db
        .select()
        .from(findingsTable)
        .where(eq(findingsTable.id, first.findingId))
        .limit(1);
      expect(initialRow?.state).toBe('potential');

      const evidencePath = await writeArtifact('.artifacts/upgrade-proof.txt', 'durable proof');
      const second = await service.reportFinding({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          title: 'Validation upgrade candidate',
          severity: 'medium',
          summary: 'Follow-up report includes durable proof.',
          ...findingContractFields,
          evidence: [{ path: evidencePath, excerpt: 'durable proof' }],
        },
      });
      expect(second.created).toBe(false);

      const [findingRow] = await db
        .select()
        .from(findingsTable)
        .where(eq(findingsTable.id, first.findingId))
        .limit(1);
      expect(findingRow?.state).toBe('potential');

      const promoted = await service.promoteFinding({
        userId,
        context,
        input: {
          findingId: first.findingId,
          rationale: 'Durable follow-up proof satisfies the reportable gate.',
        },
      });
      expect(promoted.state).toBe('verifying');

      const validated = await service.submitValidationOutcome({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          findingId: first.findingId,
          outcome: 'validated',
          reason: 'Validator reproduced the durable follow-up proof.',
          evidence: [{ path: evidencePath }],
          proof: {
            claim: 'Durable follow-up proof demonstrates the issue.',
            evidenceIds: [evidencePath],
            replayAttempted: false,
          },
        },
      });
      expect(validated.state).toBe('confirmed');
    } finally {
      await cleanup();
    }
  });

  itMaybe('report_finding keeps file-backed evidence behavior unchanged when file exists', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, context, writeArtifact, db, cleanup } = fixture;
    try {
      const evidencePath = await writeArtifact('.artifacts/existing-proof.txt', 'proof content');

      const result = await service.reportFinding({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          title: 'Existing file evidence',
          severity: 'low',
          summary: 'Evidence file exists and should be validated.',
          ...findingContractFields,
          evidence: [{ path: evidencePath, excerpt: 'proof content' }],
        },
      });
      expect(result.created).toBe(true);

      const evidenceRows = await db
        .select()
        .from(findingEvidenceTable)
        .where(eq(findingEvidenceTable.findingId, result.findingId));
      const [findingRow] = await db
        .select()
        .from(findingsTable)
        .where(eq(findingsTable.id, result.findingId))
        .limit(1);
      expect(findingRow?.state).toBe('potential');
      expect(evidenceRows).toHaveLength(1);
      expect(evidenceRows[0]?.fileMissing).toBe(false);
      expect(evidenceRows[0]?.path).toBe('.artifacts/existing-proof.txt');

      const promoted = await service.promoteFinding({
        userId,
        context,
        input: {
          findingId: result.findingId,
          rationale: 'File-backed evidence satisfies the reportable gate.',
        },
      });
      expect(promoted.state).toBe('verifying');

      const validated = await service.submitValidationOutcome({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          findingId: result.findingId,
          outcome: 'validated',
          reason: 'Validator reproduced the file-backed evidence.',
          evidence: [{ path: evidencePath }],
          proof: {
            claim: 'File-backed evidence demonstrates the issue.',
            evidenceIds: [evidencePath],
            replayAttempted: false,
          },
        },
      });
      expect(validated.state).toBe('confirmed');
    } finally {
      await cleanup();
    }
  });

  itMaybe('report_finding keeps the Risk confirmed when only missing-file evidence is reported', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, context, writeArtifact, db, cleanup } = fixture;
    try {
      const validEvidencePath = await writeArtifact('.artifacts/valid-evidence.txt', 'confirmed');

      const first = await service.reportFinding({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          title: 'Validation downgrade candidate',
          severity: 'high',
          summary: 'First report with valid evidence.',
          ...findingContractFields,
          evidence: [{ path: validEvidencePath, excerpt: 'confirmed' }],
        },
      });
      expect(first.created).toBe(true);

      await db
        .update(findingsTable)
        .set({ state: 'confirmed' })
        .where(eq(findingsTable.id, first.findingId));

      const second = await service.reportFinding({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          title: 'Validation downgrade candidate',
          severity: 'high',
          summary: 'Second report with missing evidence file.',
          ...findingContractFields,
          evidence: [
            {
              path: '/workspace/.artifacts/missing-recheck.txt',
              excerpt: 'recheck output',
            },
          ],
        },
      });
      expect(second.created).toBe(false);

      const [findingRow] = await db
        .select()
        .from(findingsTable)
        .where(eq(findingsTable.id, first.findingId))
        .limit(1);
      expect(findingRow?.state).toBe('confirmed');
    } finally {
      await cleanup();
    }
  });

  itMaybe('blocks final closeout until validated findings have canonical report fields', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, workspaceDir, context, writeArtifact, cleanup } = fixture;
    try {
      const evidencePath = await writeArtifact('.artifacts/idor-proof.txt', 'GET /orders/1 and /orders/2 returned cross-account order data');

      const finding = await service.reportFinding({
        userId,
        sessionId,
        workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          title: 'IDOR on order detail endpoint',
          severity: 'high',
          summary: 'Order detail responses vary by orderId without ownership enforcement.',
          evidence: [{ path: evidencePath, excerpt: 'cross-account order data' }],
        },
      });
      expect(finding.reportCompleteness.missingReportFields).toEqual([
        'businessImpact',
        'technicalAnalysis',
        'pocDescription',
        'assumptions',
        'remediation',
      ]);

      const validated = await service.submitValidationOutcome({
        userId,
        sessionId,
        workspaceDir,
        context,
        input: {
          findingId: finding.findingId,
          outcome: 'validated',
          reason: 'Validator reproduced the cross-account order data response.',
          evidence: [{ path: evidencePath }],
          proof: {
            claim: 'Order detail endpoint returns cross-account order data.',
            evidenceIds: [evidencePath],
            replayAttempted: false,
          },
        },
      });
      expect(validated.state).toBe('confirmed');
      expect(validated.reportCompleteness.canFinalizeReportable).toBe(false);

      const blockedPreflight = await service.reportFinalizerPreflight({
        userId,
        sessionId,
        workspaceDir,
        context,
        input: {},
        reportedFindingIds: [finding.findingId],
        plan: [{ id: 'task-1', title: 'Validate IDOR', status: 'completed' }],
      });
      expect(blockedPreflight.canFinalizeFinal).toBe(false);
      expect(blockedPreflight.requiredMode).toBe('interim');
      expect(blockedPreflight.missingReportFieldBlockers[0]?.missingReportFields).toEqual([
        'businessImpact',
        'technicalAnalysis',
        'pocDescription',
        'assumptions',
        'remediation',
      ]);

      await expect(
        service.finalizeRunArtifacts({
          userId,
          sessionId,
          workspaceDir,
          context,
          input: { mode: 'final' },
          reportedFindingIds: [finding.findingId],
          plan: [{ id: 'task-1', title: 'Validate IDOR', status: 'completed' }],
        }),
      ).rejects.toThrow(/missing report fields/);

      const reportingContext = { ...context, activePhaseKey: 'reporting' };
      await expect(
        service.reportFinding({
          userId,
          sessionId,
          workspaceDir,
          context: reportingContext,
          input: {
            assetRef: { kind: 'domain', value: 'example.com' },
            title: 'IDOR on order detail endpoint',
            severity: 'high',
            summary: 'Reporting must repair the validated canonical row instead of creating a new finding.',
            businessImpact: 'An authenticated user can access another customer order.',
            technicalAnalysis: 'The handler trusts orderId before enforcing ownership.',
            pocDescription: 'Request two order IDs and observe cross-account data.',
            assumptions: 'The attacker has a valid account.',
            remediation: 'Enforce server-side ownership checks before returning order records.',
            evidence: [{ path: evidencePath, excerpt: 'cross-account order data' }],
          },
        }),
      ).rejects.toThrow(/repair-only in the reporting phase/);

      const repaired = await service.reportFinding({
        userId,
        sessionId,
        workspaceDir,
        context: reportingContext,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          title: 'IDOR on order detail endpoint',
          severity: 'high',
          summary: 'Order detail responses vary by orderId without ownership enforcement.',
          businessImpact: 'An authenticated user can access another customer order, exposing private order data and account activity.',
          technicalAnalysis: 'The order detail handler trusts the orderId path parameter and returns the record before checking that it belongs to the authenticated principal.',
          pocDescription: 'Request GET /orders/1 and GET /orders/2 from the same account; the second response returns another account order instead of 403.',
          assumptions: 'The attacker has any valid account and can guess or observe sequential order identifiers.',
          remediation: 'Enforce server-side ownership checks before returning order records, derive scope from the authenticated principal, and add regression tests that assert cross-account order reads return 403.',
          evidence: [{ path: evidencePath, excerpt: 'cross-account order data' }],
          validatesFindingId: finding.findingId,
        },
      });
      expect(repaired.created).toBe(false);
      expect(repaired.reportCompleteness.missingReportFields).toEqual([]);

      const readyPreflight = await service.reportFinalizerPreflight({
        userId,
        sessionId,
        workspaceDir,
        context,
        input: {},
        reportedFindingIds: [finding.findingId],
        plan: [{ id: 'task-1', title: 'Validate IDOR', status: 'completed' }],
      });
      expect(readyPreflight.canFinalizeFinal).toBe(true);

      await service.reportNote({
        userId,
        sessionId,
        workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'run.digest',
          title: 'Run digest',
          data: {
            goal: 'Assess access control on example.com.',
            outcome: 'completed',
            completed_tasks: ['Validate IDOR'],
          },
          evidence: [],
        },
      });

      await fs.writeFile(
        path.join(workspaceDir, 'summary.md'),
        [
          '# Run Summary',
          '',
          'Outcome: completed. One high-severity IDOR finding was validated with durable evidence and complete canonical report fields.',
        ].join('\n'),
      );
      await fs.writeFile(
        path.join(workspaceDir, 'report.md'),
        [
          '# Security Assessment Report',
          '',
          '## Finding: IDOR on order detail endpoint',
          'Finding id: ' + finding.findingId,
          '',
          'The order endpoint returned cross-account order data when the orderId path parameter was changed. The issue was validated with durable evidence and canonical remediation guidance.',
          '',
          '## Remediation',
          'Enforce server-side ownership checks before returning order records, derive scope from the authenticated principal, and add regression tests that assert cross-account order reads return 403.',
        ].join('\n'),
      );

      const finalized = await service.finalizeRunArtifacts({
        userId,
        sessionId,
        workspaceDir,
        context,
        input: { mode: 'final' },
        reportedFindingIds: [finding.findingId],
        plan: [{ id: 'task-1', title: 'Validate IDOR', status: 'completed' }],
      });
      expect(finalized.mode).toBe('final');
      expect(finalized.reportableFindingCount).toBe(1);
    } finally {
      await cleanup();
    }
  });

  itMaybe('report_service normalizes to subdomain asset when hostname is provided', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, context, writeArtifact, db, cleanup } = fixture;
    try {
      const evidencePath = await writeArtifact('.artifacts/svc.txt', 'service evidence');

      const result = await service.reportService({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          hostname: 'api.example.com',
          protocol: 'https',
          port: 443,
          serviceName: 'https',
          evidence: [{ path: evidencePath }],
        },
      });
      expect(result.created).toBe(true);

      const [serviceRow] = await db
        .select()
        .from(inventoryServicesTable)
        .where(eq(inventoryServicesTable.id, result.serviceId))
        .limit(1);
      expect(serviceRow).toBeDefined();

      const [assetRow] = await db
        .select()
        .from(assetsTable)
        .where(eq(assetsTable.id, serviceRow!.assetId))
        .limit(1);
      expect(assetRow?.value).toBe('api.example.com');
    } finally {
      await cleanup();
    }
  });

  itMaybe('report_note(http.endpoint) normalizes to URL hostname asset when it is a subdomain', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, context, writeArtifact, db, cleanup } = fixture;
    try {
      const evidencePath = await writeArtifact('.artifacts/ep.txt', 'endpoint evidence');

      const result = await service.reportNote({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'http.endpoint',
          data: {
            url: 'https://grafana.example.com/login',
            method: 'GET',
          },
          evidence: [{ path: evidencePath }],
        },
      });
      expect(result.created).toBe(true);

      const [endpointRow] = await db
        .select()
        .from(inventoryNotesTable)
        .where(eq(inventoryNotesTable.id, result.noteId))
        .limit(1);
      expect(endpointRow).toBeDefined();
      expect(endpointRow?.ntype).toBe('http.endpoint');

      const [assetRow] = await db
        .select()
        .from(assetsTable)
        .where(eq(assetsTable.id, endpointRow!.assetId))
        .limit(1);
      expect(assetRow?.value).toBe('grafana.example.com');
    } finally {
      await cleanup();
    }
  });

  itMaybe('report_service keeps root asset attribution when hostname matches assetRef', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, context, writeArtifact, db, cleanup } = fixture;
    try {
      const evidencePath = await writeArtifact('.artifacts/root-svc.txt', 'service evidence');

      const result = await service.reportService({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          hostname: 'example.com',
          protocol: 'https',
          port: 443,
          evidence: [{ path: evidencePath }],
        },
      });
      expect(result.created).toBe(true);

      const [serviceRow] = await db
        .select()
        .from(inventoryServicesTable)
        .where(eq(inventoryServicesTable.id, result.serviceId))
        .limit(1);
      expect(serviceRow).toBeDefined();

      const [assetRow] = await db
        .select()
        .from(assetsTable)
        .where(eq(assetsTable.id, serviceRow!.assetId))
        .limit(1);
      expect(assetRow?.value).toBe('example.com');
    } finally {
      await cleanup();
    }
  });

  itMaybe('report_note(dns.subdomain) and report_note(tech.fingerprint) persist observations via inventory notes', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, context, writeArtifact, cleanup } = fixture;
    try {
      const evidencePath = await writeArtifact('.artifacts/notes-observations.txt', 'observation evidence');

      const subdomain = await service.reportNote({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'dns.subdomain',
          data: {
            hostname: 'api.example.com',
            resolvedIps: ['10.0.0.10'],
          },
          evidence: [{ path: evidencePath }],
        },
      });
      expect(subdomain.created).toBe(true);

      const tech = await service.reportNote({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'tech.fingerprint',
          data: {
            product: 'nginx',
            version: '1.25.0',
            category: 'web-server',
            confidence: 0.9,
          },
          confidence: 0.9,
          evidence: [{ path: evidencePath }],
        },
      });
      expect(tech.created).toBe(true);

      const notes = await service.queryNotes({
        userId,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'dns.',
          limit: 50,
        },
      });
      expect(notes.notes.some((note) => note.ntype === 'dns.subdomain')).toBe(true);

      const techNotes = await service.queryNotes({
        userId,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'tech.fingerprint',
          limit: 50,
        },
      });
      expect(techNotes.notes.some((note) => note.ntype === 'tech.fingerprint')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  itMaybe('ingest_scan_artifact(subfinder) persists candidate subdomain observations and stays idempotent', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, context, writeArtifact, db, cleanup } = fixture;
    try {
      const artifactPath = await writeArtifact(
        '.artifacts/subfinder.jsonl',
        ['{"host":"api.example.com"}', '{"host":"admin.example.com"}'].join('\n'),
      );

      const first = await service.ingestScanArtifact({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          parser: 'subfinder',
          artifactPath,
          rootAssetRef: { kind: 'domain', value: 'example.com' },
        },
      });
      expect(first.subdomainNotesCreated).toBe(2);
      expect(first.subdomainNotesTouched).toBe(0);

      const second = await service.ingestScanArtifact({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          parser: 'subfinder',
          artifactPath,
          rootAssetRef: { kind: 'domain', value: 'example.com' },
        },
      });
      expect(second.subdomainNotesCreated).toBe(0);
      expect(second.subdomainNotesTouched).toBe(2);

      const assetRows = await db
        .select()
        .from(assetsTable)
        .where(and(eq(assetsTable.userId, userId), eq(assetsTable.scopeId, context.scopeId)));
      const rootAsset = assetRows.find((row: any) => row.value === 'example.com');
      expect(rootAsset).toBeTruthy();
      expect(assetRows.some((row: any) => row.value === 'api.example.com')).toBe(false);
      expect(assetRows.some((row: any) => row.value === 'admin.example.com')).toBe(false);

      const noteRows = await db
        .select()
        .from(inventoryNotesTable)
        .where(and(eq(inventoryNotesTable.assetId, rootAsset!.id), eq(inventoryNotesTable.ntype, 'dns.subdomain')));
      const hostnames = noteRows
        .map((row: any) => (typeof row.data?.hostname === 'string' ? row.data.hostname : undefined))
        .filter(Boolean)
        .sort();
      expect(hostnames).toEqual(['admin.example.com', 'api.example.com']);
    } finally {
      await cleanup();
    }
  });

  itMaybe('ingest_scan_artifact(naabu) persists open services from host:port output', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, context, writeArtifact, db, cleanup } = fixture;
    try {
      const artifactPath = await writeArtifact(
        '.artifacts/naabu.txt',
        ['api.example.com:443', 'api.example.com:8443'].join('\n'),
      );

      const result = await service.ingestScanArtifact({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          parser: 'naabu',
          artifactPath,
        },
      });

      expect(result.assetsCreated).toBe(1);
      expect(result.servicesCreated).toBe(2);

      const serviceRows = await db
        .select()
        .from(inventoryServicesTable)
        .where(eq(inventoryServicesTable.userId, userId));
      expect(
        serviceRows
          .map((row: any) => `${row.protocol}:${row.port}`)
          .sort(),
      ).toEqual(expect.arrayContaining(['tcp:443', 'tcp:8443']));
    } finally {
      await cleanup();
    }
  });

  itMaybe('ingest_scan_artifact(httpx) persists asset, service, endpoint, and tech inventory rows', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, context, writeArtifact, db, cleanup } = fixture;
    try {
      const artifactPath = await writeArtifact(
        '.artifacts/httpx.jsonl',
        [
          JSON.stringify({
            url: 'https://api.example.com/login',
            port: 443,
            status_code: 200,
            title: 'Login',
            tech: ['React'],
            webserver: 'nginx/1.25.3',
          }),
        ].join('\n'),
      );

      const result = await service.ingestScanArtifact({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          parser: 'httpx',
          artifactPath,
        },
      });

      expect(result.assetsCreated).toBe(1);
      expect(result.servicesCreated).toBe(1);
      expect(result.endpointNotesCreated).toBe(1);
      expect(result.techNotesCreated).toBeGreaterThanOrEqual(1);

      const [assetRow] = await db
        .select()
        .from(assetsTable)
        .where(and(eq(assetsTable.userId, userId), eq(assetsTable.value, 'api.example.com')))
        .limit(1);
      expect(assetRow).toBeDefined();

      const serviceRows = await db
        .select()
        .from(inventoryServicesTable)
        .where(eq(inventoryServicesTable.userId, userId));
      expect(serviceRows.some((row: any) => row.protocol === 'https' && row.port === 443)).toBe(true);

      const endpointRows = await db
        .select()
        .from(inventoryNotesTable)
        .where(and(eq(inventoryNotesTable.userId, userId), eq(inventoryNotesTable.ntype, 'http.endpoint')));
      expect(endpointRows.some((row: any) => (row.data as any)?.url === 'https://api.example.com/login')).toBe(true);

      const techRows = await db
        .select()
        .from(inventoryNotesTable)
        .where(and(eq(inventoryNotesTable.userId, userId), eq(inventoryNotesTable.ntype, 'tech.fingerprint')));
      expect(
        techRows.some((row: any) => {
          const data = row.data as any;
          return data?.product === 'react' || data?.product === 'nginx';
        }),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  itMaybe('ingest_scan_artifact(httpx) rejects non-JSON artifacts with a rerun hint', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, context, writeArtifact, cleanup } = fixture;
    try {
      const artifactPath = await writeArtifact(
        '.artifacts/httpx.txt',
        'https://api.example.com [200] [Login] [nginx]',
      );

      await expect(
        service.ingestScanArtifact({
          userId,
          sessionId,
          workspaceDir: fixture.workspaceDir,
          context,
          input: {
            parser: 'httpx',
            artifactPath,
          },
        }),
      ).rejects.toThrow(/requires JSONL output\. Rerun httpx with -j or -json/i);
    } finally {
      await cleanup();
    }
  });

  itMaybe('ingest_scan_artifact supports scanner parsers beyond the core discovery trio and stays idempotent', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, context, writeArtifact, db, cleanup } = fixture;
    try {
      const rootAssetRef = { kind: 'domain' as const, value: 'api.example.com' };
      const cases = [
        {
          parser: 'nuclei',
          path: '.artifacts/nuclei.jsonl',
          content: JSON.stringify({
            'template-id': 'cves/2026/test-cve',
            'matched-at': 'https://api.example.com/admin',
            info: {
              name: 'Test exposed admin panel',
              severity: 'high',
              classification: { 'cwe-id': ['CWE-200'], 'cve-id': ['CVE-2026-0001'] },
            },
          }),
          expectFindings: true,
          expectObservations: true,
        },
        {
          parser: 'sqlmap',
          path: '.artifacts/sqlmap.log',
          content: 'Parameter id appears to be vulnerable. sql injection confirmed.',
          expectFindings: true,
          expectObservations: true,
        },
        {
          parser: 'dalfox',
          path: '.artifacts/dalfox.json',
          content: JSON.stringify([
            { target: 'https://api.example.com/search?q=x', type: 'reflected', severity: 'medium', title: 'Reflected XSS' },
          ]),
          expectFindings: true,
          expectObservations: true,
        },
        {
          parser: 'semgrep',
          path: '.artifacts/semgrep.sarif',
          content: JSON.stringify({
            runs: [{
              results: [{
                ruleId: 'javascript.express.security.audit.xss',
                message: { text: 'Unsanitized output' },
                locations: [{
                  physicalLocation: {
                    artifactLocation: { uri: 'src/app.ts' },
                    region: { startLine: 12, endLine: 13 },
                  },
                }],
              }],
            }],
          }),
          expectFindings: true,
          expectObservations: true,
        },
        {
          parser: 'trivy',
          path: '.artifacts/trivy.json',
          content: JSON.stringify({
            Results: [{
              Target: 'package-lock.json',
              Vulnerabilities: [{
                VulnerabilityID: 'CVE-2026-1111',
                Title: 'Vulnerable dependency',
                Severity: 'HIGH',
              }],
            }],
          }),
          expectFindings: true,
          expectObservations: true,
        },
        {
          parser: 'gitleaks',
          path: '.artifacts/gitleaks.json',
          content: JSON.stringify([
            { RuleID: 'generic-api-key', Description: 'API key', File: 'config.js', Secret: 'redacted' },
          ]),
          expectFindings: true,
          expectObservations: true,
        },
        {
          parser: 'trufflehog',
          path: '.artifacts/trufflehog.jsonl',
          content: JSON.stringify({
            DetectorName: 'AWS',
            Raw: 'AKIA...',
            SourceMetadata: { Data: { Git: { file: 'app.py' } } },
          }),
          expectFindings: true,
          expectObservations: true,
        },
        {
          parser: 'nmap',
          path: '.artifacts/nmap.xml',
          content: '<nmaprun><host><status state="up"/><address addr="api.example.com"/><ports><port protocol="tcp" portid="8443"><state state="open"/><service name="https" product="nginx" version="1.25"/></port></ports></host></nmaprun>',
          expectServices: true,
        },
        {
          parser: 'ffuf',
          path: '.artifacts/ffuf.json',
          content: JSON.stringify({ results: [{ url: 'https://api.example.com/admin', status: 200 }] }),
          expectEndpoints: true,
        },
        {
          parser: 'katana',
          path: '.artifacts/katana.jsonl',
          content: JSON.stringify({ url: 'https://api.example.com/static/app.js', method: 'GET' }),
          expectEndpoints: true,
        },
      ] as const;

      for (const testCase of cases) {
        const artifactPath = await writeArtifact(testCase.path, testCase.content);
        const first = await service.ingestScanArtifact({
          userId,
          sessionId,
          workspaceDir: fixture.workspaceDir,
          context,
          input: {
            parser: testCase.parser,
            artifactPath,
            rootAssetRef,
          },
        });
        const second = await service.ingestScanArtifact({
          userId,
          sessionId,
          workspaceDir: fixture.workspaceDir,
          context,
          input: {
            parser: testCase.parser,
            artifactPath,
            rootAssetRef,
          },
        });

        if ('expectFindings' in testCase) {
          expect(first.findingsCreated, `${testCase.parser} findingsCreated`).toBeGreaterThan(0);
          expect(second.findingsCreated, `${testCase.parser} second findingsCreated`).toBe(0);
        }
        if ('expectObservations' in testCase) {
          expect(first.observationsCreated, `${testCase.parser} observationsCreated`).toBeGreaterThan(0);
          expect(second.observationsCreated, `${testCase.parser} second observationsCreated`).toBe(0);
        }
        if ('expectServices' in testCase) {
          expect(first.servicesCreated, `${testCase.parser} servicesCreated`).toBeGreaterThan(0);
          expect(second.servicesCreated, `${testCase.parser} second servicesCreated`).toBe(0);
        }
        if ('expectEndpoints' in testCase) {
          expect(first.endpointNotesCreated, `${testCase.parser} endpointNotesCreated`).toBeGreaterThan(0);
          expect(second.endpointNotesCreated, `${testCase.parser} second endpointNotesCreated`).toBe(0);
        }
      }

      const observationRows = await db
        .select()
        .from(scannerObservationsTable)
        .where(eq(scannerObservationsTable.userId, userId));
      const observationParsers = new Set(observationRows.map((row: any) => row.parser));
      for (const parser of ['nuclei', 'sqlmap', 'dalfox', 'semgrep', 'trivy', 'gitleaks', 'trufflehog']) {
        expect(observationParsers.has(parser), `scanner observation for ${parser}`).toBe(true);
      }

      const findingRows = await db
        .select()
        .from(findingsTable)
        .where(eq(findingsTable.userId, userId));
      expect(findingRows.length).toBeGreaterThanOrEqual(7);

      const endpointRows = await db
        .select()
        .from(inventoryNotesTable)
        .where(and(eq(inventoryNotesTable.userId, userId), eq(inventoryNotesTable.ntype, 'http.endpoint')));
      expect(endpointRows.length).toBeGreaterThanOrEqual(2);
    } finally {
      await cleanup();
    }
  });

  itMaybe('report_note creates, dedupes, and merges note payloads', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, context, writeArtifact, db, cleanup } = fixture;
    try {
      const evidencePath = await writeArtifact('.artifacts/note.txt', 'dns output');

      const first = await service.reportNote({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'dns.a',
          title: 'A record',
          data: { name: 'api.example.com', value: '10.0.0.12' },
          confidence: 0.9,
          evidence: [{ path: evidencePath, excerpt: 'api.example.com A 10.0.0.12' }],
        },
      });
      expect(first.created).toBe(true);

      const second = await service.reportNote({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'dns.a',
          title: 'A record update',
          data: { name: 'api.example.com', value: '10.0.0.12', ttl: 300 },
          confidence: 0.95,
        },
      });
      expect(second.created).toBe(false);
      expect(second.noteId).toBe(first.noteId);

      const [noteRow] = await db
        .select()
        .from(inventoryNotesTable)
        .where(eq(inventoryNotesTable.id, first.noteId))
        .limit(1);
      expect(noteRow).toBeDefined();
      expect((noteRow?.data as any)?.name).toBe('api.example.com');
      expect((noteRow?.data as any)?.value).toBe('10.0.0.12');
      expect((noteRow?.data as any)?.ttl).toBe(300);
      expect(Number(noteRow?.confidence ?? 0)).toBeCloseTo(0.95, 2);
    } finally {
      await cleanup();
    }
  });

  itMaybe('query_inventory keeps broad scan coverage across endpoint churn but invalidates it on service or tech changes', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, context, db, cleanup } = fixture;
    try {
      await service.reportService({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          protocol: 'https',
          port: 443,
          product: 'nginx',
        },
      });

      await service.reportNote({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'http.endpoint',
          title: 'Home',
          data: {
            url: 'https://example.com/',
            method: 'GET',
            statusCode: 200,
            title: 'Home',
          },
        },
      });

      await service.reportNote({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'tech.fingerprint',
          data: {
            product: 'Next.js',
            category: 'framework',
            confidence: 0.9,
          },
          confidence: 0.9,
        },
      });

      const beforeCoverage = await service.queryInventory({
        userId,
        context,
        input: { assetKind: 'domain', includeServices: true, includeEndpoints: true },
      });
      const beforeAsset = beforeCoverage.assets.find((asset: any) => asset.value === 'example.com') as any;
      expect(beforeAsset).toBeDefined();
      expect(beforeAsset.lastScannedAt).toBeNull();
      expect(beforeAsset.needsBroadScan).toBe(true);

      const coverage = await service.reportNote({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'scan.coverage',
          data: {
            family: 'broad-surface',
            status: 'completed',
            profileVersion: 'broad-surface-scan/v1',
            toolset: ['httpx', 'katana', 'ffuf'],
            stats: {
              endpointsDiscovered: 1,
              findingsCreated: 0,
              techsDetected: 1,
            },
          },
        },
      });
      expect(coverage.created).toBe(true);

      const [coverageRow] = await db
        .select()
        .from(inventoryNotesTable)
        .where(eq(inventoryNotesTable.id, coverage.noteId))
        .limit(1);
      expect((coverageRow?.data as any)?.inventoryFingerprint).toEqual(expect.any(String));

      const afterCoverage = await service.queryInventory({
        userId,
        context,
        input: { assetKind: 'domain', includeServices: true, includeEndpoints: true },
      });
      const coveredAsset = afterCoverage.assets.find((asset: any) => asset.value === 'example.com') as any;
      expect(coveredAsset).toBeDefined();
      expect(coveredAsset.lastScannedAt).toEqual(expect.any(String));
      expect(coveredAsset.needsBroadScan).toBe(false);

      const [assetRowAfterCoverage] = await db
        .select()
        .from(assetsTable)
        .where(and(eq(assetsTable.userId, userId), eq(assetsTable.kind, 'domain'), eq(assetsTable.value, 'example.com')))
        .limit(1);
      expect(assetRowAfterCoverage?.lastScannedAt).toBeTruthy();

      await service.reportNote({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'http.endpoint',
          title: 'Admin',
          data: {
            url: 'https://example.com/admin',
            method: 'GET',
            statusCode: 403,
            title: 'Admin',
          },
        },
      });

      const afterChange = await service.queryInventory({
        userId,
        context,
        input: { assetKind: 'domain', includeServices: true, includeEndpoints: true },
      });
      const endpointChangedAsset = afterChange.assets.find((asset: any) => asset.value === 'example.com') as any;
      expect(endpointChangedAsset).toBeDefined();
      expect(endpointChangedAsset.needsBroadScan).toBe(false);

      await service.reportService({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          protocol: 'http',
          port: 80,
          product: 'nginx',
        },
      });

      const afterServiceChange = await service.queryInventory({
        userId,
        context,
        input: { assetKind: 'domain', includeServices: true, includeEndpoints: true },
      });
      const serviceChangedAsset = afterServiceChange.assets.find((asset: any) => asset.value === 'example.com') as any;
      expect(serviceChangedAsset).toBeDefined();
      expect(serviceChangedAsset.needsBroadScan).toBe(true);
    } finally {
      await cleanup();
    }
  });

  itMaybe('query_notes supports ntype prefix filtering', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, context, cleanup } = fixture;
    try {
      await service.reportNote({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'dns.a',
          data: { name: 'app.example.com', value: '10.1.0.1' },
        },
      });
      await service.reportNote({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'http.headers',
          data: { url: 'https://example.com', missing: ['content-security-policy'] },
        },
      });

      const dns = await service.queryNotes({
        userId,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'dns.',
        },
      });
      expect(dns.notes.length).toBeGreaterThanOrEqual(1);
      expect(dns.notes.every((note) => note.ntype.startsWith('dns.'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  itMaybe('query_notes and query_findings reject UUID-like assetRef when kind=ip', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, context, cleanup } = fixture;
    try {
      const uuidLikeValue = '550e8400-e29b-41d4-a716-446655440000';

      await expect(
        service.queryNotes({
          userId,
          context,
          input: {
            assetRef: { kind: 'ip', value: uuidLikeValue },
          },
        }),
      ).rejects.toThrow(/assetRef\.kind=ip requires a valid IP or CIDR/i);

      await expect(
        service.queryFindings({
          userId,
          context,
          input: {
            assetRef: { kind: 'ip', value: uuidLikeValue },
          },
        }),
      ).rejects.toThrow(/assetRef\.kind=ip requires a valid IP or CIDR/i);
    } finally {
      await cleanup();
    }
  });

  itMaybe('report_note enforces known ntype schemas and allows unknown ntypes', async () => {
    const fixture = await createSecurityOpsFixture();
    const { service, userId, sessionId, context, cleanup } = fixture;
    try {
      await expect(
        service.reportNote({
          userId,
          sessionId,
          workspaceDir: fixture.workspaceDir,
          context,
          input: {
            assetRef: { kind: 'domain', value: 'example.com' },
            ntype: 'dns.a',
            data: { value: '10.1.0.1' },
          },
        }),
      ).rejects.toThrow(/report_note validation failed/i);

      await expect(
        service.reportNote({
          userId,
          sessionId,
          workspaceDir: fixture.workspaceDir,
          context,
          input: {
            assetRef: { kind: 'domain', value: 'example.com' },
            ntype: 'http.parameters',
            data: { params: [{ name: 'id' }] },
          },
        }),
      ).rejects.toThrow(/report_note validation failed/i);

      const paramNote = await service.reportNote({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'http.parameters',
          data: {
            url: 'https://example.com/search',
            params: [{ name: 'q', type: 'string', example: 'test' }],
          },
        },
      });
      expect(paramNote.created).toBe(true);

      await expect(
        service.reportNote({
          userId,
          sessionId,
          workspaceDir: fixture.workspaceDir,
          context,
          input: {
            assetRef: { kind: 'domain', value: 'example.com' },
            ntype: 'http.waf',
            data: { version: '1.0' },
          },
        }),
      ).rejects.toThrow(/report_note validation failed/i);

      const wafNote = await service.reportNote({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'http.waf',
          data: { product: 'cloudflare', bypasses: ['header-case-variation'] },
        },
      });
      expect(wafNote.created).toBe(true);

      await expect(
        service.reportNote({
          userId,
          sessionId,
          workspaceDir: fixture.workspaceDir,
          context,
          input: {
            ntype: 'pentest.plan',
            data: { confidence: 0.8 },
          },
        }),
      ).rejects.toThrow(/report_note validation failed/i);

      const planNote = await service.reportNote({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          ntype: 'pentest.plan',
          data: {
            recommended_next_task: 'web-app-scan',
            rationale: 'Endpoints discovered but parameters remain untested',
            priority_targets: ['api.example.com', 'portal.example.com'],
            confidence: 0.9,
            chain: ['web-app-scan', 'vulnerability-assessment'],
          },
        },
      });
      expect(planNote.created).toBe(true);

      const custom = await service.reportNote({
        userId,
        sessionId,
        workspaceDir: fixture.workspaceDir,
        context,
        input: {
          assetRef: { kind: 'domain', value: 'example.com' },
          ntype: 'custom.signal',
          data: { flag: true, payload: { k: 'v' } },
        },
      });
      expect(custom.created).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
