import type { ZodTypeAny } from 'zod';
import { registry } from '../registry';
import { ErrorResponseSchema } from '../schemas';
import {
  ChatGptStartBodySchema,
  ChatGptStartResponseSchema,
  ModelCatalogResponseSchema,
  ModelConnectBodySchema,
  ModelConnectResponseSchema,
  ModelDisconnectResponseSchema,
  ModelKeyBodySchema,
  ModelStateResponseSchema,
  ModelTestResponseSchema,
} from '@/interfaces/http/controllers/model.schemas';

const json = (schema: ZodTypeAny) => ({ 'application/json': { schema } });

const error = (description: string) => ({ description, content: json(ErrorResponseSchema) });

registry.registerPath({
  method: 'get',
  path: '/api/app/model',
  tags: ['Model'],
  summary: 'The connected model and the API-key providers',
  description: 'The one model the agent uses for every effort tier, or null. Never includes a key or a token.',
  responses: {
    200: { description: 'Connection and providers', content: json(ModelStateResponseSchema) },
    401: error('Owner key required'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/app/model/key',
  tags: ['Model'],
  summary: 'Validate an API key and list its chat models',
  description:
    "Lists the provider's models with the key (free), filtered to chat models, newest first. Saves nothing.",
  request: { body: { required: true, content: json(ModelKeyBodySchema) } },
  responses: {
    200: { description: 'Models this key can use', content: json(ModelCatalogResponseSchema) },
    400: error('Invalid body, or the provider refused the key'),
    403: error('Missing organization.manage'),
    502: error('The provider could not be reached or failed'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/app/model/connect',
  tags: ['Model'],
  summary: 'Connect the one model the agent uses',
  description:
    'method api_key: provider, model and apiKey (omit apiKey to keep the connected key of the same provider). '
    + 'method chatgpt: a model of the signed-in ChatGPT plan.',
  request: { body: { required: true, content: json(ModelConnectBodySchema) } },
  responses: {
    200: { description: 'Connected', content: json(ModelConnectResponseSchema) },
    400: error('Invalid body, refused key, or a model the key or plan does not offer'),
    403: error('Missing organization.manage'),
    409: error('ChatGPT is not signed in'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/app/model/chatgpt/models',
  tags: ['Model'],
  summary: "The signed-in ChatGPT plan's models",
  responses: {
    200: { description: 'Plan models, in the server order', content: json(ModelCatalogResponseSchema) },
    409: error('ChatGPT is not signed in'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/app/model/chatgpt/start',
  tags: ['Model'],
  summary: 'Start Sign in with ChatGPT',
  description:
    'Returns the authorization URL to open in the browser. ChatGPT returns to '
    + 'http://127.0.0.1:<port of NULL_AI_APP_URL>/auth/callback (the app proxies it to GET /auth/callback), '
    + 'which stores the tokens and sends the browser to NULL_AI_APP_URL + returnTo with '
    + '?chatgpt=connected|no_plan|no_models|error.',
  request: { body: { required: false, content: json(ChatGptStartBodySchema) } },
  responses: {
    200: { description: 'Authorization URL', content: json(ChatGptStartResponseSchema) },
    403: error('Missing organization.manage'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/auth/callback',
  tags: ['Model'],
  summary: 'Sign in with ChatGPT callback',
  description:
    'The OAuth redirect (code, state, scope, client_id). Admitted by the one-time state, not the owner key. '
    + 'Redirects to the app, or answers a short HTML page.',
  security: [],
  responses: {
    302: { description: 'Back to the app with ?chatgpt=<outcome>' },
    200: { description: 'HTML page (no app to return to)' },
    400: { description: 'HTML page explaining why the sign-in could not finish' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/app/model/test',
  tags: ['Model'],
  summary: 'Test the connected model',
  description: 'One minimal streamed request through the client the agent uses. Times out after 20 s.',
  responses: {
    200: { description: 'Result in plain words; never contains a key', content: json(ModelTestResponseSchema) },
    403: error('Missing organization.manage'),
    404: error('No model is connected'),
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/app/model',
  tags: ['Model'],
  summary: 'Disconnect the model',
  description: 'An API key is cleared. A ChatGPT plan is revoked and its tokens forgotten.',
  responses: {
    200: { description: 'Disconnected', content: json(ModelDisconnectResponseSchema) },
    403: error('Missing organization.manage'),
  },
});
