import { cn } from '@null-ai/design-tokens/ui';
import { COMPLIANCE_FRAMEWORK_OPTIONS } from '@/modules/security-ops/complianceFrameworks';
import type { ComplianceFrameworkKey } from '@/modules/security-ops/types';

interface ScopeComplianceFrameworksProps {
  selected: ComplianceFrameworkKey[];
  canManage: boolean;
  onChange: (frameworks: ComplianceFrameworkKey[]) => void;
}

/**
 * Optional reporting mappings. Staged like everything else on this page.
 *
 * Lifted out of `RoeDocumentEditor`, which had become a wrapper around three
 * unrelated things and a page of recital text.
 */
export default function ScopeComplianceFrameworks({
  selected,
  canManage,
  onChange,
}: ScopeComplianceFrameworksProps) {
  const toggle = (key: ComplianceFrameworkKey) => {
    if (!canManage) return;
    onChange(
      selected.includes(key) ? selected.filter((value) => value !== key) : [...selected, key],
    );
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-[15px] font-semibold tracking-tight text-foreground">Compliance frameworks</h3>
        <p className="text-sm text-muted-foreground">Optional reporting mappings; these do not narrow discovery.</p>
      </div>

      <div className="grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
        {COMPLIANCE_FRAMEWORK_OPTIONS.map((option) => {
          const isSelected = selected.includes(option.key);
          return (
            <button
              key={option.key}
              type="button"
              role="checkbox"
              aria-checked={isSelected}
              disabled={!canManage}
              onClick={() => toggle(option.key)}
              className={cn(
                'flex items-center justify-between gap-3 bg-background px-5 py-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                isSelected ? 'text-foreground' : 'text-muted-foreground hover:bg-elevated/40 hover:text-foreground',
              )}
            >
              <span className="font-mono text-[12px] font-bold tracking-[0.06em]">{option.label}</span>
              <span
                aria-hidden
                className={cn(
                  'h-3.5 w-3.5 flex-none border',
                  isSelected ? 'border-foreground bg-foreground' : 'border-border',
                )}
              />
            </button>
          );
        })}
      </div>
    </section>
  );
}
