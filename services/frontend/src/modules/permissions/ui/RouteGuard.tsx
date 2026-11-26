import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Lock } from "lucide-react";
import { useOrgPermissions } from "./PermissionsProvider";

type RouteGuardProps = {
  capability?: string;
  /** Render if user has any of these. */
  anyOf?: string[];
  children: ReactNode;
};

/**
 * Render the route's element only if the active user holds the capability.
 * For direct URL access to a route the user can't use, shows an inline
 * "no access" screen instead of letting the page render and 403 on every action.
 *
 * Permissions still loading? Render children — `useOrgPermissions().has()` returns
 * false during load, but rendering a flash of access-denied while the permissions
 * fetch resolves is worse UX than letting the page mount briefly. Action-level
 * `CapabilityButton`/`PermissionGate` keep destructive controls disabled in
 * either case.
 */
export function RouteGuard({ capability, anyOf, children }: RouteGuardProps) {
  const perms = useOrgPermissions();

  // Don't show "no access" while we're still loading the snapshot.
  if (perms.isLoading) return <>{children}</>;

  const allowed =
    (capability ? perms.has(capability) : true) &&
    (anyOf ? perms.hasAny(anyOf) : true);

  if (allowed) return <>{children}</>;

  return (
    <div className="relative flex flex-col w-full h-full min-h-[70vh] items-center justify-center p-4">
      {/* Background radial gradient & grid pattern overlay */}
      <div className="absolute inset-0 bg-background/22 pointer-events-none" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,var(--color-radial-accent),transparent_36%),radial-gradient(circle_at_18%_22%,var(--color-radial-accent-soft),transparent_28%)] pointer-events-none" />
      <div
        className="absolute inset-0 z-0 opacity-[0.05] pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(var(--color-border) 1px, transparent 1px), linear-gradient(90deg, var(--color-border) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      <div className="relative w-full max-w-3xl border border-border/40 bg-background/42 overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-500 z-10">
        <div
          className="absolute inset-0 z-0 opacity-[0.05] pointer-events-none"
          style={{
            backgroundImage:
              'linear-gradient(var(--color-border) 1px, transparent 1px), linear-gradient(90deg, var(--color-border) 1px, transparent 1px)',
            backgroundSize: '40px 40px',
          }}
        />

        <div className="relative z-10 p-8 md:p-12 flex flex-col gap-8">
          <div className="flex flex-col md:flex-row gap-10 md:gap-16 items-start justify-between">
            <div className="flex-1 space-y-6">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-destructive/10 border border-destructive/20 text-destructive text-[10px] uppercase font-bold tracking-widest font-mono">
                <Lock className="w-3.5 h-3.5" /> Access Restricted
              </div>
              <div className="space-y-3">
                <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground leading-tight uppercase font-mono">
                  Access Restricted
                </h2>
              </div>
              <div className="text-sm font-mono text-muted-foreground leading-relaxed uppercase tracking-wider border-l-2 border-primary/50 pl-4 py-1">
                {capability ? (
                  <>
                    The <span className="font-mono text-foreground font-bold">{capability}</span>{" "}
                    capability is required.
                  </>
                ) : (
                  <>Your role doesn't include any of the required capabilities.</>
                )}{" "}
                Ask an organization admin to update your role.
              </div>
            </div>

            <div className="w-full md:w-[240px] flex flex-col gap-3 shrink-0">
              <Link
                to="/dashboard"
                className="w-full h-12 text-xs uppercase tracking-widest bg-primary text-primary-foreground font-black transition-all inline-flex items-center justify-center"
              >
                Back to dashboard
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
