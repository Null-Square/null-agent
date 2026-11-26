import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchApi } from "@shared/api";
import type { OrgPermissions } from "./types";

export const ORG_PERMISSIONS_KEY = ["org", "me", "permissions"] as const;

const FIVE_MINUTES = 5 * 60 * 1000;

/**
 * Fetch the current user's effective capabilities + active grants for their
 * active organization. Cached 5 min, refetched on focus interval, never on
 * a 401/403 (those mean the user is logged out or not in any org).
 */
export function useOrgPermissionsQuery(
  enabled = true,
): UseQueryResult<OrgPermissions, Error> {
  return useQuery<OrgPermissions, Error>({
    queryKey: ORG_PERMISSIONS_KEY,
    queryFn: async () => {
      const res = await fetchApi.get<OrgPermissions>("/app/organization/me/permissions");
      return res.data;
    },
    enabled,
    staleTime: FIVE_MINUTES,
    refetchInterval: FIVE_MINUTES,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => {
      const status = (error as { status?: number } | null)?.status;
      if (status === 401 || status === 403) return false;
      return failureCount < 2;
    },
  });
}
