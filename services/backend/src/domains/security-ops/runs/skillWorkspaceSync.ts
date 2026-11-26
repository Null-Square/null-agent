import fs from 'fs/promises';
import path from 'path';

import { logger } from '@/shared/logger';
import {
  SkillLoader,
  resolveDefaultSkillsDir,
  type SkillMetadata,
} from '@/domains/security-ops/skills/SkillLoader';

const normalizeSkillSlugs = (skillSlugs: readonly string[]): string[] => {
  const normalized = new Set<string>();
  for (const value of skillSlugs) {
    const slug = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (slug.length > 0) {
      normalized.add(slug);
    }
  }
  return Array.from(normalized);
};

const ensureReadableMethodology = async (targetDir: string): Promise<void> => {
  const methodologyPath = path.resolve(targetDir, 'methodology.md');
  try {
    const existing = await fs.readFile(methodologyPath, 'utf8');
    if (existing.trim().length > 0) {
      return;
    }
  } catch {
    // Fall back to SKILL.md below. Some compact compliance skills intentionally
    // keep their methodology in SKILL.md, while agent prompts always point to
    // methodology.md inside the workspace.
  }

  const skillPath = path.resolve(targetDir, 'SKILL.md');
  const skillContent = await fs.readFile(skillPath, 'utf8');
  await fs.writeFile(
    methodologyPath,
    [
      '# Methodology',
      '',
      'This skill does not ship a separate methodology.md. The SKILL.md content below is the canonical methodology for this workspace copy.',
      '',
      skillContent,
    ].join('\n'),
    'utf8',
  );
};

const copyRuntimeSkillFiles = async (
  skill: SkillMetadata,
  sourceDir: string,
  targetDir: string,
): Promise<void> => {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(
    path.resolve(sourceDir, 'SKILL.md'),
    path.resolve(targetDir, 'SKILL.md'),
  );

  for (const declaredPath of skill.supportingFiles) {
    const normalized = declaredPath.replace(/\\/gu, '/').replace(/^\.\/+/u, '');
    if (
      !normalized
      || path.isAbsolute(normalized)
      || normalized === '..'
      || normalized.startsWith('../')
      || normalized === 'fixtures'
      || normalized.startsWith('fixtures/')
    ) {
      continue;
    }
    const sourcePath = path.resolve(sourceDir, normalized);
    const sourceRelative = path.relative(sourceDir, sourcePath);
    if (sourceRelative.startsWith('..') || path.isAbsolute(sourceRelative)) {
      continue;
    }
    const targetPath = path.resolve(targetDir, normalized);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.cp(sourcePath, targetPath, { recursive: true });
  }
};

const copySkillsIntoWorkspace = async (
  skillSlugs: readonly string[],
  workspaceDir: string | null | undefined,
): Promise<string[]> => {
  if (!workspaceDir || workspaceDir.trim().length === 0) {
    logger.warn(
      { workspaceDir },
      '[skills] Missing workspaceDir; skipping workspace sync',
    );
    return [];
  }

  const normalizedSkillSlugs = normalizeSkillSlugs(skillSlugs);
  if (normalizedSkillSlugs.length === 0) {
    return [];
  }

  const skillsConfigDir = resolveDefaultSkillsDir();
  const activeCatalog = await new SkillLoader(skillsConfigDir).loadSkillCatalog();
  const activeBySlug = new Map(activeCatalog.map((skill) => [skill.slug, skill]));
  const targetRoot = path.resolve(workspaceDir, '.skills');
  await fs.mkdir(targetRoot, { recursive: true });

  const synced: string[] = [];
  for (const slug of normalizedSkillSlugs) {
    const skill = activeBySlug.get(slug);
    if (!skill) {
      logger.warn({ slug }, '[skills] Disabled or unknown skill excluded from workspace sync');
      continue;
    }
    const sourceDir = path.resolve(skillsConfigDir, slug);
    const targetDir = path.resolve(targetRoot, slug);

    try {
      await fs.access(sourceDir);
    } catch {
      logger.warn(
        { slug, sourceDir },
        '[skills] Declared skill directory missing; skipping workspace sync',
      );
      continue;
    }

    await copyRuntimeSkillFiles(skill, sourceDir, targetDir);
    await ensureReadableMethodology(targetDir);
    synced.push(slug);
  }

  if (synced.length !== normalizedSkillSlugs.length) {
    const syncedSet = new Set(synced);
    const missing = normalizedSkillSlugs.filter((slug) => !syncedSet.has(slug));
    throw new Error(`Assigned methodology could not be synchronized: ${missing.join(', ')}`);
  }

  return synced;
};

export async function syncAssignedSkillsIntoWorkspace(
  assignedSkillSlugs: string[] | null | undefined,
  workspaceDir: string | null | undefined,
): Promise<string[]> {
  return copySkillsIntoWorkspace(assignedSkillSlugs ?? [], workspaceDir);
}

const PLANNING_SKILL_SLUG = 'securityops-planning';

export async function syncPlanningSkillIntoWorkspace(
  workspaceDir: string | null | undefined,
): Promise<string[]> {
  return copySkillsIntoWorkspace([PLANNING_SKILL_SLUG], workspaceDir);
}
