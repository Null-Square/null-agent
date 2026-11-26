import React from 'react';
import { Check } from 'lucide-react';

import { cn } from './cn';

export interface ClauseCheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** The sentence the person is agreeing to. Prose, so it wraps. */
  children: React.ReactNode;
  disabled?: boolean;
  /** Shown under the clause when it explains a consequence rather than restating it. */
  hint?: React.ReactNode;
  testId?: string;
}

/**
 * A checkbox for a clause somebody is being asked to stand behind.
 *
 * `Checkbox` is the right control for a setting: one line, centred, mono,
 * because a setting's label is a handle. A warranty is a paragraph. It wraps, it
 * top-aligns to the box, and it is prose rather than data — mono here would be
 * the brand rule applied backwards.
 *
 * Kept separate rather than adding modes to `Checkbox`, which other pages
 * already consume: two jobs, two components.
 */
export const ClauseCheckbox = ({
  checked,
  onCheckedChange,
  children,
  disabled,
  hint,
  testId,
}: ClauseCheckboxProps) => (
  <label
    className={cn(
      'flex items-start gap-3 border p-4 text-left transition-colors',
      disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
    )}
    style={{
      borderColor: checked ? 'var(--color-primary)' : 'var(--color-border)',
    }}
  >
    <input
      type="checkbox"
      className="peer sr-only"
      checked={checked}
      disabled={disabled}
      data-testid={testId}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
    <span
      aria-hidden
      data-state={checked ? 'checked' : 'unchecked'}
      className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center border transition-colors peer-focus-visible:ring-2"
      style={{
        borderColor: checked ? 'var(--color-primary)' : 'var(--color-border)',
        backgroundColor: checked ? 'var(--color-primary)' : 'var(--color-input)',
      }}
    >
      <Check
        className="h-3.5 w-3.5"
        style={{ color: checked ? 'var(--color-primary-foreground)' : 'transparent' }}
      />
    </span>
    <span className="space-y-1.5">
      <span className="block text-sm leading-relaxed text-foreground">{children}</span>
      {hint ? (
        <span className="block text-xs leading-relaxed text-muted-foreground">{hint}</span>
      ) : null}
    </span>
  </label>
);

ClauseCheckbox.displayName = 'ClauseCheckbox';
