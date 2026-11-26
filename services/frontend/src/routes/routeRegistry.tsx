import { lazy } from 'react';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { LayoutDashboard, AlertTriangle, Globe, Play, ShieldCheck } from 'lucide-react';
import type React from 'react';
import { matchPath, Navigate } from 'react-router-dom';
import type { NavGroup, NavItem } from '@shared/types/navigation';

import { HomePage } from '@modules/dashboard';
import { SetupWizard } from '@modules/onboarding';
import { Terminal } from 'lucide-react';
import {
  LegacyExposureDetailRedirect,
  LegacyFindingDetailRedirect,
} from '@shared/lib/legacyRouteRedirects';

const OnboardingPage = lazy(() => import('@/routes/Onboarding'));
const Dashboard = lazy(() => import('@/routes/Dashboard'));
const Compliance = lazy(() => import('@/routes/Compliance'));
const ComplianceControl = lazy(() => import('@/routes/ComplianceControl'));
const Chat = lazy(() => import('@/routes/Chat'));

const NotFound = lazy(() => import('@/routes/NotFound'));

// SecurityOps routes
const Risks = lazy(() => import('@/routes/Risks'));
const ExposureDetail = lazy(() => import('@/routes/ExposureDetail'));
const FindingDetail = lazy(() => import('@/routes/FindingDetail'));
const Assets = lazy(() => import('@/routes/Assets'));
const AssetDetail = lazy(() => import('@/routes/AssetDetail'));
const Runs = lazy(() => import('@/routes/Runs'));

const RunDetail = lazy(() => import('@/routes/RunDetail'));
const Workbench = lazy(() => import('@/routes/Workbench'));
const Settings = lazy(() => import('@/routes/Settings'));
const SettingsOrg = lazy(() => import('@/routes/SettingsOrg'));
const SettingsScopes = lazy(() => import('@/routes/SettingsScopes'));
const ScopeDetail = lazy(() => import('@/routes/ScopeDetail'));
const SettingsRunners = lazy(() => import('@/routes/SettingsRunners'));
const RunnerDetail = lazy(() => import('@/routes/RunnerDetail'));
const SettingsAutomations = lazy(() => import('@/routes/SettingsAutomations'));
const AutomationDetail = lazy(() => import('@/routes/AutomationDetail'));
const SettingsCredentials = lazy(() => import('@/routes/SettingsCredentials'));
const SettingsAuditLogs = lazy(() => import('@/modules/settings/ui/SettingsAuditLogs'));

export type RouteConfig = {
  id: string;
  path: string;
  element: ReactNode;
  layout?: 'sidebar' | 'blank';
  nav?: boolean;
  label?: string;
  /** A lucide icon or a brand `CellIcon` glyph — see `navGlyph`. */
  icon?: LucideIcon | React.ComponentType<{ className?: string; strokeWidth?: number }>;
  group?: string;
  order?: number;
  public?: boolean;
  /**
   * Org capability required to reach this route. When set, RouteGuard renders
   * an access-denied screen for users without the cap; the sidebar also hides
   * the nav entry. Omit for routes the person can always see (agent home, etc.).
   */
  requiredCapability?: string;
};

