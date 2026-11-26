import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE RULES THAT MAKE A "SOMETHING NEW HERE" MARK WORTH TRUSTING.
 *
 * Read from the source rather than exercised against a database, for the same
 * reason `emailPalette.test.ts` does: the service pulls in the db client, and
 * what is worth pinning is not that Drizzle composes a query — it is the
 * SEMANTIC decisions a future edit would quietly get wrong.
 *
 * A mark that appears for the wrong reason, or refuses to clear, is worse than
 * none: people learn to ignore it, and then the one that matters is ignored too.
 */
const SOURCE = readFileSync(
  join(__dirname, '../../../../../src/app/services/attention/AttentionService.ts'),
  'utf8',
);

describe('the attention projection', () => {
  /**
   * The whole contract: a count is rows newer than the person's watermark. If a
   * surface ever counts without comparing, its mark can never clear.
   */
  it('counts only what arrived after this person last looked', () => {
    const comparisons = SOURCE.match(/gt\(\s*\w+\.\w+,\s*since\s*\)/gu) ?? [];
    expect(
      comparisons.length,
      'every counted surface must compare against the watermark',
    ).toBeGreaterThanOrEqual(2);

    /* Each surface resolves its own watermark — one shared instant would mean
       opening Risks silently marked Assessments seen too. */
    expect(SOURCE).toContain('since.risks');
    expect(SOURCE).toContain('since.runs');
  });

  it('never marks Settings: nothing arrives there in Null AI', () => {
    expect(SOURCE).toContain('settings: 0');
  });

  /**
   * ── NO TABLE OF ITS OWN ──
   * One timestamp per person per destination is exactly what `users.preferences`
   * already holds for `onboardingWelcomeSeenAt`, and that row is read anyway to
   * resolve the fallback date. A dedicated table would be a migration, an index
   * and a join for a fact that fits in a column already being fetched.
   */
  it('keeps the watermark in user preferences, not a table of its own', () => {
    expect(SOURCE).toContain('users.preferences');
    expect(SOURCE, 'nav_seen_markers was removed deliberately').not.toContain('navSeenMarkers');
  });

  /**
   * ── OPENING THE PAGE IS THE ONLY THING THAT CLEARS A MARK ──
   * And the merge happens inside Postgres. A read-then-write here would lose one
   * of two destinations opened in two tabs at once.
   */
  it('clears a mark by moving the watermark, in one statement', () => {
    expect(SOURCE).toMatch(/markSeen\s*\(/u);
    expect(SOURCE).toContain('jsonb_build_object');
    expect(SOURCE).toContain("'navSeenAt'");
  });

  /**
   * ── "RUNNING" IS NOT NEWS, IT IS WEATHER ──
   * An assessment is new when it starts and when it ends. Keying on `updated_at`
   * would hold the mark lit for the entire run, turning "new" into "busy" — the
   * fastest way to teach somebody to stop looking at it.
   */
  it('marks an assessment when it starts and when it finishes, not while it runs', () => {
    expect(SOURCE).toContain('runs.createdAt');
    expect(SOURCE).toContain('runs.completedAt');
    expect(SOURCE, 'updated_at churns for the whole run').not.toContain('runs.updatedAt');
  });

  /**
   * ── A NEW ACCOUNT MUST NOT INHERIT HISTORY ──
   * With no watermark yet the fallback is when the person joined, so somebody
   * who signed up this morning is not greeted by every finding the organization
   * has ever had.
   */
  it('falls back to when the person joined, never to the beginning of time', () => {
    expect(SOURCE).toContain('users.created_at');
  });

  /** Keyed by the sidebar's NavItem ids, or the client silently drops the mark. */
  it('keys its counts by nav destination', () => {
    expect(SOURCE).toMatch(/risks:\s*number/u);
    expect(SOURCE).toMatch(/runs:\s*number/u);
    expect(SOURCE).toMatch(/settings:\s*number/u);
  });
});
