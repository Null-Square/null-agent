import { performance } from 'perf_hooks';

import { fromToolImpl } from '@/domains/agent-brain/application/tools/helpers';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import { getSessionFromContext } from '@/domains/agent-brain/application/tools/runtime/ToolContextSelectors';
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import type { ToolModuleDefinition } from '@/domains/agent-brain/application/tools/types';
import { SkillLoader } from '@/domains/security-ops/skills/SkillLoader';
import { rankSkillsForState } from '@/domains/security-ops/skills/SkillRanker';
import { syncAssignedSkillsIntoWorkspace } from '@/domains/security-ops/runs/skillWorkspaceSync';
import {
  normalizePhaseKey,
  phaseProfileRegistry,
  type RunPhaseKey,
} from '@/domains/security-ops/runs/PhaseProfileRegistry';
import {
  skillContextTokens,
  skillLoadTotal,
  skillRoutingLatency,
  skillSelectionTotal,
} from '@/shared/metrics/prometheusMetrics';

const skillLoader = new SkillLoader();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const clampLimit = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(20, Math.trunc(value)));
};

const getSecurityOpsFlags = (ctx: ToolContext): Record<string, unknown> =>
  isRecord(ctx.flags.securityops) ? ctx.flags.securityops : {};

const getActivePhaseKey = (ctx: ToolContext, explicitPhase?: unknown): RunPhaseKey | undefined => {
  const phaseKey =
    normalizePhaseKey(explicitPhase) ??
    normalizePhaseKey(getSecurityOpsFlags(ctx).activePhaseKey) ??
    normalizePhaseKey(getSessionFromContext(ctx)?.promptProfile);
  return phaseKey ?? undefined;
};

const getPhaseAssignedSkillSlugs = (ctx: ToolContext): string[] => {
  const phaseAssigned = normalizeStringArray(getSecurityOpsFlags(ctx).phaseAssignedSkillSlugs);
  return phaseAssigned.map((slug) => slug.toLowerCase());
};

const buildRankingText = (args: Record<string, unknown>, ctx: ToolContext): string => {
  const pieces = [
    normalizeText(args.target),
    normalizeText(args.riskFamily),
    ...normalizeStringArray(args.technologies),
    ...normalizeStringArray(args.ntypes),
    ...normalizeStringArray(args.evidenceRefs),
    normalizeText(args.text),
  ];
  const session = getSessionFromContext(ctx);
  if (typeof session?.extraContext === 'string') {
    pieces.push(session.extraContext.slice(0, 4_000));
  }
  return pieces.filter((piece): piece is string => typeof piece === 'string' && piece.length > 0).join('\n');
};

const getLoadLimit = (ctx: ToolContext): number => {
  const session = getSessionFromContext(ctx);
  // A bounded surface routinely needs several methodologies (a login form is
  // auth + session + csrf + injection). A two-skill worker ceiling forced the
  // quick, single-technique passes we are recovering from, so give a worker
  // real breadth and the planner more still.
  if (session?.coordination?.role === 'worker') {
    return 6;
  }
  return 10;
};

const getLoadedSkillSlugs = (ctx: ToolContext): string[] => {
  const session = getSessionFromContext(ctx);
  const raw = isRecord(session?.flags?.skill_on_demand_loads)
    ? session?.flags?.skill_on_demand_loads.slugs
    : [];
  return normalizeStringArray(raw).map((slug) => slug.toLowerCase());
};

const getLoadedSkillVersions = (ctx: ToolContext): Array<{ slug: string; versionHash: string }> => {
  const session = getSessionFromContext(ctx);
  const raw = isRecord(session?.flags?.skill_on_demand_loads)
    ? session?.flags?.skill_on_demand_loads.skills
    : [];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter(isRecord)
    .map((entry) => ({
      slug: normalizeText(entry.slug)?.toLowerCase() ?? '',
      versionHash: normalizeText(entry.versionHash)?.toLowerCase() ?? '',
    }))
    .filter((entry) => entry.slug.length > 0 && /^[a-f0-9]{64}$/.test(entry.versionHash));
};

