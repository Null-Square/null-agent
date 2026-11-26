import { createHash } from 'crypto';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

type SkillFrontmatter = {
  slug?: unknown;
  name?: unknown;
  title?: unknown;
  description?: unknown;
  phase?: unknown;
  compatible_phases?: unknown;
  compatiblePhases?: unknown;
  category?: unknown;
  required_tools?: unknown;
  requiredTools?: unknown;
  tool_alternatives?: unknown;
  toolAlternatives?: unknown;
  risk_tier?: unknown;
  riskTier?: unknown;
  freshScopePriority?: unknown;
  use_when?: unknown;
  useWhen?: unknown;
  not_when?: unknown;
  notWhen?: unknown;
  required_inputs?: unknown;
  requiredInputs?: unknown;
  expected_outputs?: unknown;
  expectedOutputs?: unknown;
  produces?: unknown;
  evidence_floor?: unknown;
  evidenceFloor?: unknown;
  strong_terms?: unknown;
  strongTerms?: unknown;
  follow_up_triggers?: unknown;
  followUpTriggers?: unknown;
  tech_triggers?: unknown;
  techTriggers?: unknown;
  ntype_triggers?: unknown;
  ntypeTriggers?: unknown;
  technique_ids?: unknown;
  techniqueIds?: unknown;
  source_modes?: unknown;
  sourceModes?: unknown;
  related_skills?: unknown;
  relatedSkills?: unknown;
  handoff_skills?: unknown;
  handoffSkills?: unknown;
  mutation_applicability?: unknown;
  mutationApplicability?: unknown;
  mutation_not_applicable_reason?: unknown;
  mutationNotApplicableReason?: unknown;
  supporting_files?: unknown;
  supportingFiles?: unknown;
  fixture_manifest?: unknown;
  fixtureManifest?: unknown;
};

export type SkillRiskTier = 'low' | 'standard' | 'sensitive' | 'restricted';
export type SkillSourceMode = 'blackbox' | 'greybox' | 'whitebox';
export type MutationApplicability = 'applicable' | 'not_applicable';
export type SkillDeliveryScope = 'existing' | 'deepened' | 'new';
export type SkillReleaseTrack = 'b1' | 'product-extension';

export interface SkillMetadata {
  slug: string;
  name: string;
  description: string;
  phase: string;
  compatiblePhases: string[];
  category: string;
  requiredTools: string[];
  toolAlternatives: string[];
  riskTier: SkillRiskTier;
  freshScopePriority?: string;
  useWhen: string;
  notWhen: string;
  requiredInputs: string[];
  expectedOutputs: string[];
  evidenceFloor: string;
  strongTerms: string[];
  followUpTriggers: string[];
  techTriggers: string[];
  ntypeTriggers: string[];
  techniqueIds: string[];
  sourceModes: SkillSourceMode[];
  relatedSkills: string[];
  handoffSkills: string[];
  mutationApplicability: MutationApplicability;
  mutationNotApplicableReason?: string;
  supportingFiles: string[];
  fixtureManifest: string;
  versionHash: string;
  enabled: boolean;
  ownerCategory: string;
  deliveryScope: SkillDeliveryScope;
  releaseTrack: SkillReleaseTrack;
  catalogVersion: string;
  localPath: string;
}

export interface LoadedSkill extends SkillMetadata {
  content: string;
  methodologyContent?: string;
}

export interface SkillCatalogEntry {
  slug: string;
  enabled: boolean;
  ownerCategory: string;
  deliveryScope: SkillDeliveryScope;
  releaseTrack: SkillReleaseTrack;
}

export interface SkillCatalogManifest {
  schemaVersion: number;
  catalogVersion: string;
  expectedActiveCount: number;
  skills: SkillCatalogEntry[];
}

export interface LoadSkillCatalogOptions {
  includeDisabled?: boolean;
}

export interface LoadSkillOptions {
  includeDisabled?: boolean;
  auditReason?: string;
}

export type SkillLoaderMode = 'runtime' | 'evaluation';
export type RuntimeSnapshotPolicy = 'require' | 'verify-if-present' | 'ignore';

export interface SkillLoaderOptions {
  mode?: SkillLoaderMode;
  runtimeSnapshotPolicy?: RuntimeSnapshotPolicy;
}

export interface RuntimeSkillCatalogSnapshotEntry {
  slug: string;
  versionHash: string;
  runtimeHash: string;
}

export interface RuntimeSkillCatalogSnapshot {
  schemaVersion: 1;
  catalogVersion: string;
  skills: RuntimeSkillCatalogSnapshotEntry[];
}

type CatalogFile = {
  schema_version?: unknown;
  catalog_version?: unknown;
  expected_active_count?: unknown;
  skills?: unknown;
};

