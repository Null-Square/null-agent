import React, { useEffect, useState } from 'react';
import { Menu, X } from 'lucide-react';

import { cn } from '../cn';
import { AppRail, type AppRailProps } from './AppRail';

/**
 * AppShell — the rail, the page beside it, and the phone.
 *
 * The rail is fixed, so the page has to reserve its collapsed width rather than
 * flow under it; every service that hand-rolled a shell got that padding from a
 * different number. Below the rail's breakpoint the same destinations arrive as
 * a top bar and a drawer, because a 72px column on a phone is a column of
 * nothing.
 *
 * The drawer scrim is one of the two blurs in the brand's whole budget — the
 * other is the sticky header — so it is spent here and nowhere else in the
 * shell.
 */

export interface AppShellProps extends AppRailProps {
  children: React.ReactNode;
  /** Shown in the mobile bar beside the mark. Usually the tenant name. */
  mobileTitle?: React.ReactNode;
  /** The mark in the mobile bar. Falls back to the rail's identity mark. */
  mobileMark?: React.ReactNode;
  /** Full-bleed banners that sit above the page, under the mobile bar. */
  banner?: React.ReactNode;
  mainClassName?: string;
}

export const AppShell: React.FC<AppShellProps> = ({
  children,
  mobileTitle,
  mobileMark,
  banner,
  mainClassName,
  ...rail
}) => {
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (!drawerOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [drawerOpen]);

  // A destination closes the drawer it was picked from.
  const drawerGroups = rail.groups.map((group) => ({
    ...group,
    items: group.items.map((item) => ({
      ...item,
      onSelect: item.onSelect
        ? () => {
            setDrawerOpen(false);
            item.onSelect?.();
          }
        : undefined,
    })),
  }));
  const drawerAccount = rail.account?.onSelect
    ? {
        ...rail.account,
        onSelect: () => {
          setDrawerOpen(false);
          rail.account?.onSelect?.();
        },
      }
    : rail.account;

  return (
    <div className="min-h-screen bg-background font-sans text-foreground selection:bg-primary selection:text-primary-foreground">
      <AppRail {...rail} />

      <header className="fixed inset-x-0 top-0 z-[150] flex h-14 items-center justify-between border-b border-border bg-background/90 px-3 backdrop-blur-xl lg:hidden">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          className="p-2 text-muted-foreground transition-colors hover:text-foreground"
        >
          <Menu size={20} strokeWidth={2.5} />
        </button>
        <div className="flex items-center gap-2 overflow-hidden">
          {mobileMark ?? rail.identity?.mark}
          <span className="max-w-[150px] truncate text-xs font-bold uppercase tracking-widest">
            {mobileTitle ?? rail.identity?.name}
          </span>
        </div>
        {/* Holds the title centred where the mode toggle stood. The product is
            dark only (toggle removed on 2026-10-02 at the owner's request; light
            styles kept). w-9 matches the menu button. */}
        <span aria-hidden className="w-9" />
      </header>

      {drawerOpen ? (
        <div className="fixed inset-0 z-[170] lg:hidden">
          {/* The scrim is decoration with a shortcut on it: Escape and the
              close button are the accessible ways out, so a second control
              named "Close menu" would only duplicate them. */}
          <div
            aria-hidden
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-black/55 backdrop-blur-[5px]"
          />
          <div className="relative flex h-full">
            <AppRail {...rail} groups={drawerGroups} account={drawerAccount} variant="panel" />
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setDrawerOpen(false)}
              className="absolute right-0 top-0 -mr-11 mt-3 p-2 text-muted-foreground transition-colors hover:text-foreground"
            >
              <X size={20} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      ) : null}

      {/* The rail is fixed, so the page reserves its collapsed width. The
          literal has to stay literal — Tailwind scans source text, so an
          interpolated `lg:pl-[${RAIL_COLLAPSED_WIDTH}px]` generates no rule. */}
      <main
        className={cn('relative flex min-h-screen flex-col overflow-x-hidden pt-14 lg:pl-[72px] lg:pt-0', mainClassName)}
      >
        {banner}
        {children}
      </main>
    </div>
  );
};
