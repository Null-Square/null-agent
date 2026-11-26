import { describe, expect, it } from 'vitest';
import {
  buildRunCompactionPrompt,
  extractCompactionCategoryCounts,
  normalizeCompactionSummary,
} from '@/domains/agent-brain/application/orchestration/stages/helpers/CompactionSummary';

describe('CompactionSummary helpers', () => {
  it('normalizes unstructured output into the required section layout', () => {
    const normalized = normalizeCompactionSummary(
      'Confirmed admin panel without auth. Validator should revisit /admin after recon.',
    );

    expect(normalized).toContain('## Filed Findings');
    expect(normalized).toContain('## Attempted Techniques');
    expect(normalized).toContain('## High-Signal Discoveries');
    expect(normalized).toContain('- Confirmed admin panel without auth. Validator should revisit /admin after recon.');
  });

  it('counts non-placeholder bullets by category', () => {
    const summary = [
      '## Filed Findings',
      '- F-101 | high | /admin exposed without auth',
      '',
      '## Attempted Techniques',
      '- ffuf | https://app.example.com/admin | 200 responses mapped',
      '- katana | https://app.example.com | discovered /openapi.json',
      '',
      '## Failed Approaches and Blockers',
      '- none',
      '',
      '## Confirmed Credentials or Tokens',
      '- cookie abc123 | admin scope | confirmed valid',
      '',
      '## Open Plan Steps',
      '- validate the /admin workflow with a dedicated validator worker',
      '',
      '## High-Signal Discoveries',
      '- admin.app.example.com exposes /admin and /login',
      '',
      '## Constraints and Safety Limits',
      '- keep the root focused on coordination only',
    ].join('\n');

    const counts = extractCompactionCategoryCounts(summary);

    expect(counts).toEqual({
      findingsPreserved: 1,
      techniquesPreserved: 2,
      approachesPreserved: 0,
      credentialsPreserved: 1,
      openStepsPreserved: 1,
      discoveriesPreserved: 1,
      constraintsPreserved: 1,
    });
  });

  it('uses workflow-specific preservation rules without generic next-action advice', () => {
    const compliance = buildRunCompactionPrompt(
      { conversationText: 'Control CC6.1 has no current evidence.' },
      'compliance',
    );
    const exposure = buildRunCompactionPrompt(
      { conversationText: 'CVE-2026-0001 is bound to app.example.test.' },
      'exposure_verification',
    );

    expect(compliance.system).toContain('control IDs, recorded verdicts, request IDs');
    expect(compliance.system).toContain('Do not introduce vulnerability-testing work');
    expect(exposure.system).toContain('bound advisory, exact asset');
    expect(exposure.system).toContain('Do not introduce another host, advisory');
    expect(compliance.system).not.toContain('Constraints and Next Actions');
    expect(compliance.system).not.toContain('next parent action');
  });
});