type FixtureManifestFile = {
  schema_version?: unknown;
  skill?: unknown;
  files?: unknown;
};

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;
const CANONICAL_PHASES = new Set([
  'planning',
  'recon',
  'enumeration',
  'validation',
  'evidence',
  'control_assessment',
  'reporting',
  'review_mapping',
  'review_analysis',
  'review_validation',
  'review_reporting',
]);
const RISK_TIERS = new Set<SkillRiskTier>(['low', 'standard', 'sensitive', 'restricted']);
const SOURCE_MODES = new Set<SkillSourceMode>(['blackbox', 'greybox', 'whitebox']);
const MUTATION_APPLICABILITY = new Set<MutationApplicability>(['applicable', 'not_applicable']);
const DELIVERY_SCOPES = new Set<SkillDeliveryScope>(['existing', 'deepened', 'new']);
const RELEASE_TRACKS = new Set<SkillReleaseTrack>(['b1', 'product-extension']);
const GENERIC_ROUTING_TERMS = new Set([
  'and',
  'assessment',
  'operation',
  'security',
  'skill',
  'testing',
  'tooling',
  'validation',
  'vulnerability',
  'web',
]);
const CATALOG_FILE = 'catalog.yaml';
export const RUNTIME_CATALOG_SNAPSHOT_FILE = 'runtime-catalog.snapshot.json';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

const normalize = (value: string): string => value.trim().toLowerCase();
const normalizePath = (value: string): string => value.replace(/\\/g, '/');
const normalizeContent = (value: string): string => value.replace(/\r\n?/g, '\n');
const isEvaluationOnlyPath = (value: string): boolean =>
  normalizePath(value).split('/').includes('fixtures');

const normalizeOptionalField = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = normalize(value);
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeOptionalText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.replace(/\s+/g, ' ') : undefined;
};

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const unique = <T>(values: readonly T[]): T[] => Array.from(new Set(values));

const requiredText = (value: unknown, field: string, errors: string[]): string => {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    errors.push(`${field} must be a non-empty string`);
    return '';
  }
  return normalized;
};

const requiredField = (value: unknown, field: string, errors: string[]): string => {
  const normalized = normalizeOptionalField(value);
  if (!normalized) {
    errors.push(`${field} must be a non-empty string`);
    return '';
  }
  return normalized;
};

const requiredArray = (
  value: unknown,
  field: string,
  errors: string[],
  options: { allowEmpty?: boolean; normalizeValues?: boolean } = {},
): string[] => {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return [];
  }
  const entries = toStringArray(value);
  if (!options.allowEmpty && entries.length === 0) {
    errors.push(`${field} must contain at least one value`);
  }
  const values = options.normalizeValues ? entries.map(normalize) : entries;
  if (new Set(values).size !== values.length) {
    errors.push(`${field} must not contain duplicate values`);
  }
  return values;
};

export class SkillCatalogValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(`Skill catalog validation failed:\n- ${errors.join('\n- ')}`);
    this.name = 'SkillCatalogValidationError';
  }
}

