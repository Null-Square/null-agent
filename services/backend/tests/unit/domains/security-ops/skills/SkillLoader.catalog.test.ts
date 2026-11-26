import fs from 'fs/promises';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { getWorkerProfileRegistry } from '@/domains/agent-brain/domain/workers/WorkerProfileRegistry';
import { SkillLoader } from '@/domains/security-ops/skills/SkillLoader';

const EXPANDED_SKILL_SLUGS = [
  'broad-surface-scan',
  'js-surface-analysis',
  'api-enumeration',
  'information-disclosure',
  'network-recon',
  'rce',
  'csrf',
  'mass-assignment',
  'business-logic',
  'race-conditions',
  'insecure-file-uploads',
] as const;

const CORE_ROUTING_SKILL_SLUGS = [
  'idor',
  'sql-injection',
  'xss',
  'ssrf',
  'business-logic',
] as const;

const COMPLIANCE_ASSESSMENT_WORKER_SKILL_SLUGS = [
  'compliance-access-control',
  'compliance-technical-readiness',
  'compliance-evidence-review',
  'compliance-governance-review',
] as const;

describe('SkillLoader expanded catalog', () => {
  it('loads the backend skill catalog when constructed from the monorepo root', async () => {
    const originalCwd = process.cwd();
    process.chdir(path.resolve(originalCwd, '..', '..'));
    try {
      const loader = new SkillLoader();
      const catalog = await loader.loadSkillCatalog();
      const bySlug = new Map(catalog.map((skill) => [skill.slug, skill]));

      expect(bySlug.get('broken-auth')).toMatchObject({
        phase: 'validation',
        category: 'vulnerability',
      });
      expect(bySlug.get('idor')).toMatchObject({
        phase: 'validation',
        category: 'vulnerability',
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('loads all new skills with required supporting files', async () => {
    const loader = new SkillLoader();
    const catalog = await loader.loadSkillCatalog();
    const bySlug = new Map(catalog.map((skill) => [skill.slug, skill]));

    for (const slug of EXPANDED_SKILL_SLUGS) {
      const skill = bySlug.get(slug);
      expect(skill, `missing skill metadata for ${slug}`).toBeDefined();
      expect(skill?.supportingFiles).toEqual(
        expect.arrayContaining(['methodology.md', 'examples.md']),
      );
      expect(skill?.description?.trim().length ?? 0).toBeGreaterThan(0);

      const skillDir = path.resolve(process.cwd(), 'config/skills', slug);
      await expect(fs.access(path.resolve(skillDir, 'SKILL.md'))).resolves.toBeUndefined();
      await expect(fs.access(path.resolve(skillDir, 'methodology.md'))).resolves.toBeUndefined();
      await expect(fs.access(path.resolve(skillDir, 'examples.md'))).resolves.toBeUndefined();
    }

    expect(bySlug.get('broad-surface-scan')).toMatchObject({
      phase: 'recon',
      freshScopePriority: 'high',
      useWhen: expect.stringContaining('needsBroadScan=true'),
      requiredInputs: expect.arrayContaining([
        expect.stringContaining('Authorized in-scope'),
      ]),
      expectedOutputs: expect.arrayContaining([
        expect.stringContaining('scan.coverage note'),
      ]),
      evidenceFloor: expect.stringContaining('durable inventory evidence'),
      followUpTriggers: expect.arrayContaining([
        expect.stringContaining('class-specific testing'),
      ]),
    });
  });

  it('loads prompt-read routing metadata for the core vulnerability skills', async () => {
    const loader = new SkillLoader();
    const catalog = await loader.loadSkillCatalog();
    const bySlug = new Map(catalog.map((skill) => [skill.slug, skill]));

    for (const slug of CORE_ROUTING_SKILL_SLUGS) {
      const skill = bySlug.get(slug);
      expect(skill, `missing skill metadata for ${slug}`).toBeDefined();
      expect(skill?.useWhen?.trim().length ?? 0, `${slug} useWhen`).toBeGreaterThan(0);
      expect(skill?.requiredInputs.length ?? 0, `${slug} requiredInputs`).toBeGreaterThan(0);
      expect(skill?.expectedOutputs.length ?? 0, `${slug} expectedOutputs`).toBeGreaterThan(0);
      expect(skill?.evidenceFloor?.trim().length ?? 0, `${slug} evidenceFloor`).toBeGreaterThan(0);
      expect(skill?.followUpTriggers.length ?? 0, `${slug} followUpTriggers`).toBeGreaterThan(0);
    }
  });

  it('loads the v2.2.1 routing metadata contract for every skill', async () => {
    const loader = new SkillLoader();
    const catalog = await loader.loadSkillCatalog();

    expect(catalog.length).toBeGreaterThanOrEqual(44);
    for (const skill of catalog) {
      expect(skill.useWhen?.trim().length ?? 0, `${skill.slug} useWhen`).toBeGreaterThan(0);
      expect(skill.expectedOutputs.length, `${skill.slug} expectedOutputs`).toBeGreaterThan(0);
      expect(skill.evidenceFloor?.trim().length ?? 0, `${skill.slug} evidenceFloor`).toBeGreaterThan(0);
      expect(skill.compatiblePhases?.length ?? 0, `${skill.slug} compatiblePhases`).toBeGreaterThan(0);
      expect(skill.requiredTools?.length ?? 0, `${skill.slug} requiredTools`).toBeGreaterThan(0);
      expect(skill.strongTerms.length, `${skill.slug} strongTerms`).toBeGreaterThan(0);
    }

    expect(catalog.find((skill) => skill.slug === 'subdomain-takeover')).toMatchObject({
      compatiblePhases: expect.arrayContaining(['enumeration', 'validation']),
      requiredTools: expect.arrayContaining(['shell_run', 'http_payload', 'report_note']),
    });
  });

  it('loads security-reporting as a closeout skill with methodology', async () => {
    const loader = new SkillLoader();
    const catalog = await loader.loadSkillCatalog();
    const reporting = catalog.find((skill) => skill.slug === 'security-reporting');

    expect(reporting).toMatchObject({
      phase: 'reporting',
      supportingFiles: expect.arrayContaining(['methodology.md']),
      expectedOutputs: expect.arrayContaining([
        expect.stringContaining('prepare_report_context'),
        expect.stringContaining('summary.md'),
        expect.stringContaining('report.md'),
        expect.stringContaining('report.section'),
        expect.stringContaining('finalize_run_artifacts'),
      ]),
    });

    const loaded = await loader.loadSkillBySlug('security-reporting');
    expect(loaded?.methodologyContent).toContain('Reporting is the closeout phase');
    expect(loaded?.methodologyContent).toContain('When to Add a Mermaid Diagram');
    expect(loaded?.methodologyContent).toContain('executive-summary');
    expect(loaded?.methodologyContent).toContain('findings-narrative');
    expect(loaded?.methodologyContent).toContain('remediation-plan');
    expect(loaded?.methodologyContent).toContain('agent-actionable');
    expect(loaded?.methodologyContent).toContain('credential provisioning');
    expect(loaded?.methodologyContent).not.toContain('closesCompliance');
    expect(loaded?.methodologyContent).not.toContain('compliance readiness context');
  });

  it('keeps framework templates outside the reporting skill package', async () => {
    const loader = new SkillLoader();
    const catalog = await loader.loadSkillCatalog();
    const securityReporting = catalog.find((skill) => skill.slug === 'security-reporting');
    const complianceReporting = catalog.find((skill) => skill.slug === 'compliance-reporting');

    expect(securityReporting?.supportingFiles).not.toEqual(
      expect.arrayContaining(['templates/soc2-readiness.md']),
    );
    expect(complianceReporting).toMatchObject({
      phase: 'reporting',
      category: 'compliance',
    });
    expect(complianceReporting?.supportingFiles ?? []).not.toEqual(
      expect.arrayContaining([
        'templates/soc2-readiness.md',
        'templates/iso27001-readiness.md',
        'templates/gdpr-readiness.md',
      ]),
    );
    await expect(
      fs.access(path.resolve(process.cwd(), 'config/compliance/report-templates/soc2-readiness.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.resolve(process.cwd(), 'config/compliance/report-templates/iso27001-readiness.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.resolve(process.cwd(), 'config/compliance/report-templates/gdpr-readiness.md')),
    ).resolves.toBeUndefined();
  });

  it('keeps compliance assessment methods free of framework-specific control IDs', async () => {
    const loader = new SkillLoader();
    for (const slug of COMPLIANCE_ASSESSMENT_WORKER_SKILL_SLUGS) {
      const loaded = await loader.loadSkillBySlug(slug);
      expect(loaded, `missing ${slug}`).not.toBeNull();
      expect(loaded?.content).not.toMatch(/\bCC\d+(?:\.\d+)?\b/u);
      expect(loaded?.content).not.toMatch(/\bISO-A-[A-Z0-9-]+\b/u);
      expect(loaded?.content).not.toMatch(/\bGDPR-[A-Z0-9-]+\b/u);
    }
  });

  it('keeps every compliance assessment worker skill compatible with the compliance worker tool policy', async () => {
    const loader = new SkillLoader();
    const catalog = await loader.loadSkillCatalog();
    const bySlug = new Map(catalog.map((skill) => [skill.slug, skill]));
    const complianceWorker = getWorkerProfileRegistry().get('compliance_control_worker');
    const allowedTools = new Set(complianceWorker?.allowedTools ?? []);

    expect(complianceWorker, 'missing compliance_control_worker profile').toBeDefined();
    for (const slug of COMPLIANCE_ASSESSMENT_WORKER_SKILL_SLUGS) {
      const skill = bySlug.get(slug);
      expect(skill, `missing skill metadata for ${slug}`).toBeDefined();
      expect(skill?.compatiblePhases, `${slug} compatiblePhases`).toContain('control_assessment');

      const blockedRequiredTools = (skill?.requiredTools ?? []).filter((tool) => !allowedTools.has(tool));
      expect(blockedRequiredTools, `${slug} worker-unavailable required tools`).toEqual([]);
    }
  });

  it('requires customer-actionable needs_context checks to open or cite a control request', async () => {
    const loader = new SkillLoader();
    const accessControl = await loader.loadSkillBySlug('compliance-access-control');
    const technicalReadiness = await loader.loadSkillBySlug('compliance-technical-readiness');

    for (const skill of [accessControl, technicalReadiness]) {
      const content = skill?.content ?? '';
      expect(content, `${skill?.slug} missing open request projection`).toContain('.compliance/open-requests.json');
      expect(content, `${skill?.slug} missing request completion rule`).toContain(
        'the `needs_context`',
      );
      expect(content, `${skill?.slug} missing request completion rule`).toContain(
        'check is incomplete until you call `record_control_request`',
      );
      expect(content, `${skill?.slug} missing non-customer-actionable exception`).toContain(
        'Only omit a request',
      );
      expect(content, `${skill?.slug} missing non-customer-actionable exception`).toContain(
        'when the blocker is not customer-actionable',
      );
      expect(content, `${skill?.slug} missing durable evidence ref guidance`).toContain(
        'Use durable evidence references only',
      );
      expect(content, `${skill?.slug} missing compliance evidence ref example`).toContain(
        'compliance-evidence:{evidenceItemId}',
      );
    }
  });
});
