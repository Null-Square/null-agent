import { describe, expect, it } from 'vitest';

import {
  FRAMEWORK_REGISTRY,
  type ComplianceFrameworkKey,
} from '@/domains/security-ops/compliance/frameworks';

const P0_FRAMEWORKS: ComplianceFrameworkKey[] = ['soc2', 'gdpr', 'hipaa', 'pci_dss', 'nist_csf'];

describe('compliance P0 proof obligations', () => {
  it.each(P0_FRAMEWORKS)('%s has an evidence-backed agent-provable control', (frameworkKey) => {
    const authoredControls = FRAMEWORK_REGISTRY[frameworkKey].controls.filter(
      (control) => control.proofObligation,
    );

    expect(authoredControls.length).toBeGreaterThan(0);
    for (const control of authoredControls) {
      expect(control.supportLevel).toBe('automated_testable');
      expect(control.catalogRef).toBeTruthy();
      expect(control.proofObligation?.id).toBeTruthy();
      expect(control.proofObligation?.statement).toBeTruthy();
      expect(control.proofObligation?.requiredEvidence.length).toBeGreaterThan(0);
      expect([
        ...(control.testSkillSlugs ?? []),
        ...(control.deterministicTools ?? []),
      ].length).toBeGreaterThan(0);
    }
  });
});