export const routeRegistry: RouteConfig[] = [
  // Agent-OS Routes
  { id: 'root', path: '/', element: <HomePage />, nav: true, label: 'Home', icon: Terminal, group: 'Agent', order: 0, layout: 'sidebar' },
  // Conversations are opened from the assistant panel rather than a duplicate
  // primary-navigation destination.
  { id: 'chat', path: '/chat', element: <Chat />, layout: 'sidebar' },
  { id: 'setup', path: '/setup', element: <SetupWizard />, layout: 'blank' },
  { id: 'onboarding', path: '/onboarding', element: <OnboardingPage />, layout: 'blank' },
  { id: 'dashboard', path: '/dashboard', element: <Dashboard />, nav: true, label: 'Dashboard', icon: LayoutDashboard, group: 'Operations', order: 2, requiredCapability: 'org.read' },

  // SecurityOps — Primary nav (all four org roles can read findings/assets/runs)
  { id: 'risks', path: '/risks', element: <Risks />, nav: true, label: 'Risks', icon: AlertTriangle, group: 'Operations', order: 3, requiredCapability: 'org.finding.read' },
  // Old destinations kept as redirects only — bookmarks, the product tour and
  // notification deep links all still point at them. Audit §7A.
  { id: 'risk-detail', path: '/risks/:id', element: <FindingDetail />, requiredCapability: 'org.finding.read' },
  { id: 'risk-advisory-detail', path: '/risks/advisory/:id', element: <ExposureDetail />, requiredCapability: 'org.finding.read' },
  { id: 'findings-legacy', path: '/findings', element: <Navigate to="/risks" replace />, requiredCapability: 'org.finding.read' },
  { id: 'finding-detail-legacy', path: '/findings/:id', element: <LegacyFindingDetailRedirect />, requiredCapability: 'org.finding.read' },
  { id: 'exposures', path: '/exposures', element: <Navigate to="/risks" replace />, requiredCapability: 'org.finding.read' },
  { id: 'exposure-detail-legacy', path: '/exposures/:id', element: <LegacyExposureDetailRedirect />, requiredCapability: 'org.finding.read' },
  { id: 'assets', path: '/assets', element: <Assets />, nav: true, label: 'Assets', icon: Globe, group: 'Operations', order: 5, requiredCapability: 'org.scope.read' },
  { id: 'asset-detail', path: '/assets/:id', element: <AssetDetail />, requiredCapability: 'org.scope.read' },
  // Viewer can read runs but not start them; gating starts/cancels happens on the buttons.
  { id: 'runs', path: '/runs', element: <Runs />, nav: true, label: 'Assessments', icon: Play, group: 'Operations', order: 6, requiredCapability: 'org.scope.read' },
  { id: 'risk-code-occurrence', path: '/risks/code/:occurrenceId', element: <FindingDetail />, requiredCapability: 'org.finding.read' },
  { id: 'run-detail', path: '/runs/:id', element: <RunDetail />, requiredCapability: 'org.scope.read' },
  { id: 'workbench', path: '/runs/:id/workbench', element: <Workbench />, requiredCapability: 'org.scope.read' },
  { id: 'compliance', path: '/compliance', element: <Compliance />, nav: true, label: 'Compliance', icon: ShieldCheck, group: 'Operations', order: 7, requiredCapability: 'org.scope.read' },
  { id: 'compliance-control', path: '/compliance/:frameworkKey/:controlId', element: <ComplianceControl />, requiredCapability: 'org.scope.read' },

  // SecurityOps — Settings + admin surfaces
  // Settings home + organization edit: only admins.
  { id: 'settings-home', path: '/settings', element: <Settings />, requiredCapability: 'org.settings.write' },
  { id: 'settings-org', path: '/settings/organization', element: <SettingsOrg />, requiredCapability: 'org.member.manage' },
  // Scopes: read-only for analyst/viewer; create/edit gated inside the page.
  { id: 'settings-scopes', path: '/scopes', element: <SettingsScopes />, requiredCapability: 'org.scope.read' },
  { id: 'scope-detail', path: '/scopes/:id', element: <ScopeDetail />, requiredCapability: 'org.scope.read' },
  // Runners + credentials + automations: lead/admin only.
  { id: 'settings-runners', path: '/runners', element: <SettingsRunners />, requiredCapability: 'org.runner.manage' },
  { id: 'runner-detail', path: '/runners/:id', element: <RunnerDetail />, requiredCapability: 'org.runner.manage' },
  { id: 'settings-automations', path: '/automations', element: <SettingsAutomations />, requiredCapability: 'org.automation.manage' },
  { id: 'automation-detail', path: '/automations/:id', element: <AutomationDetail />, requiredCapability: 'org.automation.manage' },
  { id: 'settings-credentials', path: '/credentials', element: <SettingsCredentials />, requiredCapability: 'org.credentials.write' },
  { id: 'settings-audit-logs', path: '/audit-logs', element: <SettingsAuditLogs />, requiredCapability: 'org.audit.read' },

  { id: 'not-found', path: '*', element: <NotFound />, public: true },
];

type NavItemWithOrder = NavItem & { order: number; group: string; requiredCapability?: string };

const toNavItems = (routes: RouteConfig[]): NavItemWithOrder[] =>
  routes
    .filter((route): route is RouteConfig & Required<Pick<RouteConfig, 'label' | 'group'>> => Boolean(route.nav && route.label && route.group))
    .map((route) => ({
      id: route.id,
      label: route.label!,
      path: route.path,
      icon: route.icon!,
      group: route.group!,
      order: route.order ?? 0,
      requiredCapability: route.requiredCapability,
    }));

export const navGroups: NavGroup[] = (() => {
  const grouped = new Map<string, NavItemWithOrder[]>();
  toNavItems(routeRegistry).forEach((item) => {
    const existing = grouped.get(item.group) ?? [];
    existing.push(item);
    grouped.set(item.group, existing);
  });

  return Array.from(grouped.entries()).map(([label, items]) => ({
    label,
    items: items
      .sort((a, b) => a.order - b.order)
      .map(({ group: _group, order: _order, ...navItem }) => navItem),
  }));
})();

/**
 * Filter nav groups down to entries the user can access. Items without a
 * `requiredCapability` are always shown; gated items appear only when the
 * predicate returns true. Groups that empty out are dropped.
 */
export const filterNavGroupsByCapability = (
  groups: NavGroup[],
  hasCapability: (cap: string) => boolean,
): NavGroup[] =>
  groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        const cap = (item as NavItem & { requiredCapability?: string }).requiredCapability;
        return !cap || hasCapability(cap);
      }),
    }))
    .filter((group) => group.items.length > 0);

export const getRouteMeta = (pathname: string): RouteConfig | undefined => {
  const matchable = routeRegistry.filter((route) => route.path !== '*');
  const match = matchable.find((route) => matchPath({ path: route.path, end: true }, pathname));
  return match ?? routeRegistry.find((route) => route.path === '*');
};


