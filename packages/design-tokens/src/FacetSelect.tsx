import React from 'react';

import { cn } from './cn';

/**
 * FacetSelect — one facet of the shared query bar.
 *
 * The brand system's Chapter IV control: every list page filters by a text
 * search plus one or two enumerations, so this is that enumeration. A hairline
 * field showing the current choice and a 1.6px chevron; open it and each option
 * is an optional square swatch + label + count, the selected row marked with a
 * signal edge. No box, no fill — quiet until you engage it.
 */

export interface FacetOption {
  value: string;
  label: string;
  count?: number;
  /** Tailwind bg-* class for a leading square swatch (e.g. severity colour). */
  swatchClass?: string;
}

export interface FacetSelectProps {
  /** Shown when the default option is active (e.g. "All severities"). */
  label: string;
  value: string;
  options: FacetOption[];
  onChange: (value: string) => void;
  className?: string;
  'aria-label'?: string;
}

const Chevron = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="flex-none">
    <path d="M3.5 6.5 L8 11 L12.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
  </svg>
);

export const FacetSelect: React.FC<FacetSelectProps> = ({
  label,
  value,
  options,
  onChange,
  className,
  'aria-label': ariaLabel,
}) => {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  const selected = options.find((option) => option.value === value);
  // "Set" = a non-default choice. The first option is treated as the default.
  const isSet = Boolean(value) && value !== options[0]?.value;

  React.useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          'flex h-[46px] w-full items-center justify-between gap-2.5 border px-4 text-sm transition-colors',
          isSet
            ? 'border-foreground/20 text-foreground shadow-[inset_3px_0_0_var(--ns-fg-dim)]'
            : 'border-border text-muted-foreground hover:text-foreground/80',
          open && 'border-foreground/20 text-foreground',
        )}
      >
        <span className="flex min-w-0 items-center gap-2.5 truncate">
          {selected?.swatchClass && isSet ? (
            <span className={cn('h-2.5 w-2.5 flex-none', selected.swatchClass)} />
          ) : null}
          <span className="truncate">{selected ? selected.label : label}</span>
        </span>
        <Chevron />
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute left-[-1px] right-[-1px] top-[calc(100%+5px)] z-20 border border-foreground/20 bg-ns-elevated py-1.5"
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                type="button"
                key={option.value}
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors',
                  active ? 'text-foreground shadow-[inset_3px_0_0_var(--ns-yellow)]' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
                )}
              >
                <span className={cn('h-2.5 w-2.5 flex-none', option.swatchClass ?? 'bg-muted-foreground')} />
                <span className="truncate">{option.label}</span>
                {option.count != null ? (
                  <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">{option.count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
