import { describe, expect, it } from 'vitest';

import {
  capabilitiesForRole,
  roleHasAllCapabilities,
  roleHasCapability,
} from '@/shared/auth/capabilities';

describe('organization capability matrix', () => {
  it('allows only admins to manage billing and credits', () => {
    expect(roleHasCapability('admin', 'billing.manage')).toBe(true);
    expect(roleHasCapability('admin', 'credits.adjust')).toBe(true);
    expect(roleHasCapability('admin', 'members.manage')).toBe(true);

    for (const role of ['lead', 'analyst', 'viewer'] as const) {
      expect(roleHasCapability(role, 'billing.manage')).toBe(false);
      expect(roleHasCapability(role, 'credits.adjust')).toBe(false);
    }
    expect(roleHasCapability('lead', 'members.manage')).toBe(true);
    expect(roleHasCapability('analyst', 'members.manage')).toBe(false);
    expect(roleHasCapability('viewer', 'members.manage')).toBe(false);
  });

  it('keeps leads operational without granting billing control', () => {
    expect(roleHasAllCapabilities('lead', ['scopes.manage', 'runs.start', 'automations.manage'])).toBe(true);
    expect(roleHasCapability('lead', 'billing.read')).toBe(false);
  });

  it('keeps viewers read-only', () => {
    expect(capabilitiesForRole('viewer')).toEqual([
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
    ]);
    expect(roleHasCapability('viewer', 'findings.triage')).toBe(false);
    expect(roleHasCapability('viewer', 'findings.comment')).toBe(false);
    expect(roleHasCapability('viewer', 'runners.manage')).toBe(false);
    // Viewers may see an exposure but never spend credits testing it — the
    // whole reason read and verify are separate capabilities.
    expect(roleHasCapability('viewer', 'threatwatch.verify')).toBe(false);
    expect(roleHasCapability('analyst', 'threatwatch.verify')).toBe(true);
  });

  it('keeps destructive and administrative operations admin-only unless explicitly delegated', () => {
    expect(roleHasCapability('admin', 'integrations.admin')).toBe(true);
    expect(roleHasCapability('admin', 'runners.admin')).toBe(true);
    expect(roleHasCapability('admin', 'automations.delete')).toBe(true);

    for (const role of ['lead', 'analyst', 'viewer'] as const) {
      expect(roleHasCapability(role, 'integrations.admin')).toBe(false);
      expect(roleHasCapability(role, 'runners.admin')).toBe(false);
      expect(roleHasCapability(role, 'automations.delete')).toBe(false);
    }
  });
});
