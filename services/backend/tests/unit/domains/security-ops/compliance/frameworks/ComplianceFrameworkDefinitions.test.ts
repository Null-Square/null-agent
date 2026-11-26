import { describe, expect, it } from 'vitest';
import { FRAMEWORK_REGISTRY } from '@/domains/security-ops/compliance/frameworks';
import { FRAMEWORK_CONTROL_METHOD_SKILLS } from '@/domains/security-ops/compliance/frameworks/controlMethodSkills';

describe('compliance P0 proof obligations', () => {
  it('keeps proof-obligation identities unique and stable across frameworks', () => {
    const obligationIds = Object.values(FRAMEWORK_REGISTRY)
      .flatMap((framework) => framework.controls)
      .flatMap((control) => control.proofObligation?.id ?? []);
    expect(new Set(obligationIds).size).toBe(obligationIds.length);
  });

  it('binds every SOC 2 agent-provable control to a proof obligation and compliance skill', () => {
    const executableControls = FRAMEWORK_REGISTRY.soc2.controls.filter((control) =>
      control.supportLevel === 'automated_testable' &&
      Boolean(control.proofObligation),
    );
    expect(executableControls.map((control) => control.id)).toEqual([
      'CC4.1',
      'CC4.2',
      'CC5.2',
      'CC6.1',
      'CC6.2',
      'CC6.3',
      'CC6.6',
      'CC6.7',
      'CC6.8',
      'CC7.1',
      'CC7.2',
      'CC7.3',
    ]);

    for (const control of executableControls) {
      expect(control.proofObligation?.id).toMatch(/^soc2-cc\d+\.\d+-/u);
      expect(control.testSkillSlugs).toEqual(expect.arrayContaining([
        expect.stringMatching(/^compliance-(access-control|technical-readiness)$/u),
      ]));
    }
  });

  it('defines ISO 27001 as a broad readiness catalog, not a shallow technical slice', () => {
    const iso = FRAMEWORK_REGISTRY.iso27001;
    expect(iso.label).toBe('ISO 27001 Readiness');
    expect(iso.categories).toEqual(['ISMS', 'Organizational', 'People', 'Physical', 'Technological']);
    expect(iso.controls.length).toBeGreaterThanOrEqual(30);
    expect(iso.controls.map((control) => control.id)).toEqual(expect.arrayContaining([
      'ISO-ISMS-4',
      'ISO-ISMS-8',
      'ISO-A-ORG-POLICY',
      'ISO-A-ORG-ASSETS',
      'ISO-A-TECH-IAM',
      'ISO-A-TECH-AUTHZ',
      'ISO-A-TECH-CRYPTO',
      'ISO-A-TECH-VULN',
      'ISO-A-TECH-SDLC',
      'ISO-A-TECH-SUPPLYCHAIN',
    ]));
    expect(iso.controls.some((control) => control.id.startsWith('ISO-TECH-'))).toBe(false);
  });

  it('binds ISO agent-tested controls to proof obligations and compliance skills', () => {
    const executableControls = FRAMEWORK_REGISTRY.iso27001.controls.filter((control) =>
      control.supportLevel === 'automated_testable' &&
      Boolean(control.proofObligation),
    );
    expect(executableControls.map((control) => control.id)).toEqual(expect.arrayContaining([
      'ISO-A-ORG-ASSETS',
      'ISO-A-TECH-IAM',
      'ISO-A-TECH-AUTHZ',
      'ISO-A-TECH-CRYPTO',
      'ISO-A-TECH-NETWORK',
      'ISO-A-TECH-VULN',
      'ISO-A-TECH-SUPPLYCHAIN',
    ]));

    for (const control of executableControls) {
      expect(control.proofObligation?.id).toMatch(/^iso27001-/u);
      expect(control.testSkillSlugs).toEqual(expect.arrayContaining([
        expect.stringMatching(/^compliance-(access-control|technical-readiness)$/u),
      ]));
    }
  });

  it('defines all NIST CSF Functions and binds every agent-testable Category to bounded proof', () => {
    const nist = FRAMEWORK_REGISTRY.nist_csf;
    expect(nist.categories).toEqual(['Govern', 'Identify', 'Protect', 'Detect', 'Respond', 'Recover']);
    expect(nist.controls).toHaveLength(22);

    const executableControls = nist.controls.filter((control) => control.supportLevel === 'automated_testable');
    expect(executableControls.map((control) => control.id)).toEqual([
      'ID.AM',
      'ID.RA',
      'PR.AA',
      'PR.DS',
      'PR.PS',
      'DE.CM',
      'DE.AE',
      'RS.AN',
      'RS.MI',
    ]);
    for (const control of executableControls) {
      expect(control.proofObligation?.id).toMatch(/^nist-/u);
      expect(control.freshnessWindowDays).toBeGreaterThan(0);
      expect(control.testSkillSlugs).toEqual(expect.arrayContaining([
        expect.stringMatching(/^compliance-(access-control|technical-readiness)$/u),
      ]));
    }

    expect(nist.controls.find((control) => control.id === 'GV.PO')).toMatchObject({
      evidenceExamples: expect.arrayContaining(['approved cybersecurity policies']),
      assessmentSkillSlugs: ['compliance-governance-review', 'compliance-evidence-review'],
    });
  });

  it('defines HIPAA as a full Security Rule catalog with Required/Addressable metadata', () => {
    const hipaa = FRAMEWORK_REGISTRY.hipaa;
    expect(hipaa.label).toBe('HIPAA Security Rule Readiness');
    expect(hipaa.categories).toEqual(['Administrative', 'Physical', 'Technical', 'Organizational']);
    expect(hipaa.controls).toHaveLength(26);
    expect(hipaa.controls.map((control) => control.id)).toEqual(expect.arrayContaining([
      '164.308(a)(1)',
      '164.310(a)(1)',
      '164.312(a)(1)',
      '164.314(a)',
      '164.316',
    ]));
    expect(hipaa.controls.every((control) => Boolean(control.implementationSpec))).toBe(true);
    expect(hipaa.controls.filter((control) => control.implementationSpec === 'addressable').map((control) => control.id)).toEqual(
      expect.arrayContaining(['164.308(a)(3)', '164.310(a)(1)', '164.312(a)(2)(iii)', '164.312(e)(2)(ii)']),
    );
    expect(hipaa.controls.filter((control) => control.implementationSpec === 'mixed').map((control) => control.id)).toEqual([
      '164.308(a)(4)',
      '164.308(a)(7)',
      '164.310(d)(1)',
    ]);
  });

  it('binds HIPAA agent-tested technical safeguards to proof obligations and compliance skills', () => {
    const executableControls = FRAMEWORK_REGISTRY.hipaa.controls.filter((control) =>
      control.supportLevel === 'automated_testable' &&
      Boolean(control.proofObligation),
    );
    expect(executableControls.map((control) => control.id)).toEqual([
      '164.312(a)(1)',
      '164.312(a)(2)(iii)',
      '164.312(b)',
      '164.312(c)(1)',
      '164.312(d)',
      '164.312(e)(1)',
      '164.312(e)(2)(i)',
      '164.312(e)(2)(ii)',
    ]);

    for (const control of executableControls) {
      expect(control.proofObligation?.id).toMatch(/^hipaa-164\.312-/u);
      expect(control.freshnessWindowDays).toBeGreaterThan(0);
      expect(control.testSkillSlugs).toEqual(expect.arrayContaining([
        expect.stringMatching(/^compliance-(access-control|technical-readiness)$/u),
      ]));
    }
  });

  it('defines PCI DSS v4.0.1 as a CDE-scoped sub-requirement catalog', () => {
    const pci = FRAMEWORK_REGISTRY.pci_dss;
    expect(pci.label).toBe('PCI DSS v4.0.1 Readiness');
    expect(pci.categories).toEqual([
      'Build and Maintain Secure Network and Systems',
      'Protect Account Data',
      'Maintain a Vulnerability Management Program',
      'Implement Strong Access Control Measures',
      'Regularly Monitor and Test Networks',
      'Maintain an Information Security Policy',
    ]);
    expect(pci.controls.length).toBeGreaterThanOrEqual(35);
    expect(pci.controls.map((control) => control.id)).toEqual(expect.arrayContaining([
      '1.2',
      '3.3',
      '3.5',
      '4.2',
      '6.4.3',
      '8.4.2',
      '10.4.1.1',
      '11.3.2',
      '11.4',
      '11.6.1',
      '12.3.2',
    ]));
    expect(pci.controls.some((control) => /^PCI-\d+$/u.test(control.id))).toBe(false);
    expect(pci.controls.every((control) => Boolean(control.pciDssRequirement))).toBe(true);
    expect(pci.controls.every((control) => Boolean(control.pciDssSaqTypes?.length))).toBe(true);
    expect(pci.controls.find((control) => control.id === '3.3')).toMatchObject({
      pciDssAccountData: 'sad',
      supportLevel: 'manual_evidence_required',
    });
    expect(pci.controls.find((control) => control.id === '12.3.2')).toMatchObject({
      pciDssApproach: 'customized_eligible',
      assessmentSkillSlugs: ['compliance-governance-review', 'compliance-evidence-review'],
    });
  });

  it('binds PCI DSS agent-tested sub-requirements to proof obligations and compliance skills', () => {
    const executableControls = FRAMEWORK_REGISTRY.pci_dss.controls.filter((control) =>
      control.supportLevel === 'automated_testable' &&
      Boolean(control.proofObligation),
    );
    expect(executableControls.map((control) => control.id)).toEqual(expect.arrayContaining([
      '1.2',
      '1.3',
      '2.2',
      '4.2',
      '6.3',
      '6.4.3',
      '7.2',
      '8.2',
      '8.4.2',
      '11.3.1',
      '11.3.2',
      '11.4',
      '11.4.5',
      '11.6.1',
    ]));

    for (const control of executableControls) {
      expect(control.proofObligation?.id).toMatch(/^pci-/u);
      expect(control.freshnessWindowDays).toBeGreaterThan(0);
      expect(control.testSkillSlugs).toEqual(expect.arrayContaining([
        expect.stringMatching(/^compliance-(access-control|technical-readiness)$/u),
      ]));
    }
  });

  it('defines GDPR as a privacy-readiness catalog with bounded security checks', () => {
    const gdpr = FRAMEWORK_REGISTRY.gdpr;
    expect(gdpr.label).toBe('GDPR Readiness');
    expect(gdpr.reportTitle).toBe('GDPR Readiness Report');
    expect(gdpr.reportTemplateFile).toBe('gdpr-readiness.md');
    expect(gdpr.categories).toEqual([
      'Applicability and Accountability',
      'Processing Records and Legal Basis',
      'Transparency and Rights',
      'Retention, Privacy by Design, and DPIA',
      'Processors, Transfers, and Breaches',
      'Security of Processing',
    ]);
    expect(gdpr.controls).toHaveLength(19);
    expect(gdpr.controls.map((control) => control.id)).toEqual(expect.arrayContaining([
      'GDPR-SCOPE-APPLICABILITY',
      'GDPR-DATA-ROPA',
      'GDPR-LAW-LAWFUL-BASIS',
      'GDPR-TRANS-NOTICE',
      'GDPR-RIGHTS-DSR',
      'GDPR-RISK-DPIA',
      'GDPR-THIRD-PROCESSORS',
      'GDPR-TRANSFER-SAFEGUARDS',
      'GDPR-BREACH-RESPONSE',
      'GDPR-SEC-PROCESSING',
      'GDPR-SEC-ACCESS-CONTROL',
      'GDPR-SEC-ENCRYPTION-RESILIENCE',
    ]));
    expect(gdpr.controls.every((control) => control.catalogRef === `gdpr:${control.id}`)).toBe(true);
    expect(gdpr.controls.every((control) => control.pciDssRequirement === undefined)).toBe(true);
    expect(gdpr.controls.every((control) => control.implementationSpec === undefined)).toBe(true);
  });

  it('binds GDPR automated controls to proof obligations and compliance skills', () => {
    const executableControls = FRAMEWORK_REGISTRY.gdpr.controls.filter((control) =>
      control.supportLevel === 'automated_testable' &&
      Boolean(control.proofObligation),
    );
    expect(executableControls.map((control) => control.id)).toEqual([
      'GDPR-TRANS-NOTICE',
      'GDPR-SEC-PROCESSING',
      'GDPR-SEC-ACCESS-CONTROL',
      'GDPR-SEC-ENCRYPTION-RESILIENCE',
    ]);

    for (const control of executableControls) {
      expect(control.proofObligation?.id).toMatch(/^gdpr-/u);
      expect(control.freshnessWindowDays).toBeGreaterThan(0);
      expect(control.testSkillSlugs).toEqual(expect.arrayContaining([
        expect.stringMatching(/^compliance-(access-control|evidence-review|technical-readiness)$/u),
      ]));
    }
  });

  it('routes governance controls to a framework-neutral governance review method', () => {
    const soc2Governance = FRAMEWORK_REGISTRY.soc2.controls.find((control) => control.id === 'CC1.1');
    const gdprGovernance = FRAMEWORK_REGISTRY.gdpr.controls.find((control) => control.id === 'GDPR-GOV-ACCOUNTABILITY');
    const hipaaGovernance = FRAMEWORK_REGISTRY.hipaa.controls.find((control) => control.id === '164.308(a)(1)');
    const isoGovernance = FRAMEWORK_REGISTRY.iso27001.controls.find((control) => control.id === 'ISO-ISMS-5');
    const nistGovernance = FRAMEWORK_REGISTRY.nist_csf.controls.find((control) => control.id === 'GV.RM');
    const pciGovernance = FRAMEWORK_REGISTRY.pci_dss.controls.find((control) => control.id === '12.1');

    for (const control of [soc2Governance, gdprGovernance, hipaaGovernance, isoGovernance, nistGovernance, pciGovernance]) {
      expect(control?.assessmentSkillSlugs).toEqual([
        'compliance-governance-review',
        'compliance-evidence-review',
      ]);
    }
  });

  it('keeps every framework control-method mapping in the registry and resolvable', () => {
    for (const [frameworkKey, mappings] of Object.entries(FRAMEWORK_CONTROL_METHOD_SKILLS)) {
      const framework = FRAMEWORK_REGISTRY[frameworkKey as keyof typeof FRAMEWORK_REGISTRY];
      for (const [controlId, skills] of Object.entries(mappings)) {
        const control = framework.controls.find((candidate) => candidate.id === controlId);
        expect(control, `missing ${frameworkKey}/${controlId}`).toBeDefined();
        expect(control?.skillSlugs, `${frameworkKey}/${controlId}`).toEqual(
          expect.arrayContaining(skills),
        );
      }
    }
  });
});
