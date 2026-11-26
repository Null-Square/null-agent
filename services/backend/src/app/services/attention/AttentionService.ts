/**
 * WHAT ARRIVED SINCE THIS PERSON LAST LOOKED, PER DESTINATION.
 *
 * The badge pattern games use for a new item: something appears, the
 * destination carries a mark, you go and look, the mark clears. Nothing more
 * clever than that — people already know how to read it, which is the whole
 * reason to use it.
 *
 * ── A WATERMARK, NOT AN EVENT LOG ──
 * One timestamp per person per destination, kept in `users.preferences` beside
 * the other small facts about this person's UI. Everything else is a comparison
 * against live rows:
 *
 *     dot on Assessments  ⇔  a run appeared, finished or failed after seen_at
 *
 * So a scheduled assessment that starts at 03:00 writes nothing anywhere. There
 * is no event to publish, nothing to fan out to each member, and no way for the
 * count to disagree with the page it points at — the page and the dot read the
 * same table. A publisher that forgets to fire cannot silently break it, and
 * three hundred runs cost three hundred rows in `runs` and none here.
 *
 * This is deliberately NOT the notifications table, which stores a row per
 * event with a `read` flag. The bell answers "what happened, tell me once";
 * this answers "is there anything here I have not seen". Both exist, and the
 * bell clearing does not clear these.
 *
 * ── THE FIRST VISIT ──
 * With no marker yet, the watermark falls back to when the person's account was
 * created. A new signup therefore sees marks for everything that happened since
 * they joined, which is exactly right, and never a startling count for history
 * that predates them.
 */
import { and, count, eq, gt, or, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { findings, runs, users } from '@/db/schema';

/**
 * Keyed by the sidebar's own `NavItem.id`, so the client needs no mapping table
 * and a renamed destination breaks in one obvious place rather than silently
 * dropping a dot.
 */
export type AttentionCounts = {
  risks: number;
  runs: number;
  settings: number;
};

export const ATTENTION_SURFACES = ['risks', 'runs', 'settings'] as const;
export type AttentionSurface = (typeof ATTENTION_SURFACES)[number];

export const isAttentionSurface = (value: string): value is AttentionSurface =>
  (ATTENTION_SURFACES as readonly string[]).includes(value);

const first = (rows: Array<{ value: number }>): number => Number(rows[0]?.value ?? 0);

export class AttentionService {
  /**
   * Every watermark for this person, resolved to real timestamps.
   *
   * Fetched once rather than embedded as a correlated subquery per count: the
   * three counts share the lookup, and the resolved values read plainly at the
   * call site instead of hiding inside generated SQL.
   */
  private async watermarks(userId: string): Promise<Record<AttentionSurface, Date>> {
    const rows = await db
      .select({ createdAt: users.created_at, preferences: users.preferences })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    /* ── A NEW ACCOUNT MUST NOT INHERIT HISTORY ──
       With no watermark yet the fallback is when they joined, so somebody who
       signed up this morning is not greeted by every finding the organization
       has ever had. The epoch fallback is unreachable in practice — a user row
       always has `created_at` — and exists so the type is honest. */
    const joined = rows[0]?.createdAt ?? new Date(0);
    const seen = rows[0]?.preferences?.navSeenAt ?? {};

    return Object.fromEntries(
      ATTENTION_SURFACES.map((surface) => {
        const stored = seen[surface] ? new Date(seen[surface]) : null;
        const usable = stored && !Number.isNaN(stored.getTime()) ? stored : joined;
        return [surface, usable];
      }),
    ) as Record<AttentionSurface, Date>;
  }

  /** Risks: a finding that was not on the page last time they opened it. */
  private async newRisks(organizationId: string, since: Date): Promise<number> {
    const rows = await db
      .select({ value: count() })
      .from(findings)
      .where(and(eq(findings.organizationId, organizationId), gt(findings.createdAt, since)));
    return first(rows);
  }

  /**
   * ── AN ASSESSMENT IS NEW TWICE: WHEN IT STARTS AND WHEN IT ENDS ──
   * Both are moments somebody would want to know about, and both are what the
   * Assessments page would show them. Deliberately keyed on `created_at` and
   * `completed_at` rather than `updated_at`: a running assessment touches
   * `updated_at` constantly, which would hold the dot lit for the entire run
   * and make it mean "busy" instead of "new".
   */
  private async newRuns(organizationId: string, since: Date): Promise<number> {
    const rows = await db
      .select({ value: count() })
      .from(runs)
      .where(and(
        eq(runs.organizationId, organizationId),
        or(gt(runs.createdAt, since), gt(runs.completedAt, since)),
      ));
    return first(rows);
  }

  /**
   * How much has arrived at each destination since this person last opened it.
   *
   * A count per destination is the whole answer. The question a nav dot exists
   * to answer is "does this menu item have something I have not checked" —
   * anything more than a number per destination is answering a question nobody
   * asked, at the cost of a wider contract to keep true.
   */
  async forUser(userId: string, organizationId: string): Promise<AttentionCounts> {
    const since = await this.watermarks(userId);

    /* `newRunCount`, not `runs` — the table of that name is in scope here. */
    const [risks, newRunCount] = await Promise.all([
      this.newRisks(organizationId, since.risks),
      this.newRuns(organizationId, since.runs),
    ]);

    // Nothing arrives at Settings in Null AI, so it is never marked.
    return { risks, runs: newRunCount, settings: 0 };
  }

  /**
   * ── OPENING THE PAGE IS THE WHOLE INTERACTION ──
   * Called when somebody arrives at a destination. Moves the watermark to now,
   * which is what makes the mark disappear; there is nothing else to clear.
   *
   * One statement, and the merge happens inside Postgres rather than as a
   * read-then-write in here: two tabs opening two destinations at once each
   * update their own key, and neither loses the other's. Missing objects are
   * created on the way down, so a person who has never had preferences is not a
   * special case.
   */
  async markSeen(userId: string, surface: AttentionSurface): Promise<void> {
    await db
      .update(users)
      .set({
        preferences: sql`
          coalesce(${users.preferences}, '{}'::jsonb)
          || jsonb_build_object(
               'navSeenAt',
               coalesce(${users.preferences} -> 'navSeenAt', '{}'::jsonb)
                 || jsonb_build_object(${surface}::text, to_jsonb(now()))
             )
        `,
      })
      .where(eq(users.id, userId));
  }
}

/* ── NAMED GAPS, so the next person knows these were considered ──
   assets      the inventory changes on every run; marking it would light the
               dot permanently, which is the failure this pattern is most prone
               to. It needs a narrower question than "something changed".
   compliance  a framework's readiness is recomputed, not appended, so there is
               no "new row" to count. Evidence entering `pending` review is the
               real candidate and needs a product decision about who owes it.
   Give one of them a countable arrival and it belongs here in four lines. */