const recordLoadedSkill = async (
  ctx: ToolContext,
  skill: { slug: string; versionHash: string },
): Promise<{ slugs: string[]; skills: Array<{ slug: string; versionHash: string }> }> => {
  const session = getSessionFromContext(ctx);
  if (!session) {
    return { slugs: [skill.slug], skills: [skill] };
  }
  const previous = getLoadedSkillSlugs(ctx);
  const slugs = Array.from(new Set([...previous, skill.slug]));
  const bySlug = new Map(getLoadedSkillVersions(ctx).map((entry) => [entry.slug, entry]));
  bySlug.set(skill.slug, skill);
  const skills = slugs
    .map((slug) => bySlug.get(slug))
    .filter((entry): entry is { slug: string; versionHash: string } => Boolean(entry));
  session.flags = {
    ...(session.flags ?? {}),
    skill_on_demand_loads: {
      slugs,
      skills,
      updatedAt: new Date().toISOString(),
    },
  };
  await ctx.sessionStore.setAsync(session.id, session, 'skill_loaded_on_demand');
  return { slugs, skills };
};

export const ListRelevantSkills: ToolImpl = {
  meta: {
    name: 'list_relevant_skills',
    description:
      'Route one exact SecurityOps mission to compact, phase-compatible skill suggestions. Planners must call this for each non-reporting Pentest mission before submit_plan; executors and workers use it only when the active task needs a method beyond the assigned set.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        phase: { type: 'string', description: 'Optional phase override such as recon, enumeration, validation, exploitation, evidence, control_assessment, or reporting.' },
        missionId: { type: 'string', description: 'Planner mission id or worker task id served by this routing decision.' },
        target: { type: 'string', description: 'Target host, endpoint, route, component, or asset under consideration.' },
        riskFamily: { type: 'string', description: 'Risk family or hypothesis, for example idor, broken-auth, wordpress, jwt, xss.' },
        technologies: { type: 'array', items: { type: 'string' }, description: 'Observed technologies or frameworks.' },
        ntypes: { type: 'array', items: { type: 'string' }, description: 'Observed inventory note types such as http.endpoint or validation.lead.' },
        evidenceRefs: { type: 'array', items: { type: 'string' }, description: 'Relevant evidence or projection refs.' },
        text: { type: 'string', description: 'Optional free-form state summary to rank against.' },
        limit: { type: 'number', description: 'Maximum suggestions to return. Default 8, max 20.' },
      },
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx) {
    return runWithGuards(
      ListRelevantSkills.meta,
      ctx,
      async () => {
        const parsed = isRecord(args) ? args : {};
        const phaseKey = getActivePhaseKey(ctx, parsed.phase);
        const catalog = await skillLoader.loadSkillCatalog();
        const rankingStartedAt = performance.now();
        const rankings = rankSkillsForState(catalog, {
          text: buildRankingText(parsed, ctx),
          phaseKey,
          assignedSkillSlugs: getPhaseAssignedSkillSlugs(ctx),
          limit: clampLimit(parsed.limit, 8),
        });
        skillRoutingLatency.observe(
          { phase: phaseKey ?? 'unspecified' },
          performance.now() - rankingStartedAt,
        );
        const suggestions = rankings.map((entry) => {
          const skill = catalog.find((candidate) => candidate.slug === entry.slug);
          if (skill) {
            skillSelectionTotal.inc({
              slug: skill.slug,
              version_hash: skill.versionHash,
              phase: phaseKey ?? 'unspecified',
            });
          }
          return {
            ...entry,
            category: skill?.category,
            riskTier: skill?.riskTier,
            useWhen: skill?.useWhen,
            evidenceFloor: skill?.evidenceFloor,
            methodologyPath: `/workspace/.skills/${entry.slug}/methodology.md`,
          };
        });

        await ctx.trace?.write(ctx.sessionId, ctx.turnNumber ?? 0, {
          event: 'skill.router_suggested',
          severity: 'info',
          payload: {
            phaseKey,
            topSlugs: suggestions.map((entry) => entry.slug),
            suggestions,
            missionId: normalizeText(parsed.missionId),
            purpose: 'mission_skill_routing',
          },
          note: `skill router suggested: ${suggestions.slice(0, 5).map((entry) => entry.slug).join(', ') || 'none'}`,
        });

        return {
          ok: true,
          data: {
            phaseKey,
            missionId: normalizeText(parsed.missionId),
            suggestions,
            rankingAdvisory: true,
          },
        };
      },
      {},
      {},
    );
  },
};

