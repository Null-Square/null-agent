import type { ReactNode } from "react";
import { useOrgPermissions } from "./PermissionsProvider";

type PermissionGateProps = {
  capability?: string;
  /** Render if user has any of these. Combined with `capability` via AND. */
  anyOf?: string[];
  /** Render only if user has all of these. Combined with `capability` via AND. */
  allOf?: string[];
  children: ReactNode;
  /** What to render when denied. Null hides completely. */
  fallback?: ReactNode;
};

/**
 * Render `children` only if the active user holds the required capability/ies.
 * Use for inline action buttons, section panels, nav items, anywhere the UI
 * should disappear when the role can't perform it.
 *
 * For a "page-level" guard with an explanatory access-denied screen, use
 * `RouteGuard` from the same module.
 */
export function PermissionGate({
  capability,
  anyOf,
  allOf,
  children,
  fallback = null,
}: PermissionGateProps) {
  const perms = useOrgPermissions();
  const allowed =
    (capability ? perms.has(capability) : true) &&
    (anyOf ? perms.hasAny(anyOf) : true) &&
    (allOf ? perms.hasAll(allOf) : true);
  if (!allowed) return <>{fallback}</>;
  return <>{children}</>;
}
