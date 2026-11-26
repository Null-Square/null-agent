import {
  SkillLoader,
  type SkillMetadata,
} from '@/domains/security-ops/skills/SkillLoader';
import {
  phaseProfileRegistry,
  type RunPhaseKey,
} from '@/domains/security-ops/runs/PhaseProfileRegistry';

export type { LoadedSkill, SkillMetadata } from '@/domains/security-ops/skills/SkillLoader';

export interface RunSkillContextPort {
  buildAssignedSkillsContext(
    orgId: string,
    scopeId: string,
    assignedSkillSlugs: readonly string[],
  ): Promise<string>;
  buildPhaseCompatibleSkillCatalogContext(
    orgId: string,
    scopeId: string,
    phaseKey: RunPhaseKey,
    assignedSkillSlugs: readonly string[],
  ): Promise<string>;
}

const normalize = (value: string): string => value.trim().toLowerCase();

// Catalog lines stay compact: enough for an executor to recognize a relevant
// methodology and reach for it, not the full frontmatter dump.
const MAX_CATALOG_DESCRIPTION_CHARS = 200;
const MAX_CATALOG_USE_WHEN_CHARS = 240;

const truncate = (value: string, max: number): string => {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
};

export type RunSkillContextServiceDeps = {
  skillLoader?: SkillLoader;
};

export class RunSkillContextService implements RunSkillContextPort {
  private readonly skillLoader: SkillLoader;

  constructor(deps: RunSkillContextServiceDeps = {}) {
    this.skillLoader = deps.skillLoader ?? new SkillLoader();
  }

  async buildAssignedSkillsContext(
    _orgId: string,
    _scopeId: string,
    assignedSkillSlugs: readonly string[],
  ): Promise<string> {
    const normalizedSlugs = this.normalizeAndDeduplicateSlugs(assignedSkillSlugs);
    if (normalizedSlugs.length === 0) {
      return '';
    }

    const catalog = await this.skillLoader.loadSkillCatalog();
    const bySlug = new Map(catalog.map((skill) => [normalize(skill.slug), skill]));

    const lines: string[] = ['=== ASSIGNED METHODOLOGIES ==='];
    for (const slug of normalizedSlugs) {
      const skill = bySlug.get(slug);
      const loadPath = skill?.localPath ?? `/workspace/.skills/${slug}`;
      // A bare path gives the executor no reason to open the file; the
      // description and use-when line are what make an assigned skill get used.
      lines.push(
        `- ${slug}: ${skill ? truncate(skill.description, MAX_CATALOG_DESCRIPTION_CHARS) : 'Assigned by the planner.'}`,
        `  Use when: ${skill ? truncate(this.buildUseWhenHint(skill), MAX_CATALOG_USE_WHEN_CHARS) : 'the task objective matches this methodology.'}`,
        `  Methodology path: ${loadPath}/methodology.md`,
      );
    }

    return lines.join('\n');
  }

  async buildPhaseCompatibleSkillCatalogContext(
    _orgId: string,
    _scopeId: string,
    phaseKey: RunPhaseKey,
    assignedSkillSlugs: readonly string[],
  ): Promise<string> {
    const assigned = new Set(this.normalizeAndDeduplicateSlugs(assignedSkillSlugs));
    const catalog = await this.skillLoader.loadSkillCatalog();
    const compatible = catalog
      .filter((skill) => skill.phase !== 'planning')
      .filter((skill) => phaseProfileRegistry.validateSkillAssignment(phaseKey, skill) === null)
      .sort((left, right) => {
        const leftAssigned = assigned.has(normalize(left.slug)) ? 0 : 1;
        const rightAssigned = assigned.has(normalize(right.slug)) ? 0 : 1;
        return leftAssigned - rightAssigned || left.slug.localeCompare(right.slug);
      });

    if (compatible.length === 0) {
      return '';
    }

    const lines = compatible.flatMap((skill) => {
      const marker = assigned.has(normalize(skill.slug)) ? 'assigned' : 'phase-compatible';
      return [
        `- ${skill.slug} (${marker}): ${truncate(skill.description, MAX_CATALOG_DESCRIPTION_CHARS)}`,
        `  Use when: ${truncate(this.buildUseWhenHint(skill), MAX_CATALOG_USE_WHEN_CHARS)}`,
      ];
    });

    return [
      '=== PHASE-COMPATIBLE WORKER SKILLS ===',
      `Phase: ${phaseKey}`,
      'These methodologies are available to this phase. Load one with load_skill when the task matches its use-when; pass a slug to a worker mission when the worker task needs that methodology.',
      ...lines,
    ].join('\n');
  }

  private normalizeAndDeduplicateSlugs(skillSlugs: readonly string[]): string[] {
    const normalized = new Set<string>();
    for (const value of skillSlugs) {
      const slug = typeof value === 'string' ? normalize(value) : '';
      if (slug) {
        normalized.add(slug);
      }
    }
    return Array.from(normalized);
  }

  private buildUseWhenHint(skill: SkillMetadata): string {
    if (skill.useWhen) {
      return skill.useWhen;
    }
    if (skill.techTriggers.length > 0) {
      return `target technologies include ${skill.techTriggers.join(', ')}.`;
    }
    if (skill.ntypeTriggers.length > 0) {
      return `observations indicate ${skill.ntypeTriggers.join(', ')} patterns.`;
    }
    return 'the task objective matches this methodology.';
  }

}

export const securityOpsRunSkillContextService = new RunSkillContextService();
