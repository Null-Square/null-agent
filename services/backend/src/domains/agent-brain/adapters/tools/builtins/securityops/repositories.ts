
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import { resolveSecurityOpsToolContext } from '../securityopsContext';
import { getSecurityOpsService } from '../securityopsServiceRegistry';
import { getHostedRunPersistencePort } from '@/domains/security-ops/runs/HostedRunPersistencePort';
import { validateCodeReviewRepositoryRead } from '@/domains/security-ops/runs/codeReviewRunContext';
import { redactCodeReviewText } from '@/domains/security-ops/code-review/CodeReviewRedaction';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

import {
  formatToolError,
  pickToolArgsPreview
} from './shared';

export const ListConnectedRepositories: ToolImpl = {
  meta: {
    name: 'list_connected_repositories',
    description:
      'List the repository connected to the current scope (its code source: a local folder or a git clone) for authorized read-only source context.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      ListConnectedRepositories.meta,
      ctx,
      async () => {
        const service = getSecurityOpsService(ctx);
        const context = resolveSecurityOpsToolContext(ctx);
        try {
          const hostedRun = context.runHost === 'research_lab'
            ? getHostedRunPersistencePort(context.runId)
            : null;
          if (context.workflowDiscipline === 'code_review') {
            throw new Error(
              'Code Review repository listing is denied: the run must use only its typed immutable repository context',
            );
          }
          if (hostedRun) {
            return {
              ok: true,
              data: await hostedRun.queryRepository({
                operation: 'list',
                input: typeof args === 'object' && args !== null ? args as Record<string, unknown> : {},
              }),
            };
          }
          const result = await service.listConnectedRepositories({
            context,
            input: args,
          });
          return { ok: true, data: result };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      {},
    );
  },
};


export const SearchConnectedRepository: ToolImpl = {
  meta: {
    name: 'search_connected_repository',
    description:
      'Search files inside the repository connected to the current scope.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        repository: { type: 'string', description: 'Connected repository full name or internal repository id.' },
        query: { type: 'string', description: 'Code search query.' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['repository', 'query'],
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      SearchConnectedRepository.meta,
      ctx,
      async () => {
        const service = getSecurityOpsService(ctx);
        const context = resolveSecurityOpsToolContext(ctx);
        try {
          const hostedRun = context.runHost === 'research_lab'
            ? getHostedRunPersistencePort(context.runId)
            : null;
          if (context.workflowDiscipline === 'code_review') {
            throw new Error(
              'Code Review repository search is denied until search is bound to an immutable commit and path manifest',
            );
          }
          if (hostedRun) {
            return {
              ok: true,
              data: await hostedRun.queryRepository({
                operation: 'search',
                input: typeof args === 'object' && args !== null ? args as Record<string, unknown> : {},
              }),
            };
          }
          const result = await service.searchConnectedRepository({
            context,
            input: args,
          });
          return { ok: true, data: result };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['repository', 'query', 'limit']),
    );
  },
};


export const ReadConnectedRepositoryFile: ToolImpl = {
  meta: {
    name: 'read_connected_repository_file',
    description:
      'Read a text file from the repository connected to the current scope.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        repository: { type: 'string', description: 'Connected repository full name or internal repository id.' },
        path: { type: 'string', description: 'Repository-relative file path.' },
        ref: { type: 'string', description: 'Optional commit SHA (a folder: the content hash a review pinned). Omit to read the current code.' },
      },
      required: ['repository', 'path'],
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      ReadConnectedRepositoryFile.meta,
      ctx,
      async () => {
        const service = getSecurityOpsService(ctx);
        const context = resolveSecurityOpsToolContext(ctx);
        try {
          const hostedRun = context.runHost === 'research_lab'
            ? getHostedRunPersistencePort(context.runId)
            : null;
          const isCodeReview = context.workflowDiscipline === 'code_review';
          if (isCodeReview) {
            if (!context.codeReview) {
              throw new Error('Code Review repository read is denied because immutable run context is missing');
            }
            const input = typeof args === 'object' && args !== null
              ? args as Record<string, unknown>
              : {};
            const validation = validateCodeReviewRepositoryRead({
              context: context.codeReview,
              repository: input.repository,
              ref: input.ref,
              path: input.path,
            });
            if (!validation.ok) {
              throw new Error(`Code Review repository read denied: ${validation.issues.join('; ')}`);
            }
          }
          const result = hostedRun
            ? await hostedRun.queryRepository({
                operation: 'read',
                input: typeof args === 'object' && args !== null ? args as Record<string, unknown> : {},
              })
            : await service.readConnectedRepositoryFile({ context, input: args });
          // Code Review source reaches the model, the transcript store, and
          // downstream reports. Redact likely secrets on the read path itself
          // so no Code Review surface can expose an unredacted credential.
          if (isCodeReview && isRecord(result) && typeof result.content === 'string') {
            return {
              ok: true,
              data: { ...result, content: redactCodeReviewText(result.content) },
            };
          }
          return { ok: true, data: result };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['repository', 'path', 'ref']),
    );
  },
};

