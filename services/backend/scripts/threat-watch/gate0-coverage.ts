/**
 * Gate 0 — the measurement that can cancel Threat Watch.
 *
 * PRD §5 poses two questions that decide whether the product is viable, and
 * neither is answerable from the code:
 *
 *   1. Can we canonically identify what a site runs, *with a version*?
 *      Below roughly 40% of observations, alerts are too sparse to sell.
 *   2. Can we see WordPress plugin versions at all? If not, the Wordfence /
 *      Patchstack licensing decision (D2) is moot — there would be nothing to
 *      match their data against.
 *
 * `--persisted` is the launch metric: it measures the inventory the product
 * actually stored, separated by evidence tier and source. Domain arguments are
 * a passive-collector diagnostic only. They exclude authenticated connected-
 * site manifests and lockfiles and must not be presented as product coverage.
 *
 * Usage:
 *   npx tsx scripts/threat-watch/gate0-coverage.ts --persisted
 *   npx tsx scripts/threat-watch/gate0-coverage.ts domains.txt
 *   npx tsx scripts/threat-watch/gate0-coverage.ts example.com example.org
 *
 * Reads only what a browser would: every request goes through
 * TargetRequestBudget, which enforces the path allowlist, the public-host guard
 * and the five-request cap. Nothing here probes.
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { sql } from 'drizzle-orm';

import { collectHttp } from '@/domains/security-ops/components/fingerprint/http';
import { TargetRequestBudget } from '@/domains/security-ops/components/fingerprint/TargetRequestBudget';
import { splitProductVersion } from '@/domains/security-ops/tools/ingestion/ScannerRuntimeHelpers';
import {
  isNonMatchableProduct,
  normalizeAliasText,
  normalizeObservation,
  type ComponentAliasLookup,
} from '@/domains/security-ops/components/componentIdentity';
import {
  componentObservations,
  componentUnmapped,
  inventoryComponents,
  type ComponentEcosystem,
} from '@/db/schema';

// Keep the operator command self-contained in local development. Production
// environments already inject these values, while local assessment review uses
// the same defaults + overrides as the backend and reset scripts.
const backendRoot = path.resolve(__dirname, '../..');
dotenv.config({ path: path.join(backendRoot, '.env.example'), override: false });
dotenv.config({ path: path.join(backendRoot, '.env.local'), override: true });

type SeedAlias = {
  aliasText: string;
  ecosystem: ComponentEcosystem;
  componentKey: string;
  confidence?: number;
};

/**
 * Loaded from the seed file rather than the database so the gate can run
 * against a checkout with no infrastructure.
 */
const loadSeedLookup = (): ComponentAliasLookup => {
  const seedPath = path.resolve(__dirname, '../../config/seeds/component-aliases.seed.json');
  const parsed = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as { aliases: SeedAlias[] };
  const table = new Map(
    parsed.aliases.map((alias) => [
      alias.aliasText,
      {
        ecosystem: alias.ecosystem,
        componentKey: alias.componentKey,
        confidence: alias.confidence ?? 1,
      },
    ]),
  );
  return (aliasText: string) => table.get(aliasText);
};

type RawObservation = { product: string; version: string | null; origin: string };

/**
 * Everything a passive HTTP look can tell us about a site's stack.
 *
 * Mirrors what the ingestion path records, so coverage measured here is
 * coverage the product would actually get.
 */
const observeSite = async (hostname: string): Promise<{ observations: RawObservation[]; error?: string }> => {
  const budget = new TargetRequestBudget(hostname);
  const outcome = await collectHttp(budget);

  if (outcome.status !== 'ok' || !outcome.data) {
    return { observations: [], error: outcome.error ?? 'no HTTP signals' };
  }

  const signals = outcome.data;
  const observations: RawObservation[] = [];

  const pushBanner = (banner: string | null, origin: string) => {
    if (!banner) return;
    const parsed = splitProductVersion(banner);
    if (parsed.product) {
      observations.push({ product: parsed.product, version: parsed.version ?? null, origin });
    }
  };

  pushBanner(signals.server, 'server-header');
  pushBanner(signals.poweredBy, 'x-powered-by');

  // The generator meta tag is the one passive source that carries a real
  // application version ("WordPress 6.4.2"), which is why it matters here.
  if (signals.generator) {
    const parsed = splitProductVersion(signals.generator);
    if (parsed.product) {
      observations.push({ product: parsed.product, version: parsed.version ?? null, origin: 'generator-meta' });
    }
  }

  if (signals.platform) {
    observations.push({ product: signals.platform, version: null, origin: 'platform-detect' });
  }

  // WordPress plugins and themes, which is the whole of D2's question.
  for (const plugin of signals.wordpressPlugins ?? []) {
    observations.push({ product: plugin.slug, version: plugin.version, origin: 'wp-plugin' });
  }
  for (const theme of signals.wordpressThemes ?? []) {
    observations.push({ product: theme.slug, version: theme.version, origin: 'wp-theme' });
  }

  for (const tech of signals.technologies ?? []) {
    const parsed = splitProductVersion(tech);
    if (parsed.product) {
      observations.push({ product: parsed.product, version: parsed.version ?? null, origin: 'header-fingerprint' });
    }
  }

  return { observations };
};

