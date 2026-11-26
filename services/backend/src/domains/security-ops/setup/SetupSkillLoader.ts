import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

import { logger } from '@/shared/logger';

type SetupSkillIntent = 'audit' | 'change';

type SetupSkillFrontmatter = {
  slug?: unknown;
  name?: unknown;
  title?: unknown;
  description?: unknown;
  intent?: unknown;
  use_when?: unknown;
  useWhen?: unknown;
  requires?: unknown;
  produces?: unknown;
  strong_terms?: unknown;
  strongTerms?: unknown;
  tags?: unknown;
};

export interface SetupSkillMetadata {
  slug: string;
  name: string;
  description: string;
  intent: SetupSkillIntent;
  useWhen?: string;
  requires: string[];
  produces: string[];
  strongTerms: string[];
  tags: string[];
  localPath: string;
}

export interface LoadedSetupSkill extends SetupSkillMetadata {
  content: string;
}

export interface SetupSkillRankingInput {
  text: string;
  gaps?: readonly string[];
  limit?: number;
}

export type SetupSkillRankingMatch = Pick<
  SetupSkillMetadata,
  'slug' | 'name' | 'intent' | 'useWhen' | 'requires' | 'produces' | 'tags'
> & {
  score: number;
  matchedTerms: string[];
  matchedGaps: string[];
  reasons: string[];
};

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;
const INTENTS = new Set(['audit', 'change']);

const normalize = (value: string): string => value.trim().toLowerCase();

const normalizeText = (value: string): string =>
  normalize(value).replace(/[_\s]+/g, '-');

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const optionalText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/\s+/g, ' ') : undefined;
};

const includesTerm = (haystack: string, term: string): boolean => {
  const normalizedTerm = normalizeText(term);
  return Boolean(normalizedTerm) &&
    (haystack.includes(normalizedTerm) || haystack.includes(normalizedTerm.replace(/-/g, '.')));
};