export const resolveDefaultSkillsDir = (): string => {
  const candidates = [
    path.resolve(process.cwd(), 'config/skills'),
    path.resolve(process.cwd(), 'services/backend/config/skills'),
    path.resolve(__dirname, '../../../..', 'config/skills'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
};

export class SkillLoader {
  private activeCatalogCache: SkillMetadata[] | null = null;
  private completeCatalogCache: SkillMetadata[] | null = null;
  private loadedSkillsCache = new Map<string, LoadedSkill>();
  private manifestCache: SkillCatalogManifest | null = null;
  private runtimeHashesCache = new Map<string, string>();
  private runtimeSnapshotCache: RuntimeSkillCatalogSnapshot | null | undefined;
  private readonly mode: SkillLoaderMode;
  private readonly runtimeSnapshotPolicy: RuntimeSnapshotPolicy;

  constructor(
    private readonly skillsDir: string = resolveDefaultSkillsDir(),
    options: SkillLoaderOptions = {},
  ) {
    this.mode = options.mode ?? 'runtime';
    this.runtimeSnapshotPolicy = options.runtimeSnapshotPolicy
      ?? (this.mode === 'runtime' ? 'require' : 'verify-if-present');
  }

  get rootDir(): string {
    return this.skillsDir;
  }

  clearCache(): void {
    this.activeCatalogCache = null;
    this.completeCatalogCache = null;
    this.loadedSkillsCache = new Map();
    this.manifestCache = null;
    this.runtimeHashesCache = new Map();
    this.runtimeSnapshotCache = undefined;
  }

  private async collectFiles(
    dir: string,
    acc: string[],
    predicate: (entryName: string) => boolean,
  ): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new SkillCatalogValidationError([
          `symbolic links are not allowed in skill packages: ${normalizePath(path.relative(this.skillsDir, fullPath))}`,
        ]);
      }
      if (entry.isDirectory()) {
        await this.collectFiles(fullPath, acc, predicate);
        continue;
      }
      if (entry.isFile() && predicate(entry.name)) {
        acc.push(fullPath);
      }
    }
  }

  private async resolveDeclaredFile(
    skillDir: string,
    relativePath: string,
    field: string,
  ): Promise<string> {
    const normalizedRelative = normalizePath(relativePath.trim());
    if (
      normalizedRelative.length === 0 ||
      path.isAbsolute(relativePath) ||
      normalizedRelative.startsWith('/') ||
      normalizedRelative.split('/').some((segment) => segment === '..' || segment === '')
    ) {
      throw new SkillCatalogValidationError([
        `${field} contains an unsafe path: ${relativePath}`,
      ]);
    }

    const resolved = path.resolve(skillDir, ...normalizedRelative.split('/'));
    const relativeToRoot = path.relative(skillDir, resolved);
    if (
      relativeToRoot.startsWith('..') ||
      path.isAbsolute(relativeToRoot)
    ) {
      throw new SkillCatalogValidationError([
        `${field} escapes the skill package: ${relativePath}`,
      ]);
    }

    const segments = normalizedRelative.split('/');
    let cursor = skillDir;
    for (const segment of segments) {
      cursor = path.join(cursor, segment);
      let stat;
      try {
        stat = await fs.lstat(cursor);
      } catch {
        throw new SkillCatalogValidationError([
          `${field} references a missing file: ${relativePath}`,
        ]);
      }
      if (stat.isSymbolicLink()) {
        throw new SkillCatalogValidationError([
          `${field} references a symbolic link: ${relativePath}`,
        ]);
      }
    }

    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      throw new SkillCatalogValidationError([
        `${field} must reference a file: ${relativePath}`,
      ]);
    }
    return resolved;
  }

  private async loadManifest(): Promise<SkillCatalogManifest> {
    if (this.manifestCache) {
      return this.manifestCache;
    }

    const manifestPath = path.resolve(this.skillsDir, CATALOG_FILE);
    let parsed: CatalogFile;
    try {
      parsed = (YAML.parse(await fs.readFile(manifestPath, 'utf8')) ?? {}) as CatalogFile;
    } catch (error) {
      throw new SkillCatalogValidationError([
        `unable to read ${CATALOG_FILE}: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }

    const errors: string[] = [];
    const schemaVersion = typeof parsed.schema_version === 'number'
      ? parsed.schema_version
      : Number.NaN;
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
      errors.push('catalog schema_version must be a positive integer');
    }
    const catalogVersion = requiredText(parsed.catalog_version, 'catalog_version', errors);
    const expectedActiveCount = typeof parsed.expected_active_count === 'number'
      ? parsed.expected_active_count
      : Number.NaN;
    if (!Number.isInteger(expectedActiveCount) || expectedActiveCount < 1) {
      errors.push('expected_active_count must be a positive integer');
    }
    if (!Array.isArray(parsed.skills)) {
      errors.push('catalog skills must be an array');
    }

    const skills: SkillCatalogEntry[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of (Array.isArray(parsed.skills) ? parsed.skills : []).entries()) {
      const entry = typeof raw === 'object' && raw !== null
        ? raw as Record<string, unknown>
        : {};
      const slug = requiredField(entry.slug, `skills[${index}].slug`, errors);
      if (slug && (!SLUG_RE.test(slug) || seen.has(slug))) {
        errors.push(
          seen.has(slug)
            ? `catalog contains duplicate slug: ${slug}`
            : `catalog slug is invalid: ${slug}`,
        );
      }
      seen.add(slug);
      if (typeof entry.enabled !== 'boolean') {
        errors.push(`skills[${index}].enabled must be boolean`);
      }
      const ownerCategory = requiredField(
        entry.owner_category,
        `skills[${index}].owner_category`,
        errors,
      );
      const deliveryScope = requiredField(
        entry.delivery_scope,
        `skills[${index}].delivery_scope`,
        errors,
      ) as SkillDeliveryScope;
      if (deliveryScope && !DELIVERY_SCOPES.has(deliveryScope)) {
        errors.push(`skills[${index}].delivery_scope is invalid: ${deliveryScope}`);
      }
      const releaseTrack = (
        normalizeOptionalField(entry.release_track) ?? 'b1'
      ) as SkillReleaseTrack;
      if (!RELEASE_TRACKS.has(releaseTrack)) {
        errors.push(`skills[${index}].release_track is invalid: ${releaseTrack}`);
      }
      skills.push({
        slug,
        enabled: entry.enabled === true,
        ownerCategory,
        deliveryScope,
        releaseTrack,
      });
    }

    const activeCount = skills.filter((entry) => entry.enabled).length;
    if (Number.isInteger(expectedActiveCount) && activeCount !== expectedActiveCount) {
      errors.push(
        `catalog expected_active_count=${expectedActiveCount} but contains ${activeCount} enabled entries`,
      );
    }
    if (errors.length > 0) {
      throw new SkillCatalogValidationError(errors);
    }

    this.manifestCache = {
      schemaVersion,
      catalogVersion,
      expectedActiveCount,
      skills,
    };
    return this.manifestCache;
  }

  private parseSkillDocument(
    raw: string,
    filePath: string,
    catalogEntry: SkillCatalogEntry,
    catalogVersion: string,
  ): { skill: LoadedSkill; frontmatter: SkillFrontmatter } {
    const match = FRONTMATTER_RE.exec(raw);
    if (!match) {
      throw new SkillCatalogValidationError([
        `${normalizePath(path.relative(this.skillsDir, filePath))} is missing YAML frontmatter`,
      ]);
    }

    const frontmatter = (YAML.parse(match[1]) ?? {}) as SkillFrontmatter;
    const content = (match[2] ?? '').trim();
    const relativeFile = normalizePath(path.relative(this.skillsDir, filePath));
    const errors: string[] = [];

    const slug = requiredField(frontmatter.slug, `${relativeFile}: slug`, errors);
    const name = requiredText(frontmatter.name ?? frontmatter.title, `${relativeFile}: name`, errors);
    const description = requiredText(frontmatter.description, `${relativeFile}: description`, errors);
    const phase = requiredField(frontmatter.phase, `${relativeFile}: phase`, errors);
    if (phase && !CANONICAL_PHASES.has(phase)) {
      errors.push(`${relativeFile}: phase is invalid: ${phase}`);
    }
    const compatiblePhases = requiredArray(
      frontmatter.compatible_phases ?? frontmatter.compatiblePhases,
      `${relativeFile}: compatible_phases`,
      errors,
      { normalizeValues: true },
    );
    for (const compatiblePhase of compatiblePhases) {
      if (!CANONICAL_PHASES.has(compatiblePhase)) {
        errors.push(`${relativeFile}: compatible_phases contains invalid phase: ${compatiblePhase}`);
      }
    }
    const category = requiredField(frontmatter.category, `${relativeFile}: category`, errors);
    const requiredTools = requiredArray(
      frontmatter.required_tools ?? frontmatter.requiredTools,
      `${relativeFile}: required_tools`,
      errors,
    );
    const toolAlternatives = requiredArray(
      frontmatter.tool_alternatives ?? frontmatter.toolAlternatives,
      `${relativeFile}: tool_alternatives`,
      errors,
      { allowEmpty: true },
    );
    const riskTier = requiredField(
      frontmatter.risk_tier ?? frontmatter.riskTier,
      `${relativeFile}: risk_tier`,
      errors,
    ) as SkillRiskTier;
    if (riskTier && !RISK_TIERS.has(riskTier)) {
      errors.push(`${relativeFile}: risk_tier is invalid: ${riskTier}`);
    }
    const freshScopePriority = normalizeOptionalField(frontmatter.freshScopePriority);
    const useWhen = requiredText(
      frontmatter.use_when ?? frontmatter.useWhen,
      `${relativeFile}: use_when`,
      errors,
    );
    const notWhen = requiredText(
      frontmatter.not_when ?? frontmatter.notWhen,
      `${relativeFile}: not_when`,
      errors,
    );
    const requiredInputs = requiredArray(
      frontmatter.required_inputs ?? frontmatter.requiredInputs,
      `${relativeFile}: required_inputs`,
      errors,
    );
    const expectedOutputs = requiredArray(
      frontmatter.expected_outputs ?? frontmatter.expectedOutputs ?? frontmatter.produces,
      `${relativeFile}: expected_outputs`,
      errors,
    );
    const evidenceFloor = requiredText(
      frontmatter.evidence_floor ?? frontmatter.evidenceFloor,
      `${relativeFile}: evidence_floor`,
      errors,
    );
    const strongTerms = requiredArray(
      frontmatter.strong_terms ?? frontmatter.strongTerms,
      `${relativeFile}: strong_terms`,
      errors,
      { normalizeValues: true },
    );
    for (const term of strongTerms) {
      if (GENERIC_ROUTING_TERMS.has(term)) {
        errors.push(`${relativeFile}: strong_terms contains generic filler term: ${term}`);
      }
    }
    const followUpTriggers = requiredArray(
      frontmatter.follow_up_triggers ?? frontmatter.followUpTriggers,
      `${relativeFile}: follow_up_triggers`,
      errors,
    );
    const techTriggers = requiredArray(
      frontmatter.tech_triggers ?? frontmatter.techTriggers,
      `${relativeFile}: tech_triggers`,
      errors,
      { allowEmpty: true, normalizeValues: true },
    );
    const ntypeTriggers = requiredArray(
      frontmatter.ntype_triggers ?? frontmatter.ntypeTriggers,
      `${relativeFile}: ntype_triggers`,
      errors,
      { allowEmpty: true, normalizeValues: true },
    );
    const techniqueIds = requiredArray(
      frontmatter.technique_ids ?? frontmatter.techniqueIds,
      `${relativeFile}: technique_ids`,
      errors,
    );
    const sourceModes = requiredArray(
      frontmatter.source_modes ?? frontmatter.sourceModes,
      `${relativeFile}: source_modes`,
      errors,
      { normalizeValues: true },
    ) as SkillSourceMode[];
    for (const sourceMode of sourceModes) {
      if (!SOURCE_MODES.has(sourceMode)) {
        errors.push(`${relativeFile}: source_modes contains invalid mode: ${sourceMode}`);
      }
    }
    const relatedSkills = requiredArray(
      frontmatter.related_skills ?? frontmatter.relatedSkills,
      `${relativeFile}: related_skills`,
      errors,
      { allowEmpty: true, normalizeValues: true },
    );
    const handoffSkills = requiredArray(
      frontmatter.handoff_skills ?? frontmatter.handoffSkills,
      `${relativeFile}: handoff_skills`,
      errors,
      { allowEmpty: true, normalizeValues: true },
    );
    const mutationApplicability = requiredField(
      frontmatter.mutation_applicability ?? frontmatter.mutationApplicability,
      `${relativeFile}: mutation_applicability`,
      errors,
    ) as MutationApplicability;
    if (mutationApplicability && !MUTATION_APPLICABILITY.has(mutationApplicability)) {
      errors.push(`${relativeFile}: mutation_applicability is invalid: ${mutationApplicability}`);
    }
    const mutationNotApplicableReason = normalizeOptionalText(
      frontmatter.mutation_not_applicable_reason ?? frontmatter.mutationNotApplicableReason,
    );
    if (mutationApplicability === 'not_applicable' && !mutationNotApplicableReason) {
      errors.push(
        `${relativeFile}: mutation_not_applicable_reason is required when mutation_applicability is not_applicable`,
      );
    }
    const supportingFiles = requiredArray(
      frontmatter.supporting_files ?? frontmatter.supportingFiles,
      `${relativeFile}: supporting_files`,
      errors,
    ).map(normalizePath);
    const fixtureManifest = requiredText(
      frontmatter.fixture_manifest ?? frontmatter.fixtureManifest,
      `${relativeFile}: fixture_manifest`,
      errors,
    );

    if (!content) {
      errors.push(`${relativeFile}: skill body must not be empty`);
    }
    if (slug !== catalogEntry.slug) {
      errors.push(
        `${relativeFile}: frontmatter slug "${slug}" does not match catalog slug "${catalogEntry.slug}"`,
      );
    }
    const directorySlug = path.basename(path.dirname(filePath));
    if (slug !== directorySlug) {
      errors.push(
        `${relativeFile}: frontmatter slug "${slug}" does not match directory "${directorySlug}"`,
      );
    }
    if (errors.length > 0) {
      throw new SkillCatalogValidationError(errors);
    }

    return {
      frontmatter,
      skill: {
        slug,
        name,
        description,
        phase,
        compatiblePhases,
        category,
        requiredTools,
        toolAlternatives,
        riskTier,
        ...(freshScopePriority ? { freshScopePriority } : {}),
        useWhen,
        notWhen,
        requiredInputs,
        expectedOutputs,
        evidenceFloor,
        strongTerms,
        followUpTriggers,
        techTriggers,
        ntypeTriggers,
        techniqueIds,
        sourceModes,
        relatedSkills,
        handoffSkills,
        mutationApplicability,
        ...(mutationNotApplicableReason ? { mutationNotApplicableReason } : {}),
        supportingFiles,
        fixtureManifest: normalizePath(fixtureManifest),
        versionHash: '',
        enabled: catalogEntry.enabled,
        ownerCategory: catalogEntry.ownerCategory,
        deliveryScope: catalogEntry.deliveryScope,
        releaseTrack: catalogEntry.releaseTrack,
        catalogVersion,
        localPath: `/workspace/.skills/${slug}`,
        content,
      },
    };
  }

  private async fixtureFilesForSkill(
    skillDir: string,
    skill: LoadedSkill,
  ): Promise<string[]> {
    const manifestPath = await this.resolveDeclaredFile(
      skillDir,
      skill.fixtureManifest,
      `${skill.slug}: fixture_manifest`,
    );
    let parsed: FixtureManifestFile;
    try {
      parsed = (YAML.parse(await fs.readFile(manifestPath, 'utf8')) ?? {}) as FixtureManifestFile;
    } catch (error) {
      throw new SkillCatalogValidationError([
        `${skill.slug}: unable to parse fixture manifest: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }

    const errors: string[] = [];
    if (parsed.schema_version !== 1) {
      errors.push(`${skill.slug}: fixture schema_version must be 1`);
    }
    if (parsed.skill !== skill.slug) {
      errors.push(`${skill.slug}: fixture manifest skill must equal ${skill.slug}`);
    }
    const fixtureFiles = requiredArray(
      parsed.files,
      `${skill.slug}: fixture manifest files`,
      errors,
    ).map((entry) => normalizePath(path.posix.join(path.posix.dirname(skill.fixtureManifest), entry)));
    if (errors.length > 0) {
      throw new SkillCatalogValidationError(errors);
    }

    for (const fixtureFile of fixtureFiles) {
      await this.resolveDeclaredFile(skillDir, fixtureFile, `${skill.slug}: fixture file`);
    }

    const fixtureDir = path.dirname(manifestPath);
    const onDisk: string[] = [];
    await this.collectFiles(fixtureDir, onDisk, () => true);
    const declared = new Set([
      normalizePath(path.relative(fixtureDir, manifestPath)),
      ...fixtureFiles.map((entry) =>
        normalizePath(path.relative(fixtureDir, path.resolve(skillDir, ...entry.split('/'))))),
    ]);
    const orphans = onDisk
      .map((entry) => normalizePath(path.relative(fixtureDir, entry)))
      .filter((entry) => !declared.has(entry));
    if (orphans.length > 0) {
      throw new SkillCatalogValidationError([
        `${skill.slug}: orphan fixture files are not declared: ${orphans.join(', ')}`,
      ]);
    }

    return fixtureFiles;
  }

  private runtimeFilesForSkill(skill: LoadedSkill): string[] {
    return unique([
      'SKILL.md',
      ...skill.supportingFiles.filter((relativePath) => !isEvaluationOnlyPath(relativePath)),
    ].map(normalizePath)).sort((left, right) => left.localeCompare(right));
  }

  private async hashDeclaredFiles(
    skillDir: string,
    skill: LoadedSkill,
    declaredFiles: readonly string[],
  ): Promise<string> {
    const hash = createHash('sha256');
    for (const relativePath of declaredFiles) {
      const filePath = await this.resolveDeclaredFile(
        skillDir,
        relativePath,
        `${skill.slug}: declared file`,
      );
      hash.update(relativePath, 'utf8');
      hash.update('\0', 'utf8');
      hash.update(normalizeContent(await fs.readFile(filePath, 'utf8')), 'utf8');
      hash.update('\0', 'utf8');
    }
    return hash.digest('hex');
  }

  private async loadRuntimeSnapshot(): Promise<RuntimeSkillCatalogSnapshot | null> {
    if (this.runtimeSnapshotPolicy === 'ignore') {
      return null;
    }
    if (this.runtimeSnapshotCache !== undefined) {
      return this.runtimeSnapshotCache;
    }

    const snapshotPath = path.resolve(this.skillsDir, RUNTIME_CATALOG_SNAPSHOT_FILE);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (missing && this.runtimeSnapshotPolicy === 'verify-if-present') {
        this.runtimeSnapshotCache = null;
        return null;
      }
      throw new SkillCatalogValidationError([
        missing
          ? `missing ${RUNTIME_CATALOG_SNAPSHOT_FILE}; regenerate the runtime skill catalog snapshot`
          : `unable to read ${RUNTIME_CATALOG_SNAPSHOT_FILE}: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }

    const parsed = typeof raw === 'object' && raw !== null
      ? raw as Record<string, unknown>
      : {};
    const errors: string[] = [];
    if (parsed.schemaVersion !== 1) {
      errors.push(`${RUNTIME_CATALOG_SNAPSHOT_FILE}: schemaVersion must be 1`);
    }
    const catalogVersion = requiredText(
      parsed.catalogVersion,
      `${RUNTIME_CATALOG_SNAPSHOT_FILE}: catalogVersion`,
      errors,
    );
    if (!Array.isArray(parsed.skills)) {
      errors.push(`${RUNTIME_CATALOG_SNAPSHOT_FILE}: skills must be an array`);
    }
    const skills: RuntimeSkillCatalogSnapshotEntry[] = [];
    const seen = new Set<string>();
    for (const [index, value] of (Array.isArray(parsed.skills) ? parsed.skills : []).entries()) {
      const entry = typeof value === 'object' && value !== null
        ? value as Record<string, unknown>
        : {};
      const slug = requiredField(
        entry.slug,
        `${RUNTIME_CATALOG_SNAPSHOT_FILE}: skills[${index}].slug`,
        errors,
      );
      const versionHash = requiredField(
        entry.versionHash,
        `${RUNTIME_CATALOG_SNAPSHOT_FILE}: skills[${index}].versionHash`,
        errors,
      );
      const runtimeHash = requiredField(
        entry.runtimeHash,
        `${RUNTIME_CATALOG_SNAPSHOT_FILE}: skills[${index}].runtimeHash`,
        errors,
      );
      if (slug && seen.has(slug)) {
        errors.push(`${RUNTIME_CATALOG_SNAPSHOT_FILE}: duplicate skill slug: ${slug}`);
      }
      if (versionHash && !SHA256_RE.test(versionHash)) {
        errors.push(`${RUNTIME_CATALOG_SNAPSHOT_FILE}: invalid versionHash for ${slug || index}`);
      }
      if (runtimeHash && !SHA256_RE.test(runtimeHash)) {
        errors.push(`${RUNTIME_CATALOG_SNAPSHOT_FILE}: invalid runtimeHash for ${slug || index}`);
      }
      seen.add(slug);
      skills.push({ slug, versionHash, runtimeHash });
    }
    if (errors.length > 0) {
      throw new SkillCatalogValidationError(errors);
    }

    this.runtimeSnapshotCache = {
      schemaVersion: 1,
      catalogVersion,
      skills,
    };
    return this.runtimeSnapshotCache;
  }

  private async buildCompleteCatalog(): Promise<SkillMetadata[]> {
    if (this.completeCatalogCache) {
      return this.completeCatalogCache;
    }
    const manifest = await this.loadManifest();
    const runtimeSnapshot = await this.loadRuntimeSnapshot();
    const snapshotBySlug = new Map(
      (runtimeSnapshot?.skills ?? []).map((entry) => [entry.slug, entry]),
    );
    const snapshotErrors: string[] = [];
    if (runtimeSnapshot && runtimeSnapshot.catalogVersion !== manifest.catalogVersion) {
      snapshotErrors.push(
        `${RUNTIME_CATALOG_SNAPSHOT_FILE}: catalogVersion=${runtimeSnapshot.catalogVersion} does not match ${CATALOG_FILE}=${manifest.catalogVersion}`,
      );
    }
    if (runtimeSnapshot) {
      const manifestSlugs = new Set(manifest.skills.map((entry) => entry.slug));
      const missingSnapshotSkills = manifest.skills
        .map((entry) => entry.slug)
        .filter((slug) => !snapshotBySlug.has(slug));
      const unexpectedSnapshotSkills = runtimeSnapshot.skills
        .map((entry) => entry.slug)
        .filter((slug) => !manifestSlugs.has(slug));
      if (missingSnapshotSkills.length > 0) {
        snapshotErrors.push(
          `${RUNTIME_CATALOG_SNAPSHOT_FILE}: missing skills: ${missingSnapshotSkills.join(', ')}`,
        );
      }
      if (unexpectedSnapshotSkills.length > 0) {
        snapshotErrors.push(
          `${RUNTIME_CATALOG_SNAPSHOT_FILE}: unexpected skills: ${unexpectedSnapshotSkills.join(', ')}`,
        );
      }
    }
    if (snapshotErrors.length > 0) {
      throw new SkillCatalogValidationError(snapshotErrors);
    }
    const skillFiles: string[] = [];
    await this.collectFiles(this.skillsDir, skillFiles, (entryName) => entryName === 'SKILL.md');
    skillFiles.sort((left, right) => left.localeCompare(right));
    const discoveredDirectories = new Set(
      skillFiles.map((filePath) => path.basename(path.dirname(filePath))),
    );
    const expectedDirectories = new Set(manifest.skills.map((entry) => entry.slug));
    const missing = [...expectedDirectories].filter((slug) => !discoveredDirectories.has(slug));
    const unexpected = [...discoveredDirectories].filter((slug) => !expectedDirectories.has(slug));
    if (missing.length > 0 || unexpected.length > 0) {
      throw new SkillCatalogValidationError([
        ...(missing.length > 0 ? [`catalog skills missing on disk: ${missing.join(', ')}`] : []),
        ...(unexpected.length > 0 ? [`unexpected skill directories: ${unexpected.join(', ')}`] : []),
      ]);
    }

    const catalog: SkillMetadata[] = [];
    const loadedBySlug = new Map<string, LoadedSkill>();
    const errors: string[] = [];
    for (const catalogEntry of manifest.skills) {
      const skillDir = path.resolve(this.skillsDir, catalogEntry.slug);
      const filePath = path.resolve(skillDir, 'SKILL.md');
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const { skill } = this.parseSkillDocument(
          raw,
          filePath,
          catalogEntry,
          manifest.catalogVersion,
        );
        const runtimeFiles = this.runtimeFilesForSkill(skill);
        const runtimeHash = await this.hashDeclaredFiles(skillDir, skill, runtimeFiles);
        this.runtimeHashesCache.set(skill.slug, runtimeHash);
        const snapshotEntry = snapshotBySlug.get(skill.slug);
        if (this.mode === 'evaluation') {
          const fixtureFiles = await this.fixtureFilesForSkill(skillDir, skill);
          const evaluationFiles = unique([
            ...runtimeFiles,
            skill.fixtureManifest,
            ...fixtureFiles,
          ].map(normalizePath)).sort((left, right) => left.localeCompare(right));
          skill.versionHash = await this.hashDeclaredFiles(skillDir, skill, evaluationFiles);
          if (snapshotEntry && snapshotEntry.versionHash !== skill.versionHash) {
            throw new SkillCatalogValidationError([
              `${RUNTIME_CATALOG_SNAPSHOT_FILE}: stale versionHash for ${skill.slug}`,
            ]);
          }
        } else if (snapshotEntry) {
          skill.versionHash = snapshotEntry.versionHash;
        } else {
          throw new SkillCatalogValidationError([
            `${RUNTIME_CATALOG_SNAPSHOT_FILE}: missing runtime entry for ${skill.slug}`,
          ]);
        }
        if (snapshotEntry && snapshotEntry.runtimeHash !== runtimeHash) {
          throw new SkillCatalogValidationError([
            `${RUNTIME_CATALOG_SNAPSHOT_FILE}: stale runtimeHash for ${skill.slug}`,
          ]);
        }
        const methodologyPath = path.resolve(skillDir, 'methodology.md');
        if (skill.supportingFiles.includes('methodology.md')) {
          skill.methodologyContent = (await fs.readFile(methodologyPath, 'utf8')).trim();
        }
        loadedBySlug.set(skill.slug, skill);
        const { content: _content, methodologyContent: _methodology, ...metadata } = skill;
        catalog.push(metadata);
      } catch (error) {
        if (error instanceof SkillCatalogValidationError) {
          errors.push(...error.errors);
        } else {
          errors.push(
            `${catalogEntry.slug}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    if (errors.length > 0) {
      throw new SkillCatalogValidationError(errors);
    }

    const catalogSlugs = new Set(catalog.map((skill) => skill.slug));
    for (const skill of catalog) {
      for (const relatedSlug of [...skill.relatedSkills, ...skill.handoffSkills]) {
        if (!catalogSlugs.has(relatedSlug)) {
          errors.push(`${skill.slug}: related/handoff skill does not exist: ${relatedSlug}`);
        }
        if (relatedSlug === skill.slug) {
          errors.push(`${skill.slug}: related/handoff skill must not reference itself`);
        }
      }
    }
    if (errors.length > 0) {
      throw new SkillCatalogValidationError(errors);
    }

    this.loadedSkillsCache = loadedBySlug;
    this.completeCatalogCache = catalog;
    return catalog;
  }

  async createRuntimeCatalogSnapshot(): Promise<RuntimeSkillCatalogSnapshot> {
    if (this.mode !== 'evaluation') {
      throw new Error('Runtime catalog snapshots must be generated with SkillLoader mode=evaluation');
    }
    const manifest = await this.loadManifest();
    const catalog = await this.buildCompleteCatalog();
    return {
      schemaVersion: 1,
      catalogVersion: manifest.catalogVersion,
      skills: catalog
        .map((skill) => ({
          slug: skill.slug,
          versionHash: skill.versionHash,
          runtimeHash: this.runtimeHashesCache.get(skill.slug) ?? '',
        }))
        .sort((left, right) => left.slug.localeCompare(right.slug)),
    };
  }

  async getCatalogManifest(): Promise<SkillCatalogManifest> {
    const manifest = await this.loadManifest();
    return {
      ...manifest,
      skills: manifest.skills.map((entry) => ({ ...entry })),
    };
  }

  async loadSkillCatalog(options: LoadSkillCatalogOptions = {}): Promise<SkillMetadata[]> {
    if (!options.includeDisabled && this.activeCatalogCache) {
      return this.activeCatalogCache;
    }
    const complete = await this.buildCompleteCatalog();
    if (options.includeDisabled) {
      return complete;
    }
    this.activeCatalogCache = complete.filter((skill) => skill.enabled);
    return this.activeCatalogCache;
  }

  async loadSkillBySlug(
    slug: string,
    options: LoadSkillOptions = {},
  ): Promise<LoadedSkill | null> {
    const normalizedSlug = normalize(slug);
    await this.buildCompleteCatalog();
    const skill = this.loadedSkillsCache.get(normalizedSlug);
    if (!skill || (!skill.enabled && !options.includeDisabled)) {
      return null;
    }
    if (!skill.enabled && !options.auditReason?.trim()) {
      throw new Error('auditReason is required to load a disabled skill diagnostically');
    }
    return {
      ...skill,
      compatiblePhases: [...skill.compatiblePhases],
      requiredTools: [...skill.requiredTools],
      toolAlternatives: [...skill.toolAlternatives],
      requiredInputs: [...skill.requiredInputs],
      expectedOutputs: [...skill.expectedOutputs],
      strongTerms: [...skill.strongTerms],
      followUpTriggers: [...skill.followUpTriggers],
      techTriggers: [...skill.techTriggers],
      ntypeTriggers: [...skill.ntypeTriggers],
      techniqueIds: [...skill.techniqueIds],
      sourceModes: [...skill.sourceModes],
      relatedSkills: [...skill.relatedSkills],
      handoffSkills: [...skill.handoffSkills],
      supportingFiles: [...skill.supportingFiles],
    };
  }
}
