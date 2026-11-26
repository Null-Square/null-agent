import { createHash } from 'crypto';
import { existsSync, promises as fs } from 'fs';
import path from 'path';

import { SkillLoader, type LoadedSkill, type SkillMetadata } from '@/domains/security-ops/skills/SkillLoader';

const candidateTemplatePaths = (): string[] => {
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, 'templates', 'validation-lead-prompt.md'),
    path.resolve(cwd, 'services', 'backend', 'templates', 'validation-lead-prompt.md'),
    path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'validation-lead-prompt.md'),
  ];
  return Array.from(new Set(candidates));
};

const resolveDefaultTemplatePath = (): string => candidateTemplatePaths().find((candidate) => {
  return existsSync(candidate);
}) ?? candidateTemplatePaths()[0];

const DEFAULT_TEMPLATE_PATH = resolveDefaultTemplatePath();

const SENTINELS = {
  target: 'Target not specified by upstream phase.',
  method: 'Method not specified.',
  path: 'Path not specified.',
  parameter: 'Parameter not specified.',
  requiredControls: ['No controls specified; infer from class skill.'],
  requiredPrerequisites: [] as string[],
  evidenceRefs: [] as string[],
};

const TERMINAL_STATUSES = ['validated', 'false_positive', 'blocked', 'deferred', 'superseded'];

export type RenderedValidationLeadPrompt = {
  leadId: string;
  promptPath: string;
  absolutePath: string;
  promptSha256: string;
  normalizedLead: Record<string, unknown>;
  skillSlug?: string;
  methodologyPath?: string;
};

export type LeadPromptRendererOptions = {
  templatePath?: string;
  skillLoader?: SkillLoader;
};

const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const toStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];

const normalizeToken = (value: string): string => value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-');

const includesNeedle = (value: string | undefined, needle: string): boolean =>
  Boolean(value && normalizeToken(value).includes(needle));

const skillMatchesLead = (skill: SkillMetadata, riskNeedle: string): boolean => {
  if (!riskNeedle) {
    return false;
  }
  return (
    includesNeedle(skill.slug, riskNeedle) ||
    includesNeedle(skill.name, riskNeedle) ||
    includesNeedle(skill.description, riskNeedle) ||
    skill.techTriggers.some((trigger) => includesNeedle(trigger, riskNeedle)) ||
    skill.followUpTriggers.some((trigger) => includesNeedle(trigger, riskNeedle))
  );
};

const chooseSkillForLead = (catalog: readonly SkillMetadata[], lead: Record<string, unknown>): SkillMetadata | undefined => {
  const riskNeedle = normalizeToken(getString(lead.riskFamily) ?? '');
  return catalog
    .filter((skill) => skill.phase === 'validation' || skill.compatiblePhases?.includes('validation'))
    .find((skill) => skillMatchesLead(skill, riskNeedle));
};

const renderTemplate = (template: string, values: Record<string, string>): string =>
  template.replace(/<([a-zA-Z0-9_]+)>/gu, (match, key: string) => values[key] ?? match);

export class LeadPromptRenderer {
  private readonly templatePath: string;
  private readonly skillLoader: SkillLoader;

  constructor(options: LeadPromptRendererOptions = {}) {
    this.templatePath = options.templatePath ?? DEFAULT_TEMPLATE_PATH;
    this.skillLoader = options.skillLoader ?? new SkillLoader();
  }

  normalizeLead(leadId: string, data: Record<string, unknown>, now = new Date()): Record<string, unknown> {
    const status = getString(data.status) ?? 'open';
    // D10 - a prompt renders the lead, never the lead plus its own projection metadata.
    // Carrying `promptSha256`, `promptPath` and `promptRenderedAt` into the rendered JSON
    // made the render non-idempotent: rebuilding from the stored record produced different
    // bytes and therefore a digest that no longer matched what the lead claimed.
    const {
      promptSha256: _promptSha256,
      promptPath: _promptPath,
      promptRenderedAt: _promptRenderedAt,
      ...leadFields
    } = data;
    return {
      ...leadFields,
      id: getString(data.id) ?? leadId,
      source: getString(data.source) ?? 'validation.lead',
      priority: getString(data.priority) ?? 'medium',
      riskFamily: getString(data.riskFamily) ?? getString(data.risk_family) ?? 'validation',
      hypothesis: getString(data.hypothesis) ?? 'Prior phase identified a validation target.',
      target: getString(data.target) ?? SENTINELS.target,
      method: getString(data.method) ?? SENTINELS.method,
      path: getString(data.path) ?? SENTINELS.path,
      parameter: getString(data.parameter) ?? SENTINELS.parameter,
      requiredControls: toStringArray(data.requiredControls).length > 0
        ? toStringArray(data.requiredControls)
        : SENTINELS.requiredControls,
      requiredPrerequisites: toStringArray(data.requiredPrerequisites),
      evidenceRefs: toStringArray(data.evidenceRefs),
      status,
      attempts: typeof data.attempts === 'number' && Number.isFinite(data.attempts)
        ? Math.max(0, Math.floor(data.attempts))
        : 0,
      generatedAt: getString(data.generatedAt) ?? now.toISOString(),
    };
  }

