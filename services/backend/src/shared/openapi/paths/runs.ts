import { registry, z } from '../registry';
import { ErrorResponseSchema, SuccessResponseSchema } from '../schemas';
import {
  CodeReviewCreateBodySchema,
  CodeReviewFindingParamSchema,
  CodeReviewFixRequestBodySchema,
  CodeReviewFixRequestSchema,
  CodeReviewRunBundleSchema,
  CodeReviewStartResponseSchema,
  PlanFeedbackBodySchema,
  RunApproveBodySchema,
  RunApproveResponseSchema,
  RunCreateBodySchema,
  RunDetailSchema,
  RunIdParamSchema,
  RunPlanFeedbackResponseSchema,
  RunsListQuerySchema,
  RunStartResponseSchema,
  RunSummarySchema,
} from '@/interfaces/http/controllers/runs.schemas';

registry.registerPath({
  method: 'get',
  path: '/api/app/runs',
  tags: ['Runs'],
  summary: 'List runs',
  description:
    'Returns runs for the authenticated organization with optional scope, status, trigger, and limit filters.',
  request: {
    query: RunsListQuerySchema,
  },
  responses: {
    200: {
      description: 'Run list',
      content: {
        'application/json': {
          schema: z.array(RunSummarySchema),
        },
      },
    },
    400: {
      description: 'Invalid query parameters',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/app/runs',
  tags: ['Runs'],
  summary: 'Start a run',
  description: 'Creates a goal-driven run and starts planner execution.',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: RunCreateBodySchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Run created',
      content: { 'application/json': { schema: RunStartResponseSchema } },
    },
    400: {
      description: 'Invalid payload',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/app/runs/code-reviews',
  tags: ['Code Review'],
  summary: 'Start a standalone Code Review',
  description:
    "Pins the scope's code source (a clone's commit, or a folder's content hash) with its file manifest and git blob ids, and starts the dedicated read-only Code Review workflow.",
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: CodeReviewCreateBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Existing idempotent Code Review returned',
      content: { 'application/json': { schema: CodeReviewStartResponseSchema } },
    },
    201: {
      description: 'Code Review created',
      content: { 'application/json': { schema: CodeReviewStartResponseSchema } },
    },
    202: {
      description: 'Code Review queued for admission',
      content: { 'application/json': { schema: CodeReviewStartResponseSchema } },
    },
    400: {
      description: 'No ready code source, or the path policy selects no files',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Code Review entitlement or repository access denied',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/app/runs/{id}',
  tags: ['Runs'],
  summary: 'Get run details',
  request: {
    params: RunIdParamSchema,
  },
  responses: {
    200: {
      description: 'Run details',
      content: {
        'application/json': {
          schema: RunDetailSchema,
        },
      },
    },
    404: {
      description: 'Run not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/app/runs/{id}/code-review',
  tags: ['Code Review'],
  summary: 'Get canonical Code Review findings and report',
  request: {
    params: RunIdParamSchema,
  },
  responses: {
    200: {
      description: 'Standalone Code Review bundle',
      content: { 'application/json': { schema: CodeReviewRunBundleSchema } },
    },
    404: {
      description: 'Run not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/app/runs/{id}/code-review/findings/{findingId}/fix',
  tags: ['Code Review'],
  summary: 'Request a fix for an agent-fixable finding',
  description:
    'Creates an idempotent fix request for the current validated finding version. Patch generation and GitHub publication remain separate gated actions.',
  request: {
    params: CodeReviewFindingParamSchema,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: CodeReviewFixRequestBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Existing idempotent fix request returned',
      content: { 'application/json': { schema: CodeReviewFixRequestSchema } },
    },
    202: {
      description: 'Fix request accepted',
      content: { 'application/json': { schema: CodeReviewFixRequestSchema } },
    },
    400: {
      description: 'Risk source is stale, not confirmed, or not agent-fixable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Code Review or fix access denied',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Run or finding not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/app/runs/{id}/approve',
  tags: ['Runs'],
  summary: 'Approve planner output',
  request: {
    params: RunIdParamSchema,
    body: {
      required: false,
      content: {
        'application/json': {
          schema: RunApproveBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Run approved and executor started',
      content: { 'application/json': { schema: RunApproveResponseSchema } },
    },
    400: {
      description: 'Invalid approval request',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/app/runs/{id}/reject',
  tags: ['Runs'],
  summary: 'Reject planner output',
  request: {
    params: RunIdParamSchema,
  },
  responses: {
    200: {
      description: 'Run rejected',
      content: { 'application/json': { schema: SuccessResponseSchema } },
    },
    400: {
      description: 'Invalid rejection request',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/app/runs/{id}/plan-feedback',
  tags: ['Runs'],
  summary: 'Request planner changes',
  request: {
    params: RunIdParamSchema,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: PlanFeedbackBodySchema,
        },
      },
    },
  },
  responses: {
    202: {
      description: 'Planner revision requested',
      content: { 'application/json': { schema: RunPlanFeedbackResponseSchema } },
    },
    400: {
      description: 'Invalid feedback request',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/app/runs/{id}/cancel',
  tags: ['Runs'],
  summary: 'Cancel run',
  request: {
    params: RunIdParamSchema,
  },
  responses: {
    200: {
      description: 'Run cancelled',
      content: { 'application/json': { schema: SuccessResponseSchema } },
    },
    400: {
      description: 'Invalid cancel request',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});
