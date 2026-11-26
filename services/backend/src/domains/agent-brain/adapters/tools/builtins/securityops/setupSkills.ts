import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import { SetupSkillLoader } from '@/domains/security-ops/setup/SetupSkillLoader';
import { resolveSecurityOpsToolContext } from '../securityopsContext';
import { getSetupReadinessService } from '../securityopsServiceRegistry';
import {
  formatToolError,
  isRecord,
  pickToolArgsPreview,
  requireUserId,
} from './shared';

const setupSkillLoader = new SetupSkillLoader();

const asString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const clampLimit = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(12, Math.trunc(value)));
};

const buildSetupSkillRankingText = async (
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ text: string; gaps: string[]; readiness: unknown }> => {
  const pieces = [
    asString(args.task),
    asString(args.text),
    asString(args.userGoal),
    ...asStringArray(args.gaps),
  ];
  const gaps = asStringArray(args.gaps);
  let readiness: unknown;

  const userId = requireUserId(ctx);
  const securityOpsContext = resolveSecurityOpsToolContext(ctx);
  if (userId && securityOpsContext.scopeId) {
    try {
      const state = await getSetupReadinessService().buildForUser({
        userId,
        scopeId: securityOpsContext.scopeId,
      });
      readiness = state;
      for (const gate of state.gates) {
        if (gate.status !== 'complete') {
          gaps.push(gate.id);
          pieces.push(`${gate.id}: ${gate.label} ${gate.status} ${gate.description}`);
        }
      }
      for (const action of state.nextBestActions) {
        pieces.push(`${action.id}: ${action.title} ${action.description} ${action.prompt}`);
      }
    } catch {
      // Ranking can still work from explicit user text.
    }
  }

  return {
    text: pieces.filter((piece): piece is string => Boolean(piece)).join('\n'),
    gaps,
    readiness,
  };
};

export const ListRelevantSetupSkills: ToolImpl = {
  meta: {
    name: 'list_relevant_setup_skills',
    description:
      'Suggest setup/onboarding playbooks for the current user request and setup-state gaps. Use this before vague or multi-step setup help so the assistant follows a repeatable operator playbook.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The user setup request or goal.' },
        text: { type: 'string', description: 'Optional additional context to rank against.' },
        userGoal: { type: 'string', description: 'Optional normalized user goal.' },
        gaps: { type: 'array', items: { type: 'string' }, description: 'Known setup gap ids, if already available.' },
        limit: { type: 'number', description: 'Maximum suggestions to return. Default 6, max 12.' },
      },
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx) {
    return runWithGuards(
      ListRelevantSetupSkills.meta,
      ctx,
      async () => {
        const parsed = isRecord(args) ? args : {};
        try {
          const rankingInput = await buildSetupSkillRankingText(parsed, ctx);
          const suggestions = await setupSkillLoader.rankRelevantSkills({
            text: rankingInput.text,
            gaps: rankingInput.gaps,
            limit: clampLimit(parsed.limit, 6),
          });
          return {
            ok: true,
            data: {
              suggestions,
              readiness: rankingInput.readiness,
              advisory: true,
            },
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['task', 'userGoal', 'gaps', 'limit']),
    );
  },
};

export const LoadSetupSkill: ToolImpl = {
  meta: {
    name: 'load_setup_skill',
    description:
      'Load one setup/onboarding playbook into the conversation. Use only after list_relevant_setup_skills or when the slug is clearly required by the user request.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Setup skill slug, for example interview-roe or register-and-verify-targets.' },
        reason: { type: 'string', description: 'Why this playbook is needed for the current setup request.' },
      },
      required: ['slug', 'reason'],
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx) {
    return runWithGuards(
      LoadSetupSkill.meta,
      ctx,
      async () => {
        const parsed = isRecord(args) ? args : {};
        const slug = asString(parsed.slug)?.toLowerCase();
        const reason = asString(parsed.reason);
        if (!slug) return { ok: false, data: { error: 'slug is required' } };
        if (!reason) return { ok: false, data: { error: 'reason is required' } };

        try {
          const skill = await setupSkillLoader.loadBySlug(slug);
          if (!skill) {
            return { ok: false, data: { error: `unknown setup skill: ${slug}` } };
          }
          return {
            ok: true,
            data: {
              slug: skill.slug,
              name: skill.name,
              description: skill.description,
              intent: skill.intent,
              useWhen: skill.useWhen,
              requires: skill.requires,
              produces: skill.produces,
              tags: skill.tags,
              content: skill.content,
              instruction:
                skill.intent === 'change'
                  ? 'Follow this playbook. Any live configuration change must still use approval-gated setup tools.'
                  : 'Follow this playbook for read-only setup guidance.',
            },
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['slug', 'reason']),
    );
  },
};
