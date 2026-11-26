import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mergeToolPolicies } from '@/domains/agent-brain/domain/policy/brainPolicyRuntimeService';
import { ToolPolicyChecker } from '@/domains/agent-brain/application/tools';
import type { ToolAccessPolicy } from '@/domains/agent-brain/domain/types';

describe('Tool policy merge and enforcement', () => {
  it('merges allow/deny/allowlist and enforces deny-first semantics', () => {
    const basePolicy = {
      allow: ['shell_*'],
      deny: ['web_fetch'],
      ask: ['browser_*'],
      allowlist_hosts: ['example.com'],
      rules: [{ behavior: 'deny', action: 'write', path: '*.md' }],
    } satisfies ToolAccessPolicy;
    const runtimePolicy = {
      allow: ['file_*'],
      deny: ['shell_run'],
      ask: ['report_*'],
      allowlist_hosts: ['api.service.local'],
      rules: [{ behavior: 'ask', tool: 'http_*', host: 'api.service.local' }],
    } satisfies ToolAccessPolicy;

    const merged = mergeToolPolicies(basePolicy, runtimePolicy);
    expect(merged).toBeDefined();
    expect(merged?.allow).toEqual(expect.arrayContaining(['shell_*', 'file_*']));
    expect(merged?.deny).toEqual(expect.arrayContaining(['web_fetch', 'shell_run']));
    expect(merged?.ask).toEqual(expect.arrayContaining(['browser_*', 'report_*']));
    expect(merged?.allowlist_hosts).toEqual(expect.arrayContaining(['example.com', 'api.service.local']));
    expect(merged?.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ behavior: 'deny', action: 'write' }),
      expect.objectContaining({ behavior: 'ask', tool: 'http_*' }),
    ]));

    const checker = new ToolPolicyChecker();
    // Deny wins even if allow wildcard would otherwise match
    expect(checker.isToolAllowedByPolicy(merged, 'shell_run')).toBe(false);
    expect(checker.isToolAllowedByPolicy(merged, 'web_fetch')).toBe(false);
    // Allowed when matched by allow-list and not denied
    expect(checker.isToolAllowedByPolicy(merged, 'file_write')).toBe(true);
    // Not on allow-list => rejected when allow array present
    expect(checker.isToolAllowedByPolicy(merged, 'plan_set_step_status')).toBe(false);
    // Ask-pattern tools remain visible; runtime permission can still require approval.
    expect(checker.isToolAllowedByPolicy(merged, 'browser_action')).toBe(true);
  });

  it('validates nested requirements against session flags', () => {
    const checker = new ToolPolicyChecker();
    const flags = {
      guard: { pending: true },
      files: { summary: { exists: true } },
      reports: [],
    };

    expect(checker.hasRequirement(flags as any, 'guard.pending')).toBe(true);
    expect(checker.hasRequirement(flags as any, 'files.summary.exists')).toBe(true);
    // Arrays must be non-empty
    expect(checker.hasRequirement(flags as any, 'reports')).toBe(false);
    expect(checker.hasRequirement(flags as any, 'reports.generated')).toBe(false);
    expect(checker.hasRequirement(flags as any, 'nonexistent.path')).toBe(false);
  });
});






