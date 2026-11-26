/* eslint-disable react-refresh/only-export-components -- navigation config is exported for contract tests */
import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { ChevronsUpDown, Plus, Lock, Monitor } from 'lucide-react';
import { CellIcon, type CellIconName, Logo, NotificationDot, Select, SelectContent, SelectItem, SelectTrigger, Popover } from '@null-ai/design-tokens/ui';
import { useAuth, useProfile } from '@modules/auth';
import { useOrgPermissions } from '@modules/permissions';
import { useTheme } from '@shared/contexts/ThemeContext';
import { cn } from '@shared/lib/utils';
import { AssistantPanel } from '@modules/chat';
import { motion } from 'framer-motion';
import { useScope } from '@shared/contexts/ScopeContext';
import { useAttention, useMarkSeen } from '@modules/layout/api/attention';
import { useUnreadCount } from '@modules/notifications/hooks/useNotifications';
import { useNotificationStream } from '@modules/notifications/hooks/useNotificationStream';
import { useLiveDataSync } from '@shared/hooks/useLiveDataSync';
import { NotificationPanel } from '@modules/notifications/ui/NotificationPanel';
import { shouldRenderAssistantPanel } from './sidebarLayoutVisibility';

type SidebarLayoutProps = {
  children: ReactNode;
};

type NavGlyphProps = { className?: string; strokeWidth?: number; active?: boolean };

export type NavItem = {
  id: string;
  label: string;
  path: string;
  /** A lucide icon or a brand `CellIcon` glyph — see `navGlyph`. */
  icon: React.ComponentType<NavGlyphProps>;
  /**
   * Marks the route as an experimental preview feature. Renders a small
   * "PREVIEW" badge next to the nav label and is surfaced on the destination
   * page header so the user knows the surface is unstable.
   */
  preview?: boolean;
  matcher: (pathname: string) => boolean;
  /**
   * Org capability required to see this nav item. Items without one are always
   * shown (e.g. Agent, Chat — every authenticated user). Filtered against
   * `useOrgPermissions().has()` in `SidebarLayout`.
   */
  capability?: string;
};

/**
 * A brand glyph in the shape lucide icons are used in here, so a nav item can
 * carry either. `CellIcon` draws on the 11x11 matrix and has no stroke to set.
 */
export const navGlyph = (name: CellIconName) =>
  function NavGlyph({ className, active }: NavGlyphProps) {
    return (
      <CellIcon
        name={name}
        size={19}
        className={className}
        signalColor={active ? undefined : 'currentColor'}
      />
    );
  };

export const APP_NAV_ITEMS: NavItem[] = [
  {
    id: 'agent',
    label: 'Home',
    path: '/',
    icon: navGlyph('workbench'),
    matcher: (pathname) => pathname === '/',
  },
  {
    id: 'dashboard',
    label: 'Dashboard',
    path: '/dashboard',
    icon: navGlyph('dashboard'),
    matcher: (pathname) => pathname.startsWith('/dashboard'),
    capability: 'org.read',
  },
  {
    id: 'assets',
    label: 'Assets',
    path: '/assets',
    icon: navGlyph('assets'),
    matcher: (pathname) => pathname.startsWith('/assets'),
    capability: 'org.scope.read',
  },
  {
    // Findings and Exposures were one funnel rendered as two destinations —
    // and at the confirmed end, literally two records for one thing (audit
    // §7A.1). One destination; origin is a facet inside it.
    id: 'risks',
    label: 'Risks',
    path: '/risks',
    icon: navGlyph('findings'),
    matcher: (pathname) =>
      pathname.startsWith('/risks')
      || pathname.startsWith('/findings')
      || pathname.startsWith('/exposures'),
    capability: 'org.finding.read',
  },
  {
    id: 'runs',
    label: 'Assessments',
    path: '/runs',
    icon: navGlyph('runs'),
    matcher: (pathname) => pathname.startsWith('/runs'),
    capability: 'org.scope.read',
  },
  {
    id: 'compliance',
    label: 'Compliance',
    path: '/compliance',
    icon: navGlyph('compliance'),
    matcher: (pathname) => pathname.startsWith('/compliance'),
    capability: 'org.scope.read',
  },
];

