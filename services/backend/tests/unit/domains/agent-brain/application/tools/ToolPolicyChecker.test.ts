import { describe, it, expect } from 'vitest';
import { ToolPolicyChecker } from '@/domains/agent-brain/application/tools';

describe('ToolPolicyChecker', () => {
  const checker = new ToolPolicyChecker();

  it('allows tool when no policy is set', () => {
    expect(checker.isToolAllowedByPolicy(undefined as any, 'shell_run')).toBe(true);
  });

  it('denies tool when pattern matches deny list', () => {
    const policy = { deny: ['shell_*'] } as any;
    expect(checker.isToolAllowedByPolicy(policy, 'shell_run')).toBe(false);
  });

  it('allows tool when allowlist matches and deny does not', () => {
    const policy = { allow: ['file_*'] } as any;
    expect(checker.isToolAllowedByPolicy(policy, 'file_read')).toBe(true);
    expect(checker.isToolAllowedByPolicy(policy, 'shell_run')).toBe(false);
  });

  it('treats ask patterns as available at prompt-build time', () => {
    const policy = { ask: ['shell_*'] } as any;
    expect(checker.isToolAllowedByPolicy(policy, 'shell_run')).toBe(true);
  });

  it('evaluates action-scoped deny rules from the tool descriptor', () => {
    const decision = checker.evaluateToolUsage(
      {
        rules: [
          {
            behavior: 'deny',
            action: 'write',
            path: '*.md',
            note: 'markdown writes are operator-controlled',
          },
        ],
      } as any,
      checker.describeToolUse({
        toolName: 'file_write',
        toolArgs: { path: 'report.md', content: 'hi' },
        toolMeta: { category: 'fs', risks: ['write'] } as any,
      }),
    );

    expect(decision.behavior).toBe('deny');
    expect(decision.reason).toContain('matching tool policy rule');
  });

  it('derives hosts and execution action from shell and URL-bearing tools', () => {
    const descriptor = checker.describeToolUse({
      toolName: 'shell_run',
      toolArgs: {
        command: 'curl https://api.example.com/health',
        url: 'https://api.example.com/health',
      },
      toolMeta: { category: 'shell', risks: ['compute', 'network'] } as any,
    });

    expect(descriptor.actions).toEqual(expect.arrayContaining(['execute', 'network']));
    expect(descriptor.hosts).toContain('api.example.com');
    expect(descriptor.command).toBe('curl https://api.example.com/health');
  });

  it('treats scanner artifactPath as a runtime-constrainable path', () => {
    const descriptor = checker.describeToolUse({
      toolName: 'ingest_scan_artifact',
      toolArgs: {
        parser: 'nuclei',
        artifactPath: '/workspace/.artifacts/scans/recon/nuclei.jsonl',
      },
      toolMeta: { category: 'securityops', risks: ['write'] } as any,
    });

    expect(descriptor.paths).toEqual(['/workspace/.artifacts/scans/recon/nuclei.jsonl']);
    expect(descriptor.actions).toContain('write');
  });

  it('checks requirements against nested flags', () => {
    const flags = { capabilities: { sandbox: { write: true } } };
    expect(checker.hasRequirement(flags as any, 'capabilities.sandbox.write')).toBe(true);
    expect(checker.hasRequirement(flags as any, 'capabilities.sandbox.exec')).toBe(false);
  });

  it('treats arrays as truthy requirements', () => {
    const flags = { tokens: ['a'] };
    expect(checker.hasRequirement(flags as any, 'tokens')).toBe(true);
  });
});







