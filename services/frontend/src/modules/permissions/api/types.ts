/**
 * Mirrors the backend org permissions response from
 * `GET /api/app/organization/me/permissions`. Keep in sync with the
 * shared authorization layer in `services/backend/src/shared/auth/authorization/`.
 */

export type OrgCapability =
  | "org.read"
  | "org.settings.write"
  | "org.member.manage"
  | "org.scope.read"
  | "org.scope.write"
  | "org.scope.roe.manage"
  | "org.run.start"
  | "org.run.cancel.any"
  | "org.run.cancel.own"
  | "org.run.approve"
  | "org.finding.read"
  | "org.finding.triage"
  | "org.evidence.write"
  | "org.credentials.write"
  | "org.integration.manage"
  | "org.runner.manage"
  | "org.automation.manage"
  | "org.compliance.evidence.manage"
  | "org.audit.read";

export type OrgRole = "admin" | "lead" | "analyst" | "viewer";

export type OrgPermissions = {
  user: { id: string; email?: string | null };
  /** Roles the user holds in the active organization. */
  roles: Array<{
    key: OrgRole | string;
    organizationId: string | null;
    expiresAt?: string | null;
  }>;
  /** Flat list of capability keys the user can exercise right now. */
  capabilities: string[];
};