const APP_CONFIG_ITEMS: NavItem[] = [
  {
    id: 'credentials',
    label: 'Credentials',
    path: '/credentials',
    icon: navGlyph('credentials'),
    matcher: (pathname) => pathname.startsWith('/credentials'),
    capability: 'org.credentials.write',
  },
  {
    id: 'automations',
    label: 'Automations',
    path: '/automations',
    icon: navGlyph('automations'),
    matcher: (pathname) => pathname.startsWith('/automations'),
    capability: 'org.automation.manage',
  },
  {
    id: 'scopes',
    label: 'Scopes',
    path: '/scopes',
    icon: navGlyph('scope'),
    matcher: (pathname) => pathname.startsWith('/scopes'),
    capability: 'org.scope.read',
  },
  {
    id: 'runners',
    label: 'Runners',
    path: '/runners',
    icon: navGlyph('runner'),
    matcher: (pathname) => pathname.startsWith('/runners'),
    capability: 'org.runner.manage',
  },
  {
    id: 'settings',
    label: 'Settings',
    path: '/settings',
    icon: navGlyph('settings'),
    matcher: (pathname) =>
      pathname === '/settings'
      || (pathname.startsWith('/settings')
        && !['scopes', 'runners', 'credentials', 'automations'].some((p) => pathname.includes(p))),
    capability: 'org.member.manage',
  },
];

