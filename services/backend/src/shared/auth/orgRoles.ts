export const ORG_ROLES = ['admin', 'lead', 'analyst', 'viewer'] as const;

export type OrgRole = (typeof ORG_ROLES)[number];

const ORG_ROLE_SET = new Set<string>(ORG_ROLES);
const ORG_ROLE_RANK: Record<OrgRole, number> = {
  viewer: 0,
  analyst: 1,
  lead: 2,
  admin: 3,
};

export const isOrgRole = (value: string): value is OrgRole => ORG_ROLE_SET.has(value);

export const normalizeOrgRole = (value: unknown): OrgRole | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return isOrgRole(normalized) ? normalized : null;
};

export const getOrgRoleRank = (role: OrgRole): number => ORG_ROLE_RANK[role];