const measurePersistedInventory = async (): Promise<void> => {
  const { db, closeDb } = await import('@/db/client');
  try {
    const [coverageRows, sourceRows, gapRows] = await Promise.all([
      db
        .select({
          total: sql<number>`count(*)::int`,
          versioned: sql<number>`count(*) filter (where ${inventoryComponents.resolvedVersion} is not null)::int`,
          observedExact: sql<number>`count(*) filter (where ${inventoryComponents.resolvedEvidenceTier} = 'observed_exact')::int`,
          reportedExact: sql<number>`count(*) filter (where ${inventoryComponents.resolvedEvidenceTier} = 'reported_exact')::int`,
          absent: sql<number>`count(*) filter (where ${inventoryComponents.resolvedEvidenceTier} = 'absent')::int`,
          interruptEligible14d: sql<number>`count(*) filter (
            where ${inventoryComponents.resolvedEvidenceTier} = 'observed_exact'
              and ${inventoryComponents.resolvedVersion} is not null
              and ${inventoryComponents.resolvedVersionObservedAt} >= now() - interval '14 days'
              and ${inventoryComponents.versionConflict} = false
              and ${inventoryComponents.backportRisk} = false
          )::int`,
        })
        .from(inventoryComponents),
      db
        .select({
          source: componentObservations.source,
          observations: sql<number>`count(*)::int`,
          versioned: sql<number>`count(*) filter (where ${componentObservations.versionNormalized} is not null)::int`,
        })
        .from(componentObservations)
        .groupBy(componentObservations.source),
      db
        .select({
          aliases: sql<number>`count(*)::int`,
          observations: sql<number>`coalesce(sum(${componentUnmapped.observationCount}), 0)::int`,
        })
        .from(componentUnmapped),
    ]);

    const coverage = coverageRows[0];
    const total = Number(coverage?.total ?? 0);
    const pct = (value: number) => total === 0 ? '0.0' : ((value / total) * 100).toFixed(1);

    process.stdout.write('=== Gate 0: persisted product inventory ===\n');
    process.stdout.write(`components                 ${total}\n`);
    process.stdout.write(`with any version           ${Number(coverage?.versioned ?? 0)} (${pct(Number(coverage?.versioned ?? 0))}%)\n`);
    process.stdout.write(`authoritative exact        ${Number(coverage?.observedExact ?? 0)} (${pct(Number(coverage?.observedExact ?? 0))}%)\n`);
    process.stdout.write(`reported exact             ${Number(coverage?.reportedExact ?? 0)} (${pct(Number(coverage?.reportedExact ?? 0))}%)\n`);
    process.stdout.write(`version absent             ${Number(coverage?.absent ?? 0)} (${pct(Number(coverage?.absent ?? 0))}%)\n`);
    process.stdout.write(`interrupt-eligible (14d)   ${Number(coverage?.interruptEligible14d ?? 0)} (${pct(Number(coverage?.interruptEligible14d ?? 0))}%)\n`);
    process.stdout.write(`unmapped aliases           ${Number(gapRows[0]?.aliases ?? 0)}\n`);
    process.stdout.write(`unmapped observations      ${Number(gapRows[0]?.observations ?? 0)}\n`);
    process.stdout.write('\n--- by observation source ---\n');
    for (const row of sourceRows) {
      process.stdout.write(`  ${row.source.padEnd(16)} ${Number(row.versioned)}/${Number(row.observations)} versioned\n`);
    }
    process.stdout.write('\nLaunch remains a written decision: coverage alone does not establish alert precision.\n');
  } finally {
    await closeDb();
  }
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--persisted') {
    await measurePersistedInventory();
    return;
  }
  if (args.length === 0) {
    process.stderr.write('usage: gate0-coverage.ts <--persisted | domains-file | domain...>\n');
    process.exit(2);
  }

  const domains =
    args.length === 1 && fs.existsSync(args[0]!)
      ? fs
          .readFileSync(args[0]!, 'utf8')
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'))
      : args;

  const lookup = loadSeedLookup();

  let sitesReached = 0;
  let totalObservations = 0;
  let resolved = 0;
  let resolvedWithVersion = 0;
  let wordpressSites = 0;
  let wordpressWithCoreVersion = 0;
  let wordpressPluginObservations = 0;
  let wordpressPluginsSeen = 0;
  let wordpressPluginsWithVersion = 0;
  let wordpressPluginsUnmapped = 0;
  let nonMatchable = 0;

  const unmapped = new Map<string, number>();

  for (const domain of domains) {
    const { observations, error } = await observeSite(domain);
    if (error) {
      process.stdout.write(`  ${domain}: unreachable (${error})\n`);
      continue;
    }
    sitesReached += 1;

    let sawWordpress = false;
    let sawWordpressVersion = false;

    // Counted before alias resolution: D2 asks whether plugin versions are
    // *visible*, which is a separate question from whether we have an alias for
    // the plugin yet. Conflating them would blame discovery for a seed gap.
    for (const observation of observations) {
      if (observation.origin === 'wp-plugin' || observation.origin === 'wp-theme') {
        wordpressPluginsSeen += 1;
        if (observation.version) wordpressPluginsWithVersion += 1;
      }
    }

    for (const observation of observations) {
      // A CDN or managed host has no customer-controlled version, so it can
      // never match. Counting it as a coverage failure would understate real
      // coverage and could fail a viable project.
      if (isNonMatchableProduct(observation.product)) {
        nonMatchable += 1;
        continue;
      }

      totalObservations += 1;
      const normalized = normalizeObservation({
        product: observation.product,
        version: observation.version,
        lookup,
      });

      if (!normalized) {
        const aliasText = normalizeAliasText(observation.product);
        if (aliasText) unmapped.set(aliasText, (unmapped.get(aliasText) ?? 0) + 1);
        if (observation.origin === 'wp-plugin' || observation.origin === 'wp-theme') {
          wordpressPluginsUnmapped += 1;
        }
        continue;
      }

      resolved += 1;
      if (normalized.versionNormalized) resolvedWithVersion += 1;

      // Keyed on the component, not the ecosystem: WordPress core is covered by
      // NVD under a CPE, so its alias resolves into the `cpe` ecosystem.
      if (normalized.identity.componentKey === 'cpe:wordpress:wordpress') {
        sawWordpress = true;
        if (normalized.versionNormalized) sawWordpressVersion = true;
      }
      if (normalized.identity.ecosystem === 'wordpress_plugin') {
        wordpressPluginObservations += 1;
      }
    }

    if (sawWordpress) wordpressSites += 1;
    if (sawWordpressVersion) wordpressWithCoreVersion += 1;

    process.stdout.write(
      `  ${domain}: ${observations.length} observations\n`,
    );
  }

  const pct = (numerator: number, denominator: number) =>
    denominator === 0 ? '0.0' : ((numerator / denominator) * 100).toFixed(1);

  process.stdout.write('\n=== Passive collector diagnostic (not product coverage) ===\n');
  process.stdout.write(`sites requested          ${domains.length}\n`);
  process.stdout.write(`sites reached            ${sitesReached}\n`);
  process.stdout.write(`matchable observations   ${totalObservations}\n`);
  process.stdout.write(
    `non-matchable (CDN/host) ${nonMatchable}  (excluded: no customer-controlled version)\n`,
  );
  process.stdout.write(`resolved to a component  ${resolved} (${pct(resolved, totalObservations)}%)\n`);
  process.stdout.write(
    `resolved WITH a version  ${resolvedWithVersion} (${pct(resolvedWithVersion, totalObservations)}%)\n`,
  );
  process.stdout.write('\n--- WordPress (D2) ---\n');
  process.stdout.write(`sites detected as WordPress   ${wordpressSites}\n`);
  process.stdout.write(`  ...with a core version      ${wordpressWithCoreVersion}\n`);
  process.stdout.write(`plugins/themes discovered     ${wordpressPluginsSeen}\n`);
  process.stdout.write(
    `  ...with a usable version    ${wordpressPluginsWithVersion} (${pct(wordpressPluginsWithVersion, wordpressPluginsSeen)}%)\n`,
  );
  process.stdout.write(`  ...resolved to a component  ${wordpressPluginObservations}\n`);
  process.stdout.write(
    `  ...discovered but unmapped  ${wordpressPluginsUnmapped}  (alias seed gap, not a discovery failure)\n`,
  );

  const topUnmapped = [...unmapped.entries()].sort((left, right) => right[1] - left[1]).slice(0, 25);
  if (topUnmapped.length > 0) {
    process.stdout.write('\n--- top unmapped products (alias backlog) ---\n');
    for (const [aliasText, count] of topUnmapped) {
      process.stdout.write(`  ${String(count).padStart(4)}  ${aliasText}\n`);
    }
  }

  process.stdout.write('\nThis measures unauthenticated passive discovery only. Use --persisted for Gate 0.\n');
};

void main();
