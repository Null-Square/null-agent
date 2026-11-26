import React from 'react';

import { CellIcon, type CellIconName } from '../CellIcon';
import { ListPageShell } from './ListPageShell';
import { StatusTabs } from './StatusTabs';

/**
 * TabbedListShell — one subject, several sections, one place in the menu.
 *
 * The shared answer to a family of pages that each earned their own menu entry
 * without earning their own audience: six partner pages behind one capability,
 * six catalogue pages behind another. Where no role can see one section without
 * seeing all of them, they are not destinations — they are one destination and
 * a tab strip.
 *
 * Each section stays its **own route and its own component**, so deep links,
 * back-links and per-section tests keep working, and the tab strip is genuine
 * navigation rather than a state machine hidden inside one enormous file.
 *
 * The strip sits above the three bands, never between them: it chooses the
 * subject, and the bands then describe that subject.
 *
 * `tone="bone"` is deliberate and not the StatusTabs default. The kit's rule is
 * that the verb owns the yellow — a filter strip on a plain list page can take
 * the signal because nothing competes with it, but these tabs replaced menu
 * entries, and a section underneath them may carry a real primary action
 * ("Add model"). Navigation is chrome, and chrome never takes the signal, so a
 * reader can always trust that the one yellow thing on the page is the thing
 * that acts.
 */

export interface TabbedListSection {
  /** Stable key, also the value StatusTabs switches on. */
  value: string;
  label: string;
  /** Where the section lives. Sections are routes, not local state. */
  href: string;
  /** Sections are places, so they take a glyph — see StatusTabItem.icon. */
  icon?: CellIconName;
  count?: number;
  /** Shown under the title while this section is active. */
  subtitle?: React.ReactNode;
}

export interface TabbedListShellProps {
  /** The subject shared by every section — "Registry", "Partners". */
  title: React.ReactNode;
  sections: TabbedListSection[];
  /** `value` of the section being shown. */
  active: string;
  /** Given the section's `href`. Keeps the router out of the kit. */
  onNavigate: (href: string) => void;
  /** The active section's primary action, if it has one. */
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export const TabbedListShell: React.FC<TabbedListShellProps> = ({
  title,
  sections,
  active,
  onNavigate,
  actions,
  children,
  className,
}) => {
  const current = sections.find((section) => section.value === active);

  return (
    <ListPageShell
      title={title}
      subtitle={current?.subtitle}
      actions={actions}
      className={className}
    >
      <StatusTabs
        className="mb-10"
        aria-label={typeof title === 'string' ? `${title} sections` : 'Sections'}
        tone="bone"
        value={active}
        onChange={(value) => {
          const next = sections.find((section) => section.value === value);
          if (next) onNavigate(next.href);
        }}
        items={sections.map((section) => ({
          value: section.value,
          label: section.label,
          count: section.count,
          icon: section.icon ? <CellIcon name={section.icon} size={15} /> : undefined,
        }))}
      />
      {children}
    </ListPageShell>
  );
};
