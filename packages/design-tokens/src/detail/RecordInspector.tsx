import React from 'react';

import { cn } from '../cn';

/**
 * RecordInspector — the selected record, at rail width.
 *
 * A ledger row is one line, because the stream is what the reader is scanning.
 * Everything the line left out has to land somewhere, and this is it: the same
 * frame for every record, with the tabs coming from what the record *is* rather
 * than from a fixed set — a tool has a payload and a result, a request has
 * options and usage, and every record has a summary and its timing.
 *
 * It lives in the rail rather than as a third column. The kit's detail skeleton
 * is a main column and a 360px rail, and a third column beside them is a card
 * inside a card wearing a different hat. What genuinely will not fit at that
 * width — a large payload — escalates to a `Drawer`, which is modal and so keeps
 * the scrim it is entitled to.
 *
 * Nothing here is a card: a hairline under the tab strip, and space between the
 * blocks. Tabs scroll horizontally rather than wrapping, so the strip stays one
 * line at any rail width.
 */

export interface RecordInspectorTab {
  value: string;
  label: string;
  /** Real number from the record. Sets in mono, dim — the label is the target. */
  count?: number;
  content: React.ReactNode;
}

export interface RecordInspectorProps {
  /** What this record is, in the record's own vocabulary. Mono, dim. */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  /** Status and integrity marks. Kept to what the reader would act on. */
  badges?: React.ReactNode;
  tabs: RecordInspectorTab[];
  value?: string;
  onChange?: (value: string) => void;
  /** One trailing control — a copy link, an escalation to the drawer. */
  action?: React.ReactNode;
  className?: string;
}

export const RecordInspector: React.FC<RecordInspectorProps> = ({
  eyebrow,
  title,
  badges,
  tabs,
  value,
  onChange,
  action,
  className,
}) => {
  const [internal, setInternal] = React.useState(tabs[0]?.value ?? '');
  const active = value ?? internal;
  // A record that has no tab for the one you were reading falls back to its
  // first rather than rendering nothing — switching rows must never blank the rail.
  const current = tabs.find((tab) => tab.value === active) ?? tabs[0];

  const select = (next: string) => {
    setInternal(next);
    onChange?.(next);
  };

  return (
    <section className={cn('min-w-0', className)} aria-label="Selected record">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {eyebrow && (
            <p className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              {eyebrow}
            </p>
          )}
          <h3 className="mt-0.5 break-words text-[13px] font-semibold text-foreground">{title}</h3>
        </div>
        {action}
      </div>

      {badges && <div className="mt-2 flex flex-wrap items-center gap-2">{badges}</div>}

      {tabs.length > 1 && (
        <div
          role="tablist"
          aria-label="Record detail"
          className="mt-3 flex gap-4 overflow-x-auto border-b border-border"
        >
          {tabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={current?.value === tab.value}
              onClick={() => select(tab.value)}
              className={cn(
                'shrink-0 border-b-2 pb-1.5 text-[11px] font-semibold',
                current?.value === tab.value
                  ? 'border-b-foreground text-foreground'
                  : 'border-b-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
              {typeof tab.count === 'number' && (
                <span className="ml-1.5 font-mono text-[10px] font-normal text-muted-foreground">
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 min-w-0" role="tabpanel">
        {current?.content}
      </div>
    </section>
  );
};
