import React, { useState } from 'react';
import { motion } from 'framer-motion';

import { cn } from '../cn';
import { CellIcon, type CellIconName } from '../CellIcon';
import { useTheme } from '../theme/ThemeProvider';

/**
 * AppRail — the frame around every page, for every service.
 *
 * Product kit, "The shell": a rail that expands on hover, carrying the same
 * three things in the same order — the identity block, the destinations, and a
 * utility group that leads with the account. Nothing else earns a permanent
 * place on screen.
 *
 * Destinations are named by `CellIcon`, never by stroke glyphs: a nav item
 * names a place, which is exactly what the icon set is for, and the lit cell in
 * the current page's mark carries the active state.
 *
 * It is deliberately router-agnostic: drive it with link-shaped items through
 * `href`, or with `onSelect` where there is no router.
 */

export const RAIL_COLLAPSED_WIDTH = 72;
export const RAIL_EXPANDED_WIDTH = 240;

export interface AppRailItem {
  id: string;
  label: string;
  icon: CellIconName;
  active?: boolean;
  /** Visible and glyphed, but not reachable — a locked route says it is locked. */
  locked?: boolean;
  disabled?: boolean;
  preview?: boolean;
  href?: string;
  onSelect?: () => void;
}

export interface AppRailGroup {
  /** Section kicker, shown only while expanded — "Operate", "Setup". */
  label?: string;
  items: AppRailItem[];
}

export interface AppRailIdentity {
  /** The tenant, scope, or workspace this rail is showing. */
  name: React.ReactNode;
  meta?: React.ReactNode;
  /** The mark beside it. A `Logo`, usually. */
  mark?: React.ReactNode;
  onSelect?: () => void;
}

export interface AppRailAccount {
  name: React.ReactNode;
  meta?: React.ReactNode;
  /** Two letters at most. Derived by the caller — it owns the name. */
  initials?: string;
  onSelect?: () => void;
}

export interface AppRailProps {
  identity?: AppRailIdentity;
  groups: AppRailGroup[];
  account?: AppRailAccount;
  /**
   * The utility group, after the account and before the mode toggle. Icon
   * buttons only — `railUtilityClass` gives them the rail's own treatment.
   */
  utility?: React.ReactNode;
  /** Renders as a static panel instead of a fixed, hover-expanding rail. */
  variant?: 'fixed' | 'panel';
  className?: string;
  'aria-label'?: string;
}

/** The rail's own icon-button treatment, for anything passed to `utility`. */
export const railUtilityClass =
  'relative flex h-9 w-9 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

