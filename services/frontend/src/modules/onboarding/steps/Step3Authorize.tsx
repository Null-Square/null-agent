import { StatusPill } from '@null-ai/design-tokens/ui';
import { SCOPE_AUTHORIZATION_STATEMENT } from '@null-ai/contracts';
import type { SetupFormData } from '../types';

const IMPACT_LABELS: Record<SetupFormData['impactTolerance'], string> = {
  non_destructive: 'Observation only',
  poc: 'Bounded proof of concept',
  full: 'Full exploitation',
};

/**
 * The last step: one statement, one button.
 *
 * It states the terms and nothing else. Proving control of the domain is the
 * previous step's job and stays there — the verification record, the DNS or
 * HTTP choice and the polling all belong beside the website they describe.
 * This step is only the warranty that testing is permitted.
 *
 * The statement is a click, not a tick. A checkbox beside a Continue button is
 * a thing to clear on the way past; a button whose whole label is "I authorize"
 * is the decision itself. There is deliberately no decline button — Back is the
 * way out, and offering "No" invites a dead end the wizard has no answer for.
 */
export default function Step3Authorize({
  data,
  organizationName,
}: {
  data: SetupFormData;
  organizationName: string;
}) {
  const terms = [
    { label: 'Organization', value: organizationName || '—' },
    { label: 'Website', value: data.targetValue || '—' },
    { label: 'Impact limit', value: IMPACT_LABELS[data.impactTolerance] },
    { label: 'Tested from', value: 'This computer' },
  ];

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-8">
      {/* What the statement covers, in the words the scope page will use for
          it later. A warranty nobody can read the terms of is a click-through. */}
      <div className="border border-border/40 text-left">
        <div className="flex items-center justify-between gap-3 border-b border-border/40 px-6 py-4">
          <p className="text-sm text-primary">What you are authorizing</p>
          <StatusPill tone={data.isTargetVerified ? 'success' : 'warning'} showDot={false}>
            {data.isTargetVerified ? 'Ownership verified' : 'Verification pending'}
          </StatusPill>
        </div>
        <dl className="divide-y divide-border/30">
          {terms.map((term) => (
            <div key={term.label} className="flex items-baseline justify-between gap-6 px-6 py-3">
              <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                {term.label}
              </dt>
              <dd className="min-w-0 truncate font-mono text-[13px] text-foreground">{term.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <p className="text-left text-[13px] leading-relaxed text-muted-foreground">
        {SCOPE_AUTHORIZATION_STATEMENT}
      </p>

      {/* Verification is what starts the assessment, so this says where that
          stands rather than implying the button below starts it. */}
      <p className="text-left text-[13px] leading-relaxed text-muted-foreground/80">
        {data.isTargetVerified
          ? 'Ownership is verified and the one-time discovery assessment has started.'
          : 'We are watching for the verification record from the previous step. The one-time discovery assessment starts as soon as it is found.'}
      </p>
    </div>
  );
}
