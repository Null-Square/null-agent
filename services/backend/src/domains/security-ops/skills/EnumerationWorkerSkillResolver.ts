import { createHash } from 'crypto';

import type { EnumerationMissionV1 } from '@/domains/agent-brain/domain/types';
import {
  B1_ACCEPTED_CATALOG_DIGEST,
} from '@/domains/agent-brain/domain/workers/enumerationContracts';
import {
  SkillLoader,
  type LoadedSkill,
  type SkillMetadata,
} from './SkillLoader';

export type EnumerationSkillClassification =
  | 'primary_eligible'
  | 'supporting_eligible'
  | 'excluded';

export interface EnumerationSkillEligibilityEntry {
  slug: string;
  category: string;
  riskTier: SkillMetadata['riskTier'];
  versionHash: string;
  classification: EnumerationSkillClassification;
}

export interface EnumerationSkillEligibilityReport {
  schemaVersion: 1;
  reportKind: 'enumeration-worker-v1-eligibility';
  catalogVersion: string;
  catalogDigest: string;
  acceptedCatalogDigest: string;
  counts: {
    total: number;
    primaryEligible: number;
    supportingEligible: number;
    excluded: number;
  };
  entries: EnumerationSkillEligibilityEntry[];
}

export interface ResolvedEnumerationSkillSelection {
  primary: LoadedSkill;
  supporting: LoadedSkill[];
  catalogVersion: string;
  catalogDigest: string;
}

export type EnumerationCatalogAdmission =
  | { kind: 'accepted' }
  | {
      kind: 'evaluation_candidate';
      expectedCatalogDigest: string;
    };

const PRIMARY_CATEGORIES = new Set(['vulnerability', 'enumeration', 'recon']);
const CANONICAL_OUTPUT_TOOLS = new Set([
  'report_note',
  'report_finding',
  'promote_finding',
  'submit_validation_outcome',
  'submit_validation_lead_outcome',
  'ingest_scan_artifact',
]);
const OOB_DEPENDENT_SKILLS = new Set(['tooling-interactsh']);

const normalize = (value: string): string => value.trim().toLowerCase();

export const classifyEnumerationWorkerSkill = (
  skill: Pick<SkillMetadata, 'slug' | 'category'>,
): EnumerationSkillClassification => {
  const category = normalize(skill.category);
  if (PRIMARY_CATEGORIES.has(category)) {
    return 'primary_eligible';
  }
  if (category === 'tooling') {
    return 'supporting_eligible';
  }
  return 'excluded';
};

export const computeSkillCatalogDigest = (
  skills: readonly Pick<SkillMetadata, 'slug' | 'versionHash'>[],
): string =>
  createHash('sha256')
    .update(
      skills
        .map((skill) => `${skill.slug}:${skill.versionHash}`)
        .sort()
        .join('\n'),
      'utf8',
    )
    .digest('hex');

export class EnumerationWorkerSkillResolver {
  constructor(private readonly skillLoader = new SkillLoader()) {}

  async buildEligibilityReport(): Promise<EnumerationSkillEligibilityReport> {
    const manifest = await this.skillLoader.getCatalogManifest();
    // The B1 enumeration-worker release is a frozen Pentest capability set.
    // Product-specific Code Review methodologies share the package loader, but
    // must never alter this release's digest or become enumeration-worker
    // candidates.
    const skills = (await this.skillLoader.loadSkillCatalog())
      .filter((skill) => skill.releaseTrack === 'b1');
    const entries = skills
      .map<EnumerationSkillEligibilityEntry>((skill) => ({
        slug: skill.slug,
        category: skill.category,
        riskTier: skill.riskTier,
        versionHash: skill.versionHash,
        classification: classifyEnumerationWorkerSkill(skill),
      }))
      .sort((left, right) => left.slug.localeCompare(right.slug));
    return {
      schemaVersion: 1,
      reportKind: 'enumeration-worker-v1-eligibility',
      catalogVersion: manifest.catalogVersion,
      catalogDigest: computeSkillCatalogDigest(skills),
      acceptedCatalogDigest: B1_ACCEPTED_CATALOG_DIGEST,
      counts: {
        total: entries.length,
        primaryEligible: entries.filter((entry) => entry.classification === 'primary_eligible').length,
        supportingEligible: entries.filter((entry) => entry.classification === 'supporting_eligible').length,
        excluded: entries.filter((entry) => entry.classification === 'excluded').length,
      },
      entries,
    };
  }

  async assertAcceptedCatalog(): Promise<EnumerationSkillEligibilityReport> {
    return this.assertCatalogAdmission({ kind: 'accepted' });
  }

