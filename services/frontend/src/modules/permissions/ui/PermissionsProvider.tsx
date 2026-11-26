import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAuth } from "@modules/auth";
import { useOrgPermissionsQuery } from "../api/usePermissions";
import type { OrgPermissions } from "../api/types";

type Capability = string;

type PermissionsContextValue = {
  capabilities: Set<Capability>;
  capabilityList: Capability[];
  roleKeys: string[];
  user: OrgPermissions["user"] | null;
  /** True when the user has the capability (or every capability in the list). */
  has: (capability: Capability | Capability[]) => boolean;
  hasAny: (capabilities: Capability[]) => boolean;
  hasAll: (capabilities: Capability[]) => boolean;
  /** Highest-privilege org role the user holds, or null. */
  primaryRole: string | null;
  isLoading: boolean;
  error: Error | null;
};

const PermissionsContext = createContext<PermissionsContextValue | null>(null);

/**
 * Permission ranking used to derive a primary role (admin > lead > analyst > viewer).
 * Anything else falls below viewer.
 */
const ROLE_RANK: Record<string, number> = {
  admin: 100,
  lead: 80,
  analyst: 60,
  viewer: 40,
};

const empty: PermissionsContextValue = {
  capabilities: new Set(),
  capabilityList: [],
  roleKeys: [],
  user: null,
  has: () => false,
  hasAny: () => false,
  hasAll: () => false,
  primaryRole: null,
  isLoading: false,
  error: null,
};

/**
 * Provides the active user's org capabilities. Only fetches when there's an
 * authenticated user; logged-out / setup flows skip the request entirely.
 *
 * Capabilities load asynchronously after the auth check. While loading, `has()`
 * returns false — every gated control renders as denied. That's the safer default
 * (no flash of authorized UI for users who don't have access).
 */
export function PermissionsProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const enabled = Boolean(user) && !authLoading;
  const query = useOrgPermissionsQuery(enabled);

  const value = useMemo<PermissionsContextValue>(() => {
    if (!enabled) return empty;
    const data = query.data;
    if (!data) {
      return {
        ...empty,
        isLoading: query.isLoading,
        error: query.error ?? null,
      };
    }
    const capabilities = new Set(data.capabilities);
    const roleKeys = data.roles.map((r) => r.key);
    const primaryRole = roleKeys.reduce<string | null>((best, key) => {
      const rank = ROLE_RANK[key] ?? 0;
      const bestRank = best ? ROLE_RANK[best] ?? 0 : -1;
      return rank > bestRank ? key : best;
    }, null);
    return {
      capabilities,
      capabilityList: data.capabilities,
      roleKeys,
      user: data.user,
      has: (capability) => {
        if (Array.isArray(capability)) return capability.every((c) => capabilities.has(c));
        return capabilities.has(capability);
      },
      hasAny: (caps) => caps.some((c) => capabilities.has(c)),
      hasAll: (caps) => caps.every((c) => capabilities.has(c)),
      primaryRole,
      isLoading: query.isLoading,
      error: query.error ?? null,
    };
  }, [enabled, query.data, query.error, query.isLoading]);

  return (
    <PermissionsContext.Provider value={value}>
      {children}
    </PermissionsContext.Provider>
  );
}

/**
 * Supplies an explicit capability set to the subtree, overriding any ancestor
 * PermissionsProvider. Used by the public demo, which has no authenticated user
 * (so the real provider denies everything) but still needs to render gated
 * controls like plan approval.
 */
export function PermissionsOverrideProvider({
  capabilities,
  children,
}: {
  capabilities: Capability[];
  children: ReactNode;
}) {
  const value = useMemo<PermissionsContextValue>(() => {
    const caps = new Set(capabilities);
    return {
      capabilities: caps,
      capabilityList: capabilities,
      roleKeys: ['admin'],
      user: null,
      has: (capability) =>
        Array.isArray(capability) ? capability.every((c) => caps.has(c)) : caps.has(capability),
      hasAny: (caps2) => caps2.some((c) => caps.has(c)),
      hasAll: (caps2) => caps2.every((c) => caps.has(c)),
      primaryRole: 'admin',
      isLoading: false,
      error: null,
    };
  }, [capabilities]);

  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

/**
 * Read the current user's permissions. Components outside the provider get
 * the deny-all fallback rather than crashing — that way feature flags and
 * pre-auth components stay safe.
 */
export function useOrgPermissions(): PermissionsContextValue {
  const ctx = useContext(PermissionsContext);
  return ctx ?? empty;
}

export function useHasCapability(capability: Capability): boolean {
  return useOrgPermissions().has(capability);
}