const RailItem: React.FC<{ item: AppRailItem; expanded: boolean }> = ({ item, expanded }) => {
  const classes = cn(
    'relative flex h-12 items-center text-sm font-medium transition-colors duration-200',
    expanded ? 'w-full px-6' : 'w-full justify-center px-0',
    item.active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
    item.disabled && 'cursor-not-allowed hover:text-muted-foreground',
  );

  const content = (
    <>
      {item.active ? <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-primary" /> : null}
      <CellIcon
        name={item.icon}
        size={19}
        className="shrink-0"
        signalColor={item.active ? undefined : 'currentColor'}
      />
      <div
        className={cn(
          'overflow-hidden whitespace-nowrap transition-all duration-200 ease-in-out',
          expanded ? 'ml-4 w-auto max-w-[160px] opacity-100' : 'ml-0 w-0 max-w-0 opacity-0',
        )}
      >
        <div className="flex items-center gap-2">
          <span>{item.label}</span>
          {item.preview ? (
            <span className="border border-border px-1.5 py-px text-[10px] text-muted-foreground">Preview</span>
          ) : null}
          {/* Locked stays legible and says why with the glyph; dimming it to
              near-invisible reads as broken. */}
          {item.locked ? <CellIcon name="credentials" size={13} className="text-muted-foreground" /> : null}
        </div>
      </div>
    </>
  );

  const shared = {
    title: item.label,
    'aria-label': item.label,
    'data-nav': item.id,
    'data-locked': item.locked ? 'true' : 'false',
    'aria-current': item.active ? ('page' as const) : undefined,
    className: classes,
  };

  if (item.href && !item.disabled) {
    return (
      <a href={item.href} {...shared}>
        {content}
      </a>
    );
  }

  return (
    <button type="button" disabled={item.disabled} onClick={item.onSelect} {...shared}>
      {content}
    </button>
  );
};

export const AppRail: React.FC<AppRailProps> = ({
  identity,
  groups,
  account,
  utility,
  variant = 'fixed',
  className,
  'aria-label': ariaLabel = 'Primary',
}) => {
  const { theme, toggleTheme } = useTheme();
  const [hovered, setHovered] = useState(false);
  // A panel lives inside a drawer, which has no hover state and no reason to collapse.
  const expanded = variant === 'panel' || hovered;

  const body = (
    <>
      {identity ? (
        <div className="border-b border-border">
          <button
            type="button"
            onClick={identity.onSelect}
            disabled={!identity.onSelect}
            className={cn(
              'flex h-[72px] w-full items-center gap-3 overflow-hidden transition-colors',
              identity.onSelect ? 'hover:bg-muted/10' : 'cursor-default',
              expanded ? 'px-6' : 'justify-center px-0',
            )}
          >
            {identity.mark}
            {expanded ? (
              <span className="flex min-w-0 flex-col items-start truncate text-left">
                <span className="max-w-[140px] truncate text-sm font-semibold text-foreground">{identity.name}</span>
                {identity.meta ? (
                  <span className="mt-0.5 w-fit truncate text-xs text-muted-foreground">{identity.meta}</span>
                ) : null}
              </span>
            ) : null}
          </button>
        </div>
      ) : null}

      <nav aria-label={ariaLabel} className="custom-scrollbar flex flex-1 flex-col gap-1 overflow-y-auto pt-4">
        {groups.map((group, groupIndex) => (
          <React.Fragment key={group.label ?? `group-${groupIndex}`}>
            {/* The seam between one group and the next. Expanded, the group
                names itself in the brand's section-kicker idiom; collapsed,
                there is no room to read a label, so it stays a hairline. */}
            {groupIndex > 0 ? (
              <div className={cn('mb-2 mt-6 transition-all duration-200', expanded ? 'mx-6' : 'mx-4')}>
                <div className="border-t border-border" />
              </div>
            ) : null}
            {group.label ? (
              <div
                className={cn(
                  'overflow-hidden whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground transition-all duration-200',
                  expanded ? 'mx-6 mb-2 max-h-4 opacity-100' : 'mx-4 mb-0 max-h-0 opacity-0',
                )}
              >
                {group.label}
              </div>
            ) : null}
            {group.items.map((item) => (
              <RailItem key={item.id} item={item} expanded={expanded} />
            ))}
          </React.Fragment>
        ))}
      </nav>

      <div className="mt-auto border-t border-border">
        {/* The utility group leads with the account, then whatever the service
            adds, then the mode toggle. */}
        <div
          className={cn(
            'flex h-10 items-center border-b border-border transition-all duration-200',
            expanded ? 'justify-start px-2' : 'justify-center px-0',
          )}
        >
          {utility}
          <button
            type="button"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className={cn(railUtilityClass, expanded && 'ml-auto')}
          >
            {/* icons.html: sun and moon are the one control that carries a
                CellIcon — they name the two modes rather than an action. Never
                below 18px, which is why they are not sized to the rail glyphs. */}
            <CellIcon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
          </button>
        </div>

        {account ? (
          <button
            type="button"
            onClick={account.onSelect}
            disabled={!account.onSelect}
            title="Account"
            aria-label="Account"
            className={cn(
              'group flex h-[64px] w-full items-center bg-background text-foreground transition-colors duration-300',
              account.onSelect ? 'hover:bg-muted/60' : 'cursor-default',
              expanded ? 'px-5' : 'justify-center px-0',
            )}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-border text-xs font-semibold text-muted-foreground transition-colors group-hover:text-foreground">
              {account.initials}
            </span>
            <span
              className={cn(
                'flex flex-col justify-center overflow-hidden whitespace-nowrap text-left transition-all duration-300 ease-in-out',
                expanded ? 'ml-3 w-auto max-w-[160px] opacity-100' : 'ml-0 w-0 max-w-0 opacity-0',
              )}
            >
              <span className="mb-1 truncate text-xs font-bold uppercase leading-none">{account.name}</span>
              {account.meta ? (
                <span className="truncate text-[10px] uppercase leading-none text-muted-foreground">
                  {account.meta}
                </span>
              ) : null}
            </span>
          </button>
        ) : null}
      </div>
    </>
  );

  if (variant === 'panel') {
    return (
      <div className={cn('flex h-full w-[260px] flex-col border-r border-border bg-background', className)}>
        {body}
      </div>
    );
  }

  return (
    <motion.aside
      initial={false}
      animate={{ width: expanded ? RAIL_EXPANDED_WIDTH : RAIL_COLLAPSED_WIDTH }}
      transition={{ type: 'tween', ease: 'easeInOut', duration: 0.3 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        'fixed inset-y-0 left-0 z-[160] hidden border-r border-border bg-background lg:flex lg:flex-col',
        className,
      )}
    >
      {body}
    </motion.aside>
  );
};