  async render(params: {
    leadId: string;
    workspaceDir: string;
    data: Record<string, unknown>;
    now?: Date;
  }): Promise<RenderedValidationLeadPrompt> {
    const now = params.now ?? new Date();
    const normalizedLead = this.normalizeLead(params.leadId, params.data, now);
    const catalog = await this.skillLoader.loadSkillCatalog();
    const skill = chooseSkillForLead(catalog, normalizedLead);
    const loadedSkill: LoadedSkill | null = skill ? await this.skillLoader.loadSkillBySlug(skill.slug) : null;
    const methodology = loadedSkill?.methodologyContent ?? loadedSkill?.content ?? 'No matching validation methodology was attached.';
    const template = await fs.readFile(this.templatePath, 'utf8');
    const body = renderTemplate(template, {
      leadJson: JSON.stringify(normalizedLead, null, 2),
      requiredObservationSchema: JSON.stringify({
        observations: [{ technique: 'string', result: 'confirmed|contradicted|partial|inconclusive', evidenceRef: 'optional path', note: 'optional note' }],
        blockerCode: 'required for blocked or deferred outcomes; prefer credential_required, auth_required, account_state_required, rate_limited, target_unavailable, out_of_scope, waf_blocked, insufficient_evidence, or tooling_blocked when one fits',
      }, null, 2),
      terminalStatuses: TERMINAL_STATUSES.join(', '),
      methodology,
    });
    const promptSha256 = createHash('sha256').update(body).digest('hex');
    const content = `${body.trimEnd()}\n\nPrompt SHA256: ${promptSha256}\n`;
    const promptPath = path.join('.artifacts', 'lead-prompts', `${params.leadId}.md`).replace(/\\/g, '/');
    const absolutePath = path.resolve(params.workspaceDir, promptPath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, 'utf8');

    // D10 - the canonical lead record must never advertise a projection that is not there.
    // In run 3.1 twelve leads were created and four prompt files existed; validation then
    // attempted reads of files that had never been written. Verifying the write here is what
    // lets the caller decide truthfully whether the lead has a prompt at all.
    await this.verifyProjection(absolutePath, promptSha256);

    return {
      leadId: params.leadId,
      promptPath,
      absolutePath,
      promptSha256,
      normalizedLead: {
        ...normalizedLead,
        promptSha256,
        promptPath,
        promptRenderedAt: now.toISOString(),
      },
      ...(skill ? { skillSlug: skill.slug } : {}),
      ...(loadedSkill?.localPath ? { methodologyPath: loadedSkill.localPath } : {}),
    };
  }

  /**
   * Confirms the rendered prompt is readable and is the content we just wrote. A projection
   * receipt that cannot be read back is not a receipt.
   */
  private async verifyProjection(absolutePath: string, expectedSha256: string): Promise<void> {
    let written: string;
    try {
      written = await fs.readFile(absolutePath, 'utf8');
    } catch (error: unknown) {
      throw new Error(
        `Validation lead prompt was written but is not readable at ${absolutePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // The file states its own digest in its footer. Comparing that is what tells us the file
    // on disk is the one that was rendered, without re-deriving it from a body whose
    // whitespace has already been trimmed on the way out.
    const declared = /\nPrompt SHA256: (?<sha>[a-f0-9]{64})\s*$/u.exec(written)?.groups?.sha;
    if (declared === undefined) {
      throw new Error(
        `Validation lead prompt at ${absolutePath} is missing its digest footer, so the `
        + 'projection cannot be verified',
      );
    }
    if (declared !== expectedSha256) {
      throw new Error(
        `Validation lead prompt at ${absolutePath} does not match the digest it was rendered `
        + `with (expected ${expectedSha256}, read back ${declared})`,
      );
    }
  }

  /**
   * Returns a readable prompt for a lead, re-rendering it when the projection is missing or
   * has drifted from its digest. The canonical lead record is the source of truth; the
   * workspace file is a projection of it and may be rebuilt at any time.
   */
  async ensureRendered(params: {
    leadId: string;
    workspaceDir: string;
    data: Record<string, unknown>;
    expectedSha256?: string;
    now?: Date;
  }): Promise<RenderedValidationLeadPrompt & { repaired: boolean }> {
    const promptPath = path.join('.artifacts', 'lead-prompts', `${params.leadId}.md`)
      .replace(/\\/g, '/');
    const absolutePath = path.resolve(params.workspaceDir, promptPath);

    // A repair must reproduce the prompt, not author a new one. The canonical record carries
    // the render time, so pinning the clock to it keeps the rebuilt bytes and their digest
    // identical to what the lead already claims.
    const pinned = getString(params.data.promptRenderedAt) ?? getString(params.data.generatedAt);
    const now = params.now
      ?? (pinned && !Number.isNaN(Date.parse(pinned)) ? new Date(pinned) : undefined);

    if (params.expectedSha256) {
      try {
        await this.verifyProjection(absolutePath, params.expectedSha256);
        return {
          leadId: params.leadId,
          promptPath,
          absolutePath,
          promptSha256: params.expectedSha256,
          normalizedLead: this.normalizeLead(params.leadId, params.data, now ?? new Date()),
          repaired: false,
        };
      } catch {
        // Fall through and re-render from canonical data.
      }
    }

    const rendered = await this.render({ ...params, ...(now ? { now } : {}) });
    return { ...rendered, repaired: true };
  }
}
