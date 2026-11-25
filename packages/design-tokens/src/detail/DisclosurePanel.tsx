import React from 'react';
import { cn } from '../cn';

/**
 * DisclosurePanel — a section that can be folded away.
 *
 * For pages that carry several independent configuration areas (scope setup is
 * the case that produced it): each is a hairline panel whose header states what
 * it is and what state it is in, so the page can be read as a list of decisions
 * before anything is expanded. Beats six always-open boxes stacked down a page.
 *
 * The header is a real `<button>` with `aria-expanded` and `aria-controls`; the
 * chevron is a 1.6px stroke glyph per the control-glyph rule, and it rotates —
 * a transform, not one of the animations the brand budgets.
 */

export interface DisclosurePanelProps {
  title: React.ReactNode;
  /** One quiet line under the title — what this section governs. */
  description?: React.ReactNode;
  /** Current state, shown in the header while collapsed (a StatusPill or chip). */
  state?: React.ReactNode;
  defaultOpen?: boolean;
  /** Controlled mode. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    viewBox="0 0 16 16"
    width="14"
    height="14"
    aria-hidden="true"
    className={cn('flex-none transition-transform duration-200', open && 'rotate-180')}
  >
    <path d="M3.5 6.5 L8 11 L12.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
  </svg>
);

let panelSeq = 0;

export const DisclosurePanel: React.FC<DisclosurePanelProps> = ({
  title,
  description,
  state,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  children,
  className,
}) => {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const bodyId = React.useMemo(() => `ns-disclosure-${(panelSeq += 1)}`, []);

  const toggle = () => {
    if (!isControlled) setUncontrolledOpen((previous) => !previous);
    onOpenChange?.(!open);
  };

  return (
    <section className={cn('border border-border', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={toggle}
        className="flex w-full items-center justify-between gap-6 px-6 py-5 text-left transition-colors hover:bg-elevated/40"
      >
        <span className="min-w-0">
          <span className="block text-[15px] font-semibold tracking-tight text-foreground">{title}</span>
          {description ? (
            <span className="mt-1 block text-sm text-muted-foreground">{description}</span>
          ) : null}
        </span>
        <span className="flex flex-none items-center gap-5 text-muted-foreground">
          {state}
          <Chevron open={open} />
        </span>
      </button>

      {open ? (
        <div id={bodyId} className="border-t border-border px-6 py-7">
          {children}
        </div>
      ) : null}
    </section>
  );
};
