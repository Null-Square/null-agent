import { cn } from '@null-ai/design-tokens/ui';
import type { ImpactTolerance } from '@/modules/security-ops/types';

const IMPACT_OPTIONS: Array<{ value: ImpactTolerance; label: string; note: string }> = [
  { value: 'non_destructive', label: 'Observe', note: 'Probes and observation only.' },
  { value: 'poc', label: 'Proof', note: 'Confirm the issue, stop before real impact.' },
  { value: 'full', label: 'Exploit', note: 'Resettable non-production targets only.' },
];

interface ScopeTestingBriefProps {
  mission: string | null;
  impactTolerance: ImpactTolerance;
  canManage: boolean;
  onChange: (brief: { mission: string | null; impactTolerance: ImpactTolerance }) => void;
}

/**
 * The two decisions a scope actually carries: how far testing may go, and
 * anything specific to aim at.
 *
 * Everything else that stood here — the standard-contract recital, the
 * methodology paragraph, the full-exploitation warning and its bullets — said
 * the same thing the product already does by default. Prose that restates the
 * default is not guidance, it is something to scroll past, and it buried the
 * two controls that are real.
 */
export default function ScopeTestingBrief({
  mission,
  impactTolerance,
  canManage,
  onChange,
}: ScopeTestingBriefProps) {
  const selected = IMPACT_OPTIONS.find((option) => option.value === impactTolerance);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h3 className="text-[15px] font-semibold tracking-tight text-foreground">Impact limit</h3>
          <div className="flex shrink-0 border border-border p-1" role="radiogroup" aria-label="Impact limit">
            {IMPACT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={impactTolerance === option.value}
                disabled={!canManage}
                onClick={() => onChange({ mission, impactTolerance: option.value })}
                className={cn(
                  'px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                  impactTolerance === option.value
                    ? 'bg-foreground font-bold text-background'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">{selected?.note}</p>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-[15px] font-semibold tracking-tight text-foreground">Mission guidance</h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Optional. Leave it empty for the standard assessment.
          </p>
        </div>
        <textarea
          aria-label="Mission guidance"
          value={mission ?? ''}
          disabled={!canManage}
          onChange={(event) =>
            onChange({
              mission: event.target.value.trim() ? event.target.value : null,
              impactTolerance,
            })
          }
          placeholder="ANYTHING SPECIFIC TO AIM AT?"
          className="h-28 w-full border-l-2 border-border py-3 pl-4 font-mono text-sm uppercase text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/60 focus:ring-1 focus:ring-primary/20 disabled:opacity-60"
        />
      </section>
    </div>
  );
}
