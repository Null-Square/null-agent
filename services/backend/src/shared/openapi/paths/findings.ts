import { registry } from '../registry';
import { ErrorResponseSchema } from '../schemas';
import {
  FindingDetailSchema,
  FindingEvidenceResponseSchema,
  FindingIdParamSchema,
} from '@/interfaces/http/controllers/findings.schemas';

registry.registerPath({
  method: 'get',
  path: '/api/app/findings/{id}',
  tags: ['Findings'],
  summary: 'Get finding detail',
  request: {
    params: FindingIdParamSchema,
  },
  responses: {
    200: {
      description: 'Finding detail',
      content: {
        'application/json': {
          schema: FindingDetailSchema,
        },
      },
    },
    404: {
      description: 'Finding not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/app/findings/{id}/evidence',
  tags: ['Findings'],
  summary: 'Get finding evidence',
  request: {
    params: FindingIdParamSchema,
  },
  responses: {
    200: {
      description: 'Finding evidence',
      content: {
        'application/json': {
          schema: registry.register(
            'FindingEvidenceListResponse',
            FindingEvidenceResponseSchema.array(),
          ),
        },
      },
    },
    404: {
      description: 'Finding not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});
