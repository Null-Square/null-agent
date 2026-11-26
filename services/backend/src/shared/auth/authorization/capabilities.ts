/**
 * What a member of the organization may do, as the app sees it: `GET /api/app/organization/me/permissions`
 * returns these keys and the app's routes and buttons gate on them. Null AI has one person and no
 * staff, so there are no platform or system capabilities. The API's own checks are
 * `requireCapability` (`shared/auth/capabilities.ts`).
 */
export type OrganizationCapabilityKey =
  | 'org.read'
  | 'org.settings.write'
  | 'org.member.manage'
  | 'org.scope.read'
  | 'org.scope.write'
  | 'org.scope.roe.manage'
  | 'org.run.start'
  | 'org.run.cancel.any'
  | 'org.run.cancel.own'
  | 'org.run.approve'
  | 'org.finding.read'
  | 'org.finding.triage'
  | 'org.evidence.write'
  | 'org.credentials.write'
  | 'org.integration.manage'
  | 'org.runner.manage'
  | 'org.automation.manage'
  | 'org.compliance.evidence.manage'
  | 'org.audit.read';