export const resolveDefaultSetupSkillsDir = (): string => {
  const candidates = [
    path.resolve(process.cwd(), 'config/setup-skills'),
    path.resolve(process.cwd(), 'services/backend/config/setup-skills'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
};

export class SetupSkillLoader {
  private catalogCache: SetupSkillMetadata[] | null = null;

  constructor(private readonly skillsDir: string = resolveDefaultSetupSkillsDir()) {}

  private async collectFiles(dir: string, acc: string[]): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.collectFiles(fullPath, acc);
        continue;
      }
      if (entry.isFile() && entry.name === 'SKILL.md') {
        acc.push(fullPath);
      }
    }
  }

  private parseSkillDocument(raw: string, filePath: string): LoadedSetupSkill | null {
    const match = FRONTMATTER_RE.exec(raw);
    if (!match) {
      logger.warn({ filePath }, '[setup-skills] Missing YAML frontmatter; skipping setup skill file');
      return null;
    }

    const frontmatter = (YAML.parse(match[1]) ?? {}) as SetupSkillFrontmatter;
    const slug = typeof frontmatter.slug === 'string' ? normalize(frontmatter.slug) : '';
    const nameSource = frontmatter.name ?? frontmatter.title;
    const name = typeof nameSource === 'string' ? nameSource.trim() : '';
    const intentValue = typeof frontmatter.intent === 'string' ? normalize(frontmatter.intent) : 'change';
    const content = (match[2] ?? '').trim();
    if (!slug || !name || !content) {
      logger.warn({ filePath }, '[setup-skills] Missing slug/name/content; skipping setup skill file');
      return null;
    }
    if (!INTENTS.has(intentValue)) {
      logger.warn({ filePath, slug, intent: intentValue }, '[setup-skills] Invalid intent; skipping setup skill file');
      return null;
    }

    return {
      slug,
      name,
      description: optionalText(frontmatter.description) ?? `Setup playbook for ${name}`,
      intent: intentValue as SetupSkillIntent,
      useWhen: optionalText(frontmatter.use_when ?? frontmatter.useWhen),
      requires: toStringArray(frontmatter.requires),
      produces: toStringArray(frontmatter.produces),
      strongTerms: toStringArray(frontmatter.strong_terms ?? frontmatter.strongTerms).map(normalize),
      tags: toStringArray(frontmatter.tags).map(normalize),
      localPath: `/workspace/.setup-skills/${slug}`,
      content,
    };
  }

  async loadCatalog(): Promise<SetupSkillMetadata[]> {
    if (this.catalogCache) return this.catalogCache;

    try {
      await fs.access(this.skillsDir);
    } catch {
      logger.warn({ skillsDir: this.skillsDir }, '[setup-skills] Setup skills directory not found');
      this.catalogCache = [];
      return [];
    }

    const files: string[] = [];
    await this.collectFiles(this.skillsDir, files);
    files.sort();

    const catalog: SetupSkillMetadata[] = [];
    for (const filePath of files) {
      try {
        const parsed = this.parseSkillDocument(await fs.readFile(filePath, 'utf8'), filePath);
        if (!parsed) continue;
        const { content: _content, ...metadata } = parsed;
        catalog.push(metadata);
      } catch (error) {
        logger.warn({ err: error, filePath }, '[setup-skills] Failed to load setup skill metadata');
      }
    }

    this.catalogCache = catalog;
    return catalog;
  }

  async loadBySlug(slug: string): Promise<LoadedSetupSkill | null> {
    const normalizedSlug = normalize(slug);
    const filePath = path.resolve(this.skillsDir, normalizedSlug, 'SKILL.md');
    try {
      return this.parseSkillDocument(await fs.readFile(filePath, 'utf8'), filePath);
    } catch (error) {
      logger.warn({ err: error, slug: normalizedSlug, filePath }, '[setup-skills] Failed to load setup skill');
      return null;
    }
  }

  async rankRelevantSkills(input: SetupSkillRankingInput): Promise<SetupSkillRankingMatch[]> {
    const catalog = await this.loadCatalog();
    const haystack = normalizeText([input.text, ...(input.gaps ?? [])].filter(Boolean).join('\n'));
    const gaps = new Set((input.gaps ?? []).map(normalizeText));
    const limit = Math.max(1, Math.min(12, Math.trunc(input.limit ?? 6)));

    const ranked = catalog
      .map((skill): SetupSkillRankingMatch | null => {
        const searchableTerms = [...skill.strongTerms, ...skill.tags, ...skill.produces, skill.slug].map(normalize);
        const matchedTerms = searchableTerms.filter((term) => includesTerm(haystack, term));
        const matchedGaps = skill.tags.filter((tag) => gaps.has(normalizeText(tag)));
        let score = matchedTerms.length * 5 + matchedGaps.length * 8;
        const reasons: string[] = [];
        if (matchedTerms.length > 0) reasons.push(`terms:${matchedTerms.slice(0, 4).join(',')}`);
        if (matchedGaps.length > 0) reasons.push(`gaps:${matchedGaps.slice(0, 4).join(',')}`);
        if (skill.intent === 'audit' && includesTerm(haystack, 'readiness')) {
          score += 4;
          reasons.push('readiness-audit');
        }
        if (score <= 0) return null;
        return {
          slug: skill.slug,
          name: skill.name,
          intent: skill.intent,
          useWhen: skill.useWhen,
          requires: skill.requires,
          produces: skill.produces,
          tags: skill.tags,
          score,
          matchedTerms: Array.from(new Set(matchedTerms)),
          matchedGaps,
          reasons,
        };
      })
      .filter((entry): entry is SetupSkillRankingMatch => entry !== null)
      .sort((left, right) => right.score - left.score || left.slug.localeCompare(right.slug))
      .slice(0, limit);

    if (ranked.length > 0) return ranked;

    return catalog
      .filter((skill) => skill.slug === 'engagement-readiness-check')
      .slice(0, 1)
      .map((skill) => ({
        slug: skill.slug,
        name: skill.name,
        intent: skill.intent,
        useWhen: skill.useWhen,
        requires: skill.requires,
        produces: skill.produces,
        tags: skill.tags,
        score: 1,
        matchedTerms: [],
        matchedGaps: [],
        reasons: ['fallback'],
      }));
  }
}
