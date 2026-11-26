/**
 * Seed realistic, framework-neutral NullSquare evidence into a scope's compliance evidence library.
 *
 * The documents in docs/archive/completed-prds/2.5/fixtures/compliance-evidence/<scenario>/ are uploaded as BARE,
 * scope-bound evidence items (sourceType=user_upload, evidenceType=other, no mappings) — exactly
 * like a user dropping files into the library. The compliance agent then annotates, maps, and
 * reviews them during a run; believable content lets controls legitimately pass.
 *
 * Files are stored with a real SHA-256 + durable storageRef so the agent can resolve and read them
 * via compliance-evidence:<id>, identical to a real upload.
 *
 * Usage (run from services/backend so the storage root matches the server):
 *   npx tsx scripts/seed-compliance-evidence.ts                       # org=nullsquare scope=production
 *   npx tsx scripts/seed-compliance-evidence.ts --org=nullsquare --scope=production
 *   npx tsx scripts/seed-compliance-evidence.ts --dry-run            # validate, no writes
 *   npx tsx scripts/seed-compliance-evidence.ts --scenario=nullsquare
 *
 * Idempotent: items are tagged metadata.seed and skipped if already present for the scope.
 */
import './../src/config/loadDotenv';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { and, eq, sql } from 'drizzle-orm';

import { db, getPool } from '../src/db/client';
import { complianceEvidenceItems, organizations, scopes } from '../src/db/schema';
import { ComplianceEvidenceService } from '../src/domains/security-ops/compliance/ComplianceEvidenceService';
import {
  complianceEvidenceStorageRoot,
  resolveComplianceEvidenceStoragePath,
} from '../src/domains/security-ops/compliance/ComplianceEvidenceFileResolver';

const SEED_TAG = 'nullsquare-soc2-fixtures';
const SEED_VERSION = 1;

const arg = (name: string, fallback: string): string =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]?.trim() || fallback;
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const orgName = arg('org', 'nullsquare');
  const scopeName = arg('scope', 'production');
  const scenario = arg('scenario', 'nullsquare');
  const dryRun = hasFlag('dry-run');

  const fixturesDir = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'docs',
    'archive',
    'completed-prds',
    '2.5',
    'fixtures',
    'compliance-evidence',
    scenario,
  );
  const entries = (await fs.readdir(fixturesDir)).filter((f) => f.toLowerCase().endsWith('.md')).sort();
  if (entries.length === 0) {
    throw new Error(`No .md fixtures found in ${fixturesDir}`);
  }

  console.log(`[seed-evidence] scenario=${scenario} org=${orgName} scope=${scopeName} dryRun=${dryRun}`);
  console.log(`[seed-evidence] fixtures: ${entries.length} files from ${fixturesDir}`);

  // Resolve org + scope by name (UUIDs differ across environments).
  const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, orgName)).limit(1);
  if (!org) throw new Error(`Organization "${orgName}" not found. Seed the org/scope first.`);
  const [scope] = await db
    .select({ id: scopes.id })
    .from(scopes)
    .where(and(eq(scopes.organizationId, org.id), eq(scopes.name, scopeName)))
    .limit(1);
  if (!scope) throw new Error(`Scope "${scopeName}" not found for org "${orgName}".`);

  const service = new ComplianceEvidenceService(db);
  let created = 0;
  let skipped = 0;

  for (const fileName of entries) {
    const content = await fs.readFile(path.join(fixturesDir, fileName));
    const sha256 = createHash('sha256').update(content).digest('hex');

    // Idempotency: one seeded item per fixture file per scope.
    const [existing] = await db
      .select({ id: complianceEvidenceItems.id })
      .from(complianceEvidenceItems)
      .where(
        and(
          eq(complianceEvidenceItems.organizationId, org.id),
          eq(complianceEvidenceItems.scopeId, scope.id),
          sql`${complianceEvidenceItems.metadata}->>'seed' = ${SEED_TAG}`,
          sql`${complianceEvidenceItems.metadata}->>'fixtureFile' = ${fileName}`,
        ),
      )
      .limit(1);
    if (existing) {
      skipped += 1;
      console.log(`[seed-evidence]  skip (exists): ${fileName} -> ${existing.id}`);
      continue;
    }

    const storageRef = `${org.id}/compliance-fixtures/${scenario}/${fileName}`;
    if (dryRun) {
      console.log(`[seed-evidence]  would create: ${fileName} (sha256=${sha256.slice(0, 12)}…, ${content.length} bytes)`);
      created += 1;
      continue;
    }

    // Write the durable file exactly where the resolver/agent will read it.
    const absolutePath = resolveComplianceEvidenceStoragePath(storageRef);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content);

    const evidence = await service.createEvidenceItem({
      organizationId: org.id,
      scopeId: scope.id,
      uploadedBy: null,
      // Bare upload: title is the filename; the agent authors the real title/description/type/validUntil.
      title: fileName,
      sourceType: 'user_upload',
      evidenceType: 'other',
      artifact: {
        fileName,
        mimeType: 'text/markdown',
        sizeBytes: content.length,
        sha256,
        storageRef,
      },
      metadata: { seed: SEED_TAG, fixtureFile: fileName, fixtureVersion: SEED_VERSION, scenario },
      mappings: [],
    });
    created += 1;
    console.log(`[seed-evidence]  created: ${fileName} -> ${evidence.id}`);
  }

  console.log(`[seed-evidence] done. created=${created} skipped=${skipped} storageRoot=${complianceEvidenceStorageRoot()}`);
}

main()
  .then(async () => {
    await getPool().end().catch(() => {});
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('[seed-evidence] failed:', err instanceof Error ? err.message : err);
    await getPool().end().catch(() => {});
    process.exit(1);
  });