export const LoadSkill: ToolImpl = {
  meta: {
    name: 'load_skill',
    description:
      'Load one phase-compatible SecurityOps skill methodology into the shared workspace. Returns compact metadata and the methodology path instead of dumping the full methodology into chat history.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Skill slug to load, for example idor or api-enumeration.' },
        reason: { type: 'string', description: 'Why this skill is needed now for the current phase or worker mission.' },
      },
      required: ['slug', 'reason'],
    },
    risks: ['read', 'write'],
    returns: 'json',
  },

  async run(args, ctx) {
    return runWithGuards(
      LoadSkill.meta,
      ctx,
      async () => {
        const parsed = isRecord(args) ? args : {};
        const slug = normalizeText(parsed.slug)?.toLowerCase();
        const reason = normalizeText(parsed.reason);
        if (!slug) {
          return { ok: false, data: { error: 'slug is required' } };
        }
        if (!reason) {
          return { ok: false, data: { error: 'reason is required' } };
        }

        const loadedSkill = await skillLoader.loadSkillBySlug(slug);
        if (!loadedSkill) {
          skillLoadTotal.inc({
            slug,
            version_hash: 'unknown',
            phase: getActivePhaseKey(ctx) ?? 'unspecified',
            result: 'rejected',
          });
          return { ok: false, data: { error: `unknown skill: ${slug}` } };
        }

        const phaseKey = getActivePhaseKey(ctx);
        if (phaseKey) {
          const compatibilityError = phaseProfileRegistry.validateSkillAssignment(phaseKey, loadedSkill);
          if (compatibilityError) {
            skillLoadTotal.inc({
              slug,
              version_hash: loadedSkill.versionHash,
              phase: phaseKey,
              result: 'incompatible',
            });
            return {
              ok: false,
              data: {
                error: `skill ${slug} is not compatible with active phase ${phaseKey}: ${compatibilityError}`,
                phaseKey,
              },
            };
          }
        }

        const loaded = getLoadedSkillSlugs(ctx);
        const limit = getLoadLimit(ctx);
        const assigned = getPhaseAssignedSkillSlugs(ctx).includes(slug);
        if (!assigned && !loaded.includes(slug) && loaded.length >= limit) {
          return {
            ok: false,
            data: {
              error: `on-demand skill load limit reached (${limit})`,
              loadedSkillSlugs: loaded,
              recommendedNextAction: 'Finish the current bounded objective or ask the parent/planner to re-scope skills.',
            },
          };
        }

        const synced = await syncAssignedSkillsIntoWorkspace([slug], ctx.workspaceDir);
        const loadedSkillRecord = assigned
          ? { slugs: loaded, skills: getLoadedSkillVersions(ctx) }
          : await recordLoadedSkill(ctx, {
              slug,
              versionHash: loadedSkill.versionHash,
            });
        const loadedSkillSlugs = loadedSkillRecord.slugs;
        const methodologyPath = `/workspace/.skills/${slug}/methodology.md`;
        skillLoadTotal.inc({
          slug,
          version_hash: loadedSkill.versionHash,
          phase: phaseKey ?? 'unspecified',
          result: 'loaded',
        });
        skillContextTokens.observe(
          { slug, version_hash: loadedSkill.versionHash },
          Math.ceil((loadedSkill.methodologyContent?.length ?? 0) / 4),
        );

        await ctx.trace?.write(ctx.sessionId, ctx.turnNumber ?? 0, {
          event: assigned ? 'skill.assigned_method_accessed' : 'skill.loaded_on_demand',
          severity: 'info',
          payload: {
            slug,
            versionHash: loadedSkill.versionHash,
            phaseKey,
            reason,
            methodologyPath,
            synced,
            loadedSkillSlugs,
            loadedSkills: loadedSkillRecord.skills,
            loadLimit: limit,
            assigned,
          },
          note: assigned ? `accessed assigned skill: ${slug}` : `loaded skill on demand: ${slug}`,
        });

        return {
          ok: true,
          data: {
            slug,
            name: loadedSkill.name,
            phase: loadedSkill.phase,
            category: loadedSkill.category,
            evidenceFloor: loadedSkill.evidenceFloor,
            methodologyPath,
            loadedSkillSlugs,
            loadLimit: limit,
            assigned,
            instruction: `Read ${methodologyPath} only if the current mission needs the full methodology.`,
          },
        };
      },
      {},
      {},
    );
  },
};

export const tools: ToolModuleDefinition[] = [ListRelevantSkills, LoadSkill].map(fromToolImpl);