  async assertCatalogAdmission(
    admission: EnumerationCatalogAdmission = { kind: 'accepted' },
  ): Promise<EnumerationSkillEligibilityReport> {
    const report = await this.buildEligibilityReport();
    // The platform path no longer freezes the catalog to a fixed version, an
    // exact classification count, or one accepted digest. That ceremony made
    // every methodology restoration a build-breaking event and pinned the
    // catalog to its thinned B1 shape. Reproducibility that a benchmark needs
    // is kept below, opt-in, behind the isolated evaluation runner.
    if (admission.kind === 'evaluation_candidate') {
      if (process.env.NULL_EVAL_ISOLATED_RUNNER !== '1') {
        throw new Error('enumeration_worker evaluation_candidate_isolation_required');
      }
      const expectedCatalogDigest = admission.expectedCatalogDigest.trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/u.test(expectedCatalogDigest)) {
        throw new Error('enumeration_worker evaluation_candidate_digest_invalid');
      }
      if (report.catalogDigest !== expectedCatalogDigest) {
        throw new Error(
          `enumeration_worker evaluation_candidate_digest_mismatch: expected ${expectedCatalogDigest}, received ${report.catalogDigest}`,
        );
      }
      return report;
    }
    return report;
  }

  async resolve(params: {
    mission: EnumerationMissionV1;
    executableTools: readonly string[];
    runtimeSourceMode?: string;
    runImpactTolerance?: string;
    catalogAdmission?: EnumerationCatalogAdmission;
  }): Promise<ResolvedEnumerationSkillSelection> {
    const report = await this.assertCatalogAdmission(params.catalogAdmission);
    if (!params.runtimeSourceMode || params.runtimeSourceMode !== params.mission.sourceMode) {
      throw new Error(
        `enumeration_worker source_mode_mismatch: mission=${params.mission.sourceMode}, run=${params.runtimeSourceMode ?? 'missing'}`,
      );
    }
    if (!params.runImpactTolerance || !['non_destructive', 'poc', 'full'].includes(params.runImpactTolerance)) {
      throw new Error('enumeration_worker impact_context_missing');
    }
    if (
      params.mission.impactCeiling === 'poc' &&
      params.runImpactTolerance === 'non_destructive'
    ) {
      throw new Error('enumeration_worker impact_denied: poc mission exceeds the run impact tolerance');
    }

    const primary = await this.requireVersionedSkill(
      params.mission.primarySkill.slug,
      params.mission.primarySkill.versionHash,
    );
    const supporting = await Promise.all(
      params.mission.supportingSkills.map((skill) =>
        this.requireVersionedSkill(skill.slug, skill.versionHash)
      ),
    );
    const selected = [primary, ...supporting];
    if (new Set(selected.map((skill) => skill.slug)).size !== selected.length) {
      throw new Error('enumeration_worker skill_duplicate: primary and supporting skills must be unique');
    }
    if (classifyEnumerationWorkerSkill(primary) !== 'primary_eligible') {
      throw new Error(
        `enumeration_worker primary_skill_ineligible: ${primary.slug} (${primary.category})`,
      );
    }
    for (const skill of supporting) {
      if (classifyEnumerationWorkerSkill(skill) === 'excluded') {
        throw new Error(
          `enumeration_worker supporting_skill_ineligible: ${skill.slug} (${skill.category})`,
        );
      }
    }

    const availableTools = new Set(params.executableTools);
    for (const skill of selected) {
      if (OOB_DEPENDENT_SKILLS.has(skill.slug)) {
        throw new Error(
          `enumeration_worker skill_tool_unavailable: ${skill.slug} requires OOB execution, which is excluded in v1`,
        );
      }
      if (skill.riskTier === 'restricted') {
        throw new Error(`enumeration_worker restricted_skill_denied: ${skill.slug}`);
      }
      if (
        skill.riskTier === 'sensitive' &&
        !['poc', 'full'].includes(params.runImpactTolerance ?? '')
      ) {
        throw new Error(
          `enumeration_worker sensitive_skill_impact_denied: ${skill.slug} requires poc or full run tolerance`,
        );
      }
      if (!skill.sourceModes.includes(params.mission.sourceMode)) {
        throw new Error(
          `enumeration_worker skill_source_mode_mismatch: ${skill.slug} does not support ${params.mission.sourceMode}`,
        );
      }
      const missingExecutionTools = skill.requiredTools.filter((tool) => {
        if (CANONICAL_OUTPUT_TOOLS.has(tool)) {
          return !availableTools.has('submit_worker_result');
        }
        return !availableTools.has(tool);
      });
      if (missingExecutionTools.length > 0) {
        throw new Error(
          `enumeration_worker skill_tool_unavailable: ${skill.slug} needs ${missingExecutionTools.join(', ')}`,
        );
      }
    }

    const methodologyTechniques = new Set(selected.flatMap((skill) => skill.techniqueIds));
    const unknownTechniques = params.mission.techniqueIds.filter(
      (techniqueId) => !methodologyTechniques.has(techniqueId),
    );
    if (unknownTechniques.length > 0) {
      throw new Error(
        `enumeration_worker technique_not_owned_by_skills: ${unknownTechniques.join(', ')}`,
      );
    }

    return {
      primary,
      supporting,
      catalogVersion: report.catalogVersion,
      catalogDigest: report.catalogDigest,
    };
  }

  private async requireVersionedSkill(slug: string, versionHash: string): Promise<LoadedSkill> {
    const skill = await this.skillLoader.loadSkillBySlug(slug);
    if (!skill) {
      throw new Error(`enumeration_worker skill_not_found: ${slug}`);
    }
    if (skill.versionHash !== versionHash) {
      throw new Error(
        `enumeration_worker skill_hash_mismatch: ${slug} expected ${versionHash}, received ${skill.versionHash}`,
      );
    }
    return skill;
  }
}
