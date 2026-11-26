import { registry } from '../registry';
import { ErrorResponseSchema } from '../schemas';
import {
  CodeSourceBodySchema,
  CodeSourceResponseSchema,
  ScopeIdParamSchema,
} from '@/interfaces/http/controllers/scopes.schemas';

registry.registerPath({
  method: 'get',
  path: '/api/app/scopes/{id}/code-source',
  tags: ['Scopes'],
  summary: "Get the scope's code source",
  description:
    'The folder or git URL the scope reads code from, its status (ready, cloning or failed) and the commit (a clone) or content hash (a folder) a Code Review would pin. Null when none is set.',
  request: { params: ScopeIdParamSchema },
  responses: {
    200: {
      description: 'Code source, or null',
      content: { 'application/json': { schema: CodeSourceResponseSchema } },
    },
    404: {
      description: 'Scope not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/app/scopes/{id}/code-source',
  tags: ['Scopes'],
  summary: "Set the scope's code source",
  description:
    'Point the scope at an absolute folder path (validated, read in place, never written; inside NULL_AI_CODE_ROOT when set) or a public https:// or ssh git URL (cloned shallow in the background, at most 2 minutes and 200 MiB). Repeating the same git source does not clone again. No credentials are stored: a private repository is cloned by the person and added as a folder.',
  request: {
    params: ScopeIdParamSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: CodeSourceBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Folder scanned and ready, or the same git source already cloning or ready',
      content: { 'application/json': { schema: CodeSourceResponseSchema } },
    },
    202: {
      description: 'Git clone started; poll GET until status is ready or failed',
      content: { 'application/json': { schema: CodeSourceResponseSchema } },
    },
    400: {
      description: 'Refused folder or URL',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/app/scopes/{id}/code-source',
  tags: ['Scopes'],
  summary: "Remove the scope's code source",
  description: 'Removes the source and its clone. A folder is never touched.',
  request: { params: ScopeIdParamSchema },
  responses: {
    204: { description: 'Removed (or there was none)' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/app/scopes/{id}/code-source/refresh',
  tags: ['Scopes'],
  summary: "Refresh the scope's code source",
  description: 'Re-scans a folder now, or fetches and resets a clone in the background.',
  request: { params: ScopeIdParamSchema },
  responses: {
    200: {
      description: 'Folder re-scanned',
      content: { 'application/json': { schema: CodeSourceResponseSchema } },
    },
    202: {
      description: 'Clone refresh started',
      content: { 'application/json': { schema: CodeSourceResponseSchema } },
    },
    404: {
      description: 'The scope has no code source',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});