const getInitials = (displayName?: string | null, email?: string | null) => {
  const source = (displayName || email || '').trim();
  if (!source) return 'OP';
  const tokens = source.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    return `${tokens[0][0]}${tokens[1][0]}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
};

export default function SidebarLayout({ children }: SidebarLayoutProps) {
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const { user } = useAuth();
  const { profile } = useProfile();
  const { activeScopeId, setActiveScopeId, scopes } = useScope();
  const permissions = useOrgPermissions();
  const notificationsActive = Boolean(user);
  const { data: unreadCount } = useUnreadCount({ enabled: notificationsActive });
  /* Counts of work waiting per destination. Gated on the owner being known,
     for the same reason the bell is, and failure resolves to `{}` so the
     sidebar renders exactly as it did before this existed. */
  const { data: attentionData } = useAttention(Boolean(user));
  const attention = attentionData ?? {};
  useNotificationStream({ enabled: notificationsActive });
  /* Mounted beside the bell because both ride the same socket, and because
     this is the one component every page is inside. */
  useLiveDataSync(notificationsActive);
  const displayUnreadCount = notificationsActive ? unreadCount ?? 0 : 0;
  const initials = getInitials(profile?.full_name, user?.email);

  const resolvedNavItems = APP_NAV_ITEMS;
  const resolvedConfigItems = APP_CONFIG_ITEMS;
  const [isHovered, setIsHovered] = useState(false);
  const [isScopeSelectOpen, setIsScopeSelectOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1200
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      setIsMobile(window.innerWidth < 768);
      setWindowWidth(window.innerWidth);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const isExpanded = useMemo(() => !isMobile && (isHovered || isScopeSelectOpen), [isHovered, isMobile, isScopeSelectOpen]);
  const isDesktop = windowWidth >= 1024;
  // The app keeps the desktop-only notice below 1024.
  const showLockout = !isDesktop;

  /* ── ARRIVING AT A DESTINATION IS WHAT CLEARS ITS MARK ──
     One effect here rather than a call in each page, because there are four
     render paths into these destinations and a page-side hook would have to be
     remembered in every one of them. The nav knows where you are; it is the
     right place to say you have been.

     ── IT REPORTS THE ARRIVAL, NOT THE COUNT ──
     The obvious version — "if this destination has a count, clear it" — makes
     the count both the trigger and the thing the write changes, and that shape
     loops the instant a write does not stick: the count comes back, the
     condition is satisfied again, it fires again. It did, 1,927 times in
     fifteen minutes, and rate-limited every other endpoint in the app.

     So the trigger is the ARRIVAL. A navigation is a fact the write cannot
     alter, so there is no feedback path and nothing to brake. The condition is
     only whether this destination is one the server tracks — a stable property,
     not a changing value. */
  const { mutate: markSeen } = useMarkSeen();
  const markSeenRef = useRef(markSeen);
  useEffect(() => {
    markSeenRef.current = markSeen;
  }, [markSeen]);
  const activeNavItemId = useMemo(
    () =>
      [...resolvedNavItems, ...resolvedConfigItems].find((item) =>
        item.matcher(location.pathname),
      )?.id,
    [resolvedNavItems, resolvedConfigItems, location.pathname],
  );
  /* Which destinations the server keeps a watermark for. PRESENCE, never the
     value — that is what makes this safe to depend on. */
  const isTracked = Boolean(
    activeNavItemId && attentionData && activeNavItemId in attentionData,
  );

  useEffect(() => {
    if (!activeNavItemId || !isTracked) return;
    markSeenRef.current(activeNavItemId);
    /* `markSeen` is deliberately not a dependency. It is the ACTION, not a
       trigger — the only things that should cause a report are the facts of
       arrival above. React Query's `mutate` happens to be referentially stable,
       but an effect that fires again whenever its own mutator is re-created is
       one refactor away from the loop this design exists to rule out, so it
       does not depend on that being true.
       eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [location.pathname, activeNavItemId, isTracked]);

  return (
    <div className="min-h-screen bg-background text-foreground font-mono selection:bg-foreground selection:text-background">
      {isDesktop && (
        <motion.aside
          initial={false}
          animate={{ width: isExpanded ? 240 : 72 }}
          transition={{ type: 'tween', ease: 'easeInOut', duration: 0.3 }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          className="fixed inset-y-0 left-0 z-[160] hidden border-r border-border bg-background lg:flex lg:flex-col"
        >
          {/* HEADER / ORG & SCOPE SELECTOR */}
          <div className="border-b border-border">
              <Select
                  value={activeScopeId ?? ''}
                  onValueChange={(value) => setActiveScopeId(value)}
                  onOpenChange={setIsScopeSelectOpen}
              >
                  <SelectTrigger
                      data-tour="scope-selector"
                      className={cn(
                          "w-full h-[72px] border-none bg-transparent hover:bg-muted/10 transition-all duration-300 px-6 justify-between rounded-none group/org",
                          !isExpanded && "px-0 justify-center"
                      )}
                  >
                      <div className="flex items-center gap-3 overflow-hidden">
                          <Logo className="h-8 w-8 object-contain shrink-0" />
                          {isExpanded && (
                              <div className="flex flex-col items-start truncate overflow-hidden">
                                  <span className="max-w-[140px] truncate text-sm font-semibold">
                                      {activeScopeId ? scopes.find(s => s.id === activeScopeId)?.name : 'NULLSQUARE'}
                                  </span>
                              </div>
                          )}
                      </div>
                      {isExpanded && <ChevronsUpDown className="h-4 w-4 text-muted-foreground opacity-50 group-hover/org:opacity-100 transition-opacity" />}
                  </SelectTrigger>
                  <SelectContent className="w-[240px] border border-border bg-background p-1.5">
                      <div className="px-3 py-2 border-b border-border/10 mb-1.5">
                          <p className="text-xs text-muted-foreground">Scopes</p>
                      </div>
                      {scopes.map((scope) => (
                          <SelectItem key={scope.id} value={scope.id} className="focus:bg-primary/10 focus:text-primary mb-1 cursor-pointer py-3 pl-10 pr-4 last:mb-0">
                               <div className="flex flex-col">
                                   <span className="font-bold text-xs uppercase tracking-tight">{scope.name}</span>
                                   <span className="text-xs text-muted-foreground">Administrator</span>
                               </div>
                          </SelectItem>
                      ))}
                      <div className="border-t border-border/10 mt-1.5 pt-1.5">
                          <Link
                              to="/scopes"
                              className="flex items-center gap-2 px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                          >
                               <Plus className="w-4 h-4 text-muted-foreground border border-border p-0.5" />
                               Create Scope
                          </Link>
                      </div>
                  </SelectContent>
              </Select>
          </div>

          {/* NAVIGATION */}
          <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-0 pt-4 custom-scrollbar">
            <div
              className={cn(
                'overflow-hidden whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground transition-all duration-200',
                isExpanded ? 'mx-6 mb-2 max-h-4 opacity-100' : 'mx-4 mb-0 max-h-0 opacity-0',
              )}
            >
              Operate
            </div>
            {/* Operations Group */}
            {resolvedNavItems.map((item) => {
              const Icon = item.icon;
              const active = item.matcher(location.pathname);
              const isLocked = Boolean(item.capability && !permissions.isLoading && !permissions.has(item.capability));
              const itemClasses = cn(
                'relative flex h-12 items-center text-sm font-medium transition-colors duration-200',
                isExpanded ? 'w-full px-6' : 'w-full justify-center px-0',
                active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              );
              /* ── WHAT IS WAITING BEHIND THIS DESTINATION ──
                 A count of things that need the person, not of things that
                 happened — see `useAttention`. Suppressed when the item is
                 locked: telling somebody there are four confirmed findings
                 behind a door they cannot open is a disclosure and a taunt. */
              const waiting = isLocked ? 0 : (attention[item.id] ?? 0);
              const itemContent = (
                <>
                  {active ? (
                    <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-primary" />
                  ) : null}
                  {/* The glyph carries the mark when the rail is collapsed,
                      because the label beside it is literally `w-0` there — and
                      collapsed is exactly when a person is scanning rather than
                      reading. */}
                  <span className="relative shrink-0">
                    <Icon className="h-[19px] w-[19px] shrink-0" active={active} />
                    {waiting > 0 && !isExpanded ? (
                      <NotificationDot
                        size="sm"
                        alert
                        className="absolute -right-1 -top-1 border border-background"
                      />
                    ) : null}
                  </span>
                  <div className={cn(
                      "overflow-hidden whitespace-nowrap transition-all duration-200 ease-in-out",
                      isExpanded ? "w-auto opacity-100 ml-4 max-w-[160px]" : "w-0 opacity-0 ml-0 max-w-0"
                  )}>
                    <div className="flex items-center gap-2">
                      <span>{item.label}</span>
                      {item.preview ? (
                        <span className="border border-border px-1.5 py-px text-[10px] text-muted-foreground">
                          Preview
                        </span>
                      ) : null}
                      {/* Locked stays legible and says why with the glyph;
                          dimming it to near-invisible reads as broken. */}
                      {isLocked ? <Lock className="h-3.5 w-3.5 text-muted-foreground" /> : null}
                      {/* Expanded there is room for the number, and the number
                          is the useful form: "3 findings" is a decision, "some
                          findings" is a prompt to go and count them. */}
                      {waiting > 0 ? <NotificationDot count={waiting} alert /> : null}
                    </div>
                  </div>
                </>
              );

              return (
                <NavLink
                  key={item.id}
                  to={item.path}
                  title={item.label}
                  aria-label={item.label}
                  data-tour={`nav-${item.id}`}
                  data-locked={isLocked ? 'true' : 'false'}
                  className={itemClasses}
                >
                  {itemContent}
                </NavLink>
              );
            })}

            {/* The seam between the work and the setup. Expanded, it names
                itself in the brand's section-kicker idiom; collapsed, there is
                no room to read a label, so it stays a hairline. */}
            <div
              className={cn(
                'mt-6 transition-all duration-200',
                isExpanded ? 'mx-6' : 'mx-4',
              )}
            >
              <div className="border-t border-border" />
              <div
                className={cn(
                  'overflow-hidden whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground transition-all duration-200',
                  isExpanded ? 'mt-4 max-h-4 opacity-100' : 'mt-0 max-h-0 opacity-0',
                )}
              >
                Setup
              </div>
            </div>
            <div className="mb-2" />

            {/* Configuration Group */}
            {resolvedConfigItems.map((item) => {
              const Icon = item.icon;
              const active = item.matcher(location.pathname);
              const isLocked = Boolean(item.capability && !permissions.isLoading && !permissions.has(item.capability));
              const itemClasses = cn(
                'relative flex h-12 items-center text-sm font-medium transition-colors duration-200',
                isExpanded ? 'w-full px-6' : 'w-full justify-center px-0',
                active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              );
              /* ── WHAT IS WAITING BEHIND THIS DESTINATION ──
                 A count of things that need the person, not of things that
                 happened — see `useAttention`. Suppressed when the item is
                 locked: telling somebody there are four confirmed findings
                 behind a door they cannot open is a disclosure and a taunt. */
              const waiting = isLocked ? 0 : (attention[item.id] ?? 0);
              const itemContent = (
                <>
                  {active ? (
                    <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-primary" />
                  ) : null}
                  {/* The glyph carries the mark when the rail is collapsed,
                      because the label beside it is literally `w-0` there — and
                      collapsed is exactly when a person is scanning rather than
                      reading. */}
                  <span className="relative shrink-0">
                    <Icon className="h-[19px] w-[19px] shrink-0" active={active} />
                    {waiting > 0 && !isExpanded ? (
                      <NotificationDot
                        size="sm"
                        alert
                        className="absolute -right-1 -top-1 border border-background"
                      />
                    ) : null}
                  </span>
                  <div className={cn(
                      "overflow-hidden whitespace-nowrap transition-all duration-200 ease-in-out",
                      isExpanded ? "w-auto opacity-100 ml-4 max-w-[160px]" : "w-0 opacity-0 ml-0 max-w-0"
                  )}>
                    <div className="flex items-center gap-2">
                      <span>{item.label}</span>
                      {item.preview ? (
                        <span className="border border-border px-1.5 py-px text-[10px] text-muted-foreground">
                          Preview
                        </span>
                      ) : null}
                      {/* Locked stays legible and says why with the glyph;
                          dimming it to near-invisible reads as broken. */}
                      {isLocked ? <Lock className="h-3.5 w-3.5 text-muted-foreground" /> : null}
                      {/* Expanded there is room for the number, and the number
                          is the useful form: "3 findings" is a decision, "some
                          findings" is a prompt to go and count them. */}
                      {waiting > 0 ? <NotificationDot count={waiting} alert /> : null}
                    </div>
                  </div>
                </>
              );

              return (
                <NavLink
                  key={item.id}
                  to={item.path}
                  title={item.label}
                  aria-label={item.label}
                  data-tour={`nav-${item.id}`}
                  data-locked={isLocked ? 'true' : 'false'}
                  className={itemClasses}
                >
                  {itemContent}
                </NavLink>
              );
            })}
          </nav>

          {/* FOOTER / PROFILE */}
          <div className="mt-auto border-t border-border">
            {/* CONTROL BAR */}
            <div className={cn(
               "flex items-center border-b border-border transition-all duration-200",
               isExpanded ? "h-10 justify-between px-4" : "h-10 justify-center px-0"
            )}>
               {/* THEME TOGGLE */}
               <button
                  onClick={toggleTheme}
                  className="p-1.5 text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
                  title={theme === 'dark' ? "Switch to Light Mode" : "Switch to Dark Mode"}
               >
                  {/* icons.html: sun and moon are the one control that carries a
                      CellIcon — they name the two modes rather than an action. Never
                      below 18px, which is why they are not sized to the dock glyphs. */}
                  <CellIcon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
               </button>

               {/* NOTIFICATIONS */}
               {notificationsActive ? (
                 <Popover
                   position="top-left"
                   trigger={
                      <div
                        className="relative p-1.5 text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
                        title="Notifications"
                      >
                        <CellIcon name="notifications" size={15} />
                        {displayUnreadCount > 0 && (
                          <span className="absolute right-1 top-1 h-1.5 w-1.5 bg-primary ns-attention" />
                        )}
                      </div>
                   }
                   content={({ close }) => <NotificationPanel onClose={close} />}
                 />
               ) : null}
            </div>

            <div
              className={cn(
                'flex items-center h-[64px] bg-background text-foreground',
                isExpanded ? 'px-5' : 'justify-center px-0'
              )}
              title="Profile"
              aria-label="Profile"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center border border-border text-xs font-semibold text-muted-foreground">
                  {initials}
              </div>

              <div className={cn(
                  "overflow-hidden whitespace-nowrap transition-all duration-300 ease-in-out flex flex-col justify-center",
                  isExpanded ? "w-auto opacity-100 ml-3 max-w-[160px]" : "w-0 opacity-0 ml-0 max-w-0"
              )}>
                  <p className="text-xs font-bold uppercase truncate leading-none mb-1">
                    {profile?.full_name || 'OPERATOR'}
                  </p>
                  <p className="text-[10px] text-muted-foreground truncate uppercase leading-none">
                    {user?.email || 'SYSTEM'}
                  </p>
              </div>
            </div>
          </div>
        </motion.aside>
      )}

      <main className={cn(
        "min-h-screen bg-background relative overflow-x-hidden transition-all duration-300 flex flex-col",
        isDesktop ? "lg:pl-[72px]" : "pl-0",
      )}>
        {isDesktop && <div className="hidden lg:block fixed top-0 left-[72px] right-0 h-px bg-border/40 z-40 pointer-events-none" />}

        {showLockout ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-background relative z-50">
             <div className="mb-8 flex h-16 w-16 items-center justify-center border border-border">
                <Monitor className="w-8 h-8 text-primary" />
             </div>
             <h2 className="text-2xl font-bold uppercase tracking-tight text-foreground mb-4">
                Available on desktop only
             </h2>
             <p className="text-muted-foreground text-sm max-w-sm leading-relaxed">
                Security work is sensitive, so the NullSquare platform can only be used on a full-screen desktop device. Please switch to a larger screen to continue.
             </p>
          </div>
        ) : (
          children
        )}
      </main>

      {shouldRenderAssistantPanel(location.pathname, isDesktop, showLockout) ? <AssistantPanel /> : null}

    </div>
  );
}
