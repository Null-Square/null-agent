import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@modules/auth";
import { authClient } from "@modules/auth/api/authClient";
import { useBootScreen } from '@null-ai/design-tokens/ui';

type SetupState = 'checking' | 'setup_pending' | 'ready' | 'error';

/**
 * The local owner is always signed in, so the only question here is whether setup is done:
 * no usable scope yet sends the person to /setup, and a finished setup leaves /setup for home.
 */
export const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, loading } = useAuth();
  const location = useLocation();
  const setupPath = location.pathname.startsWith('/onboarding') || location.pathname.startsWith('/setup');
  const [setupState, setSetupState] = useState<SetupState>('checking');

  useEffect(() => {
    let cancelled = false;

    if (!user || loading) {
      setSetupState('checking');
      return () => {
        cancelled = true;
      };
    }

    setSetupState('checking');

    void (async () => {
      try {
        const { data, error } = await authClient.getSetupStatus();
        if (cancelled) return;
        if (error) {
          setSetupState('error');
          return;
        }

        setSetupState(data?.setup_required ? 'setup_pending' : 'ready');
      } catch {
        if (!cancelled) setSetupState('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, loading, setupPath]);

  /* Two separate stages of the same boot, so two keys — the screen must not
     blink in the gap where the owner has resolved and the setup check has not
     started. */
  useBootScreen(loading, 'auth');
  useBootScreen(!loading && Boolean(user) && setupState === 'checking', 'setup-check');

  if (loading) return null;

  /* The backend answers as the local owner; no owner means it could not be
     reached, and the page shows what it can rather than a sign-in that does
     not exist. */
  if (!user) return <>{children}</>;

  if (setupState === 'checking') return null;

  if (setupState === 'setup_pending' && !setupPath) {
    return <Navigate to="/setup" replace />;
  }

  if (setupState === 'ready' && setupPath) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};

export default ProtectedRoute;
