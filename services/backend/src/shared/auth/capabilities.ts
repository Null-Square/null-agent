import type { OrgRole } from '@/shared/auth/orgRoles';

export const ORG_CAPABILITIES = [
  'billing.read',
  'billing.manage',
  'credits.adjust',
  'organization.manage',
  'members.read',
  'members.manage',
  'scopes.read',
  'scopes.manage',
  'credentials.read',
  'credentials.manage',
  'integrations.read',
  'integrations.admin',
  'integrations.manage',
  'findings.read',
  'findings.triage',
  'findings.comment',
  'findings.manage',
  'runs.read',
  'runs.start',
  'runs.cancel',
  'runners.read',
  'runners.admin',
  'runners.manage',
  'automations.read',
  'automations.manage',
  'automations.delete',
  'compliance.read',
  'compliance.evidence.write',
  'compliance.manage',
  'context.manage',
  'observability.read',
  'reports.read',
  'audit.read',
  // Threat Watch. `verify` is separate from `read` because it spends agent
  // credits, so seeing an exposure and paying to test it are different rights.
  'threatwatch.read',
  'threatwatch.verify',
] as const;

export type OrgCapability = (typeof ORG_CAPABILITIES)[number];

const ADMIN_CAPABILITIES = ORG_CAPABILITIES;

const LEAD_CAPABILITIES = [
  'members.read',
  'members.manage',
  'scopes.read',
  'scopes.manage',
  'credentials.read',
  'credentials.manage',
  'integrations.read',
  'integrations.manage',
  'findings.read',
  'findings.triage',
  'findings.comment',
  'findings.manage',
  'runs.read',
  'runs.start',
  'runs.cancel',
  'runners.read',
  'runners.manage',
  'automations.read',
  'automations.manage',
  'compliance.read',
  'compliance.evidence.write',
  'compliance.manage',
  'context.manage',
  'observability.read',
  'reports.read',
  'threatwatch.read',
  'threatwatch.verify',
] as const satisfies readonly OrgCapability[];

const ANALYST_CAPABILITIES = [
  'members.read',
  'scopes.read',
  'credentials.read',
  'integrations.read',
  'findings.read',
  'findings.triage',
  'findings.comment',
  'runs.read',
  'runs.start',
  'runners.read',
  'observability.read',
  'compliance.read',
  'compliance.evidence.write',
  'reports.read',
  'threatwatch.read',
  'threatwatch.verify',
] as const satisfies readonly OrgCapability[];

const VIEWER_CAPABILITIES = [
  'members.read',
  'scopes.read',
  'integrations.read',
  'findings.read',
  'runs.read',
  'runners.read',
  'observability.read',
  'compliance.read',
  'reports.read',
  'threatwatch.read',
] as const satisfies readonly OrgCapability[];

export const ORG_ROLE_CAPABILITIES: Record<OrgRole, readonly OrgCapability[]> = {
  admin: ADMIN_CAPABILITIES,
  lead: LEAD_CAPABILITIES,
  analyst: ANALYST_CAPABILITIES,
  viewer: VIEWER_CAPABILITIES,
};

export const capabilitiesForRole = (role: OrgRole): readonly OrgCapability[] =>
  ORG_ROLE_CAPABILITIES[role];

export const roleHasCapability = (role: OrgRole, capability: OrgCapability): boolean =>
  capabilitiesForRole(role).includes(capability);

export const roleHasAllCapabilities = (
  role: OrgRole,
  capabilities: readonly OrgCapability[],
): boolean => capabilities.every((capability) => roleHasCapability(role, capability));
