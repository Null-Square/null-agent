/**
 * One-off historical backfill of the advisory corpus.
 *
 * The scheduled tick is built for steady-state deltas: it runs every two hours
 * and completes at most one 120-day window per tick, which loads a decade of
 * history in roughly two to three days. That cadence exists because NVD asks
 * automated consumers not to *poll* more often than every two hours — it is not
 * a limit on a single bulk load, and the actual request budget with an API key
 * is 50 per 30 seconds.
 *
 * So the same windows can be walked back-to-back in minutes rather than days.
 * This script does that, then leaves steady state to the tick.
 *
 * It shares the sync service, the cursor and the advisory lock with the tick, so
 * it is resumable, safe to interrupt, and safe to run while the app is up: the
 * lock means the two cannot ingest the same window simultaneously.
 *
 *   THREAT_WATCH_NVD_API_KEY=... npx tsx scripts/threat-watch/backfill-advisories.ts
 *
 * Options via env:
 *   BACKFILL_DAYS          how far back to reach (default 3650, ~10 years)
 *   BACKFILL_MAX_MINUTES   wall-clock cap; stops cleanly and stays resumable
 *   BACKFILL_PAGES_PER_RUN pages per sync call (default 10)
 */
import { db } from '@/db/client';
import { AdvisoryRepository } from '@/domains/security-ops/advisories/AdvisoryRepository';
import { AdvisorySyncService } from '@/domains/security-ops/advisories/AdvisorySyncService';
import { NvdClient } from '@/domains/security-ops/advisories/NvdClient';
import { ExposureMatchService } from '@/domains/security-ops/exposure/ExposureMatchService';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
  const apiKey = process.env.THREAT_WATCH_NVD_API_KEY?.trim() || null;
  const backfillDays = Number(process.env.BACKFILL_DAYS ?? 3650);
  const maxMinutes = Number(process.env.BACKFILL_MAX_MINUTES ?? 60);
  const pagesPerRun = Number(process.env.BACKFILL_PAGES_PER_RUN ?? 10);

  const client = new NvdClient({ apiKey });
  const repository = new AdvisoryRepository(db);
  const sync = new AdvisorySyncService(db, client, repository, {
    maxPagesPerRun: pagesPerRun,
    backfillDays,
  });
  const matcher = new ExposureMatchService(db);

  // Request spacing is owned by NvdClient so the scheduled path and this
  // backfill cannot drift into different provider-rate behavior.
  const requestsPer30s = client.rateLimitPer30s;

  process.stdout.write(
    [
      `key            : ${apiKey ? 'present' : 'ABSENT (keyless, 5 req/30s — expect this to be slow)'}`,
      `backfill days  : ${backfillDays}`,
      `pages per call : ${pagesPerRun}`,
      `provider budget: ${requestsPer30s}/30s (paced per request by NvdClient)`,
      `time cap       : ${maxMinutes} minutes`,
      '',
    ].join('\n'),
  );

  const deadline = Date.now() + maxMinutes * 60_000;
  let calls = 0;
  let ingested = 0;

  for (;;) {
    if (Date.now() > deadline) {
      process.stdout.write('\nTime cap reached. Cursor is saved; rerun to continue.\n');
      break;
    }

    const result = await sync.syncOnce();
    calls += 1;
    ingested += result.advisoriesIngested;

    process.stdout.write(
      `call ${String(calls).padStart(4)}  status=${result.status.padEnd(7)}  ` +
        `ingested=${String(result.advisoriesIngested).padStart(5)}  ` +
        `total=${String(ingested).padStart(6)}  ` +
        `windowComplete=${result.windowComplete}  moreWindows=${result.moreWindows}\n`,
    );

    if (result.status === 'skipped') {
      // Another process holds the lock — most likely the scheduled tick. Waiting
      // is correct: racing it would only duplicate work.
      process.stdout.write('  another sync holds the lock; waiting\n');
      await sleep(1_000);
      continue;
    }

    if (result.status === 'failed') {
      process.stdout.write(`  stopping on failure: ${result.error ?? 'unknown'}\n`);
      break;
    }

    // `moreWindows` false with a completed window means the cursor has caught up
    // to the present and steady-state deltas are the tick's job from here.
    if (result.windowComplete && !result.moreWindows) {
      process.stdout.write('\nBackfill complete: cursor has reached the present.\n');
      break;
    }

    // NvdClient spaces individual requests, including the first page of the
    // next call, so no second batch-level limiter is needed here.
  }

  // Ingesting advisories creates no exposures on its own.
  //
  // The cycle matches only advisories it saw change during that cycle, so a
  // corpus loaded by this script would sit inert: the customer would have years
  // of advisories in the database and nothing on their dashboard. Reconciliation
  // walks the other direction — component first — and is what actually produces
  // the first matches.
  process.stdout.write('\nReconciling components against the loaded corpus...\n');

  const reconciled = await matcher.reconcileComponents({
    // The whole corpus, not a recent window: every known component is matched
    // against advisories that were only just loaded.
    since: new Date(0),
  });

  process.stdout.write(
    `components considered=${reconciled.componentsConsidered} ` +
      `advisories matched=${reconciled.advisoriesMatched}\n`,
  );

  process.stdout.write(`\ncalls=${calls} advisoriesIngested=${ingested}\n`);
};

void main()
  .catch((error: unknown) => {
    process.stderr.write(
      `Backfill failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    // The pool keeps the process alive otherwise.
    void db.$client.end?.();
  });
