import type { ScopeTarget } from '@/modules/security-ops/types';
import { CellIcon, type CellIconName } from '@null-ai/design-tokens/ui';

import { DashboardGate } from './DashboardGate';

/**
 * The dashboard before there is a dashboard — three frames of one story.
 *
 * Each replaces the page rather than sitting on it, because until the thing it
 * describes is resolved there are no figures to report and no grade to give.
 * A greeting over a board of empty widgets is eight pieces of furniture in
 * front of the one door.
 *
 * They are ordered by what has to happen first: a domain, then verification,
 * then the first assessment itself.
 */

const WHAT_ARRIVES: Array<{ icon: CellIconName; title: string; line: string }> = [
  { icon: 'assets', title: 'Assets', line: 'Every host, endpoint and service you expose' },
  { icon: 'findings', title: 'Risks', line: 'What an attacker can actually reach' },
  { icon: 'compliance', title: 'Posture', line: 'One grade, from evidence rather than a survey' },
];

function WhatArrives({ label }: { label: string }) {
  return (
    <div className="border-t border-border pt-8">
      <p className="mb-7 text-center font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </p>
      <div className="grid gap-x-10 gap-y-8 sm:grid-cols-3">
        {WHAT_ARRIVES.map((item) => (
          <div
            key={item.title}
            className="flex flex-col items-center gap-3 text-center sm:items-start sm:text-left"
          >
            <CellIcon name={item.icon} size={26} className="text-foreground/40" />
            <div>
              <div className="text-sm font-semibold text-foreground">{item.title}</div>
              <div className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                {item.line}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const primaryButton =
  'bg-primary px-8 py-4 text-xs font-extrabold uppercase tracking-wider text-primary-foreground transition-opacity hover:opacity-90';

/**
 * No domain, or an unverified one.
 *
 * The domain sets at display scale in mono — it is the one piece of real data
 * on the screen, and the thing the reader has to recognise as theirs before
 * anything else makes sense.
 *
 * The explanation earns its place: nobody edits a DNS record for its own sake.
 * They do it because something happens next, and "the first assessment starts
 * on its own" is the fact that makes the errand worth running.
 */
export function DashboardVerificationGate({
  target,
  onVerify,
  onAddTarget,
}: {
  target: ScopeTarget | null;
  onVerify: () => void;
  onAddTarget: () => void;
}) {
  if (!target) {
    return (
      <DashboardGate
        icon="scope"
        kicker="No domain yet"
        headline="Name what we may test"
        description="A scope is the authorisation boundary an assessment runs inside. Add a domain you own and we will take it from there."
        action={
          <button type="button" onClick={onAddTarget} className={primaryButton}>
            Add a domain
          </button>
        }
        footer={<WhatArrives label="What this page becomes" />}
      />
    );
  }

  return (
    <DashboardGate
      icon="website-watch"
      kicker="Verification required"
      headline={
        <span className="break-all font-mono tracking-[-0.02em]" title={target.value}>
          {target.value}
        </span>
      }
      description="Verification proves you control this domain, which is what makes testing it lawful. The moment it passes, the first assessment starts on its own — there is nothing else to launch."
      action={
        <button
          type="button"
          aria-label={`Verify target ${target.value}`}
          onClick={onVerify}
          className={primaryButton}
        >
          Verify this domain
        </button>
      }
      footer={<WhatArrives label="What arrives after verification" />}
    />
  );
}

/** Verified, and the first assessment is already running. */
export function DashboardFirstRun({ target }: { target: ScopeTarget }) {
  return (
    <DashboardGate
      icon="pentest"
      kicker="Discovery running"
      tone="live"
      headline="Mapping your surface"
      description={
        <>
          <span className="font-mono font-bold text-foreground">{target.value}</span> is verified,
          so the first assessment is already running. It maps everything you expose before it tests
          any of it — check back in a few minutes.
        </>
      }
      footer={<WhatArrives label="What lands here first" />}
    />
  );
}
