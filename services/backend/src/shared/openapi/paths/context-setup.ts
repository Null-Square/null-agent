import { registry, z } from '../registry';
import { ErrorResponseSchema } from '../schemas';
import {
  OrgContextSetupGenerateBodySchema,
  ScopeContextSetupGenerateBodySchema,
} from '@/interfaces/http/controllers/context-setup.schemas';

const scopeIdParamSchema = z.object({
  id: z.string().uuid(),
});

registry.registerPath({
  method: 'post',
  path: '/api/app/context-setup/org/generate',
  tags: ['Context Setup'],
  summary: 'Compile organization brief draft',
  description:
    'Compiles an organization context brief from structured questionnaire answers. Response is plain text.',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: OrgContextSetupGenerateBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Compiled draft output',
      content: {
        'text/plain': {
          schema: z.string(),
        },
      },
    },
    400: {
      description: 'Invalid payload',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Unauthorized',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/app/context-setup/scope/generate',
  tags: ['Context Setup'],
  summary: 'Compile draft scope rules-of-engagement without persisted scope',
  description:
    'Compiles a draft rules-of-engagement document from structured questionnaire answers and optional seed context. Response is plain text.',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: ScopeContextSetupGenerateBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Compiled draft output',
      content: {
        'text/plain': {
          schema: z.string(),
        },
      },
    },
    400: {
      description: 'Invalid payload',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Unauthorized',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/app/context-setup/scope/{id}/generate',
  tags: ['Context Setup'],
  summary: 'Compile scope rules-of-engagement draft',
  description:
    'Compiles a scope rules-of-engagement document from structured questionnaire answers. Response is plain text.',
  request: {
    params: scopeIdParamSchema,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: ScopeContextSetupGenerateBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Compiled draft output',
      content: {
        'text/plain': {
          schema: z.string(),
        },
      },
    },
    400: {
      description: 'Invalid payload',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: 'Unauthorized',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'Scope not found',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});
