import { Suspense, useEffect, useRef, type ReactNode } from 'react';
import { BootScreenProvider, useBootScreen } from '@null-ai/design-tokens/ui';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@shared/lib/queryClient';
import { TooltipProvider } from '@null-ai/design-tokens/ui';
import ErrorBoundary from '@shared/ui/ErrorBoundary';
import { AppToaster } from '@shared/ui/AppToaster';
import { NavigationProvider } from '@shared/contexts/NavigationContext';
import { FeatureFlagsProvider } from '@shared/contexts/FeatureFlagsContext';
import { ThemeProvider } from '@shared/contexts/ThemeContext';
import { metrics } from '@shared/lib/metrics';
import { AuthProvider, ProtectedRoute, useAuth } from '@modules/auth';
import { SubscriptionProvider, useSubscription } from '@modules/billing';
import { SessionEventBusProvider } from '@modules/sessions';
import { SidebarLayout } from '@modules/layout';
import { ScopeProvider } from '@shared/contexts/ScopeContext';
import { TargetVerifiedCelebration } from '@modules/scopes/ui/TargetVerifiedCelebration';
import { PermissionsProvider, RouteGuard } from '@modules/permissions';
import { getRouteMeta, navGroups, routeRegistry } from '@/routes/routeRegistry';
import type { RouteConfig } from '@/routes/routeRegistry';

const AppLayout = ({ children }: { children: ReactNode }) => {
  const location = useLocation();
  const navStartRef = useRef<number>(performance.now());
  const meta = getRouteMeta(location.pathname);
  const routeLayout = meta?.layout ?? (meta?.public ? 'blank' : 'sidebar');
  const { loading: subscriptionLoading } = useSubscription();
  const booting = !meta?.public && subscriptionLoading;
  useBootScreen(booting, 'subscription');

  useEffect(() => {
    const start = performance.now();
    navStartRef.current = start;
    const handle = window.requestAnimationFrame(() => {
      metrics.trackNavigation(location.pathname, performance.now() - navStartRef.current);
    });
    return () => window.cancelAnimationFrame(handle);
  }, [location.pathname]);

  if (booting) return null;

  return (
    <>
      {routeLayout === 'sidebar' ? <SidebarLayout>{children}</SidebarLayout> : children}
      {/* Above the router on purpose: verifying a target makes DashboardPage
          swap render branches, which unmounts whichever modal asked for the
          verification. Anything holding the celebration below this point is
          destroyed by the success it is meant to announce. */}
      {!meta?.public ? <TargetVerifiedCelebration /> : null}
    </>
  );
};

const CapabilityRouteGuard = ({ route, children }: { route: RouteConfig; children: ReactNode }) => {
  if (!route.requiredCapability) return <>{children}</>;
  return <RouteGuard capability={route.requiredCapability}>{children}</RouteGuard>;
};

const queryClient = createQueryClient();

/**
 * ── ONE BOOT SCREEN, NOT A NARRATED SEQUENCE ──
 * Opening the app used to cross three different waiting states with three
 * different captions, so the first thing a person saw was text changing under
 * them. Both are the same moment to the person watching: the app is not ready
 * yet. They now render the identical screen, with no caption to change, so the
 * boot is one still image that simply ends.
 */
const LoadingFallback = () => {
  useBootScreen(true, 'route-chunk');
  return null;
};

const UserDataProviders = ({ children }: { children: ReactNode }) => {
  const { user, loading } = useAuth();
  const enabled = Boolean(user) && !loading;

  return (
    <PermissionsProvider>
      <SubscriptionProvider enabled={enabled}>
        <SessionEventBusProvider>
          <ScopeProvider enabled={enabled}>
            <NavigationProvider navGroups={navGroups}>
              <FeatureFlagsProvider>
                <TooltipProvider>{children}</TooltipProvider>
              </FeatureFlagsProvider>
            </NavigationProvider>
          </ScopeProvider>
        </SessionEventBusProvider>
      </SubscriptionProvider>
    </PermissionsProvider>
  );
};

const AppProviders = ({ children }: { children: ReactNode }) => (
  <ThemeProvider>
    <QueryClientProvider client={queryClient}>
      {/* Above every guard on purpose: the boot screen must outlive the
          handoff from one guard to the next, or its entrance animation
          replays at each stage. See `BootScreen`. */}
      <BootScreenProvider>
        <AuthProvider>
          <UserDataProviders>{children}</UserDataProviders>
        </AuthProvider>
      </BootScreenProvider>
    </QueryClientProvider>
  </ThemeProvider>
);

const App = () => (
  <ErrorBoundary>
    <BrowserRouter>
      <AppProviders>
        <AppToaster />
        <AppLayout>
          <div className="min-h-screen bg-background">
            <Suspense fallback={<LoadingFallback />}>
              <Routes>
                {routeRegistry.map((route) => {
                  const guarded = <CapabilityRouteGuard route={route}>{route.element}</CapabilityRouteGuard>;
                  return (
                    <Route
                      key={route.id}
                      path={route.path}
                      element={route.public ? guarded : <ProtectedRoute>{guarded}</ProtectedRoute>}
                    />
                  );
                })}
              </Routes>
            </Suspense>
          </div>
        </AppLayout>
      </AppProviders>
    </BrowserRouter>
  </ErrorBoundary>
);

export default App;
