import { Router, type NextFunction, type Request, type Response } from 'express';
import type { z } from 'zod';
import { createPlatformKernel, type PlatformKernel } from '@/app/platform/kernel';
import {
  listModelProviderOptions,
  type ModelConnection,
  type ModelProviderOption,
} from '@/app/services/platform/models/modelAppService';
import type { ModelProbe } from '@/app/services/platform/models/modelProbe';
import { ChatGptSignInError, type ChatGptSignIn } from '@/app/services/platform/models/chatGptSignIn';
import { requireCapability } from '@/interfaces/http/middleware/requireCapability';
import { ERROR_CODES, sendApiError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import {
  ChatGptStartBodySchema,
  ModelConnectBodySchema,
  ModelKeyBodySchema,
} from './model.schemas';

/** Connecting a model, or sending its key or token anywhere, is an organization settings edit. */
const MODEL_WRITE = 'organization.manage' as const;

type ModelServiceLike = Pick<
  PlatformKernel['models'],
  'getConnection' | 'listModelsForKey' | 'listChatGptModels' | 'connectWithKey' | 'connectChatGpt' | 'disconnect'
>;

/** The one shape a connection leaves the API in: named fields only, so no credential can slip through. */
export const toConnectionDto = (connection: ModelConnection) => ({
  method: connection.method,
  provider: connection.provider,
  model: connection.model,
  label: connection.label,
  account: connection.account,
  server: connection.server,
});

const parseOr400 = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, res: Response): T | undefined => {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => ({
    field: issue.path.join('.') || null,
    message: issue.code === 'unrecognized_keys' ? `Unknown field(s): ${issue.keys.join(', ')}` : issue.message,
  }));
  const first = issues[0];
  const message = first ? (first.field ? `${first.field}: ${first.message}` : first.message) : 'Invalid request';
  sendApiError(res, {
    code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
    message,
    userMessage: message,
    status: 400,
    context: { issues },
  });
  return undefined;
};

const handle = (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };

export type ModelRouterDeps = {
  models?: ModelServiceLike;
  providers?: () => ModelProviderOption[];
  probe: ModelProbe;
  chatGpt: ChatGptSignIn;
  /** The loopback redirect the docs require: http://127.0.0.1:<the app's port>/auth/callback. */
  chatGptRedirectUri: string;
  /** NULL_AI_APP_URL: where the browser goes back to after the sign-in. */
  appUrl: string;
};

/**
 * `/api/app/model`: the ONE model the agent uses. Three ways in: Sign in with ChatGPT (the plan
 * pays), an API key for one of five providers (Claude is Anthropic: claude.ai sign-in may not be
 * offered by third-party products), or the models configuration file for anything else. ModelService
 * owns every rule; this router checks shapes and never returns a key or a token.
 */
export function createModelRouter(deps: ModelRouterDeps): Router {
  const models = deps.models ?? createPlatformKernel().models;
  const providers = deps.providers ?? listModelProviderOptions;
  const router = Router();

  router.get('/', handle(async (_req, res) => {
    const connection = await models.getConnection();
    res.json({ connection: connection ? toConnectionDto(connection) : null, providers: providers() });
  }));

  router.post('/key', requireCapability(MODEL_WRITE), handle(async (req, res) => {
    const body = parseOr400(ModelKeyBodySchema, req.body, res);
    if (!body) return;
    res.json({ models: await models.listModelsForKey(body.provider, body.apiKey) });
  }));

  router.post('/connect', requireCapability(MODEL_WRITE), handle(async (req, res) => {
    const body = parseOr400(ModelConnectBodySchema, req.body, res);
    if (!body) return;
    const connection = body.method === 'chatgpt'
      ? await models.connectChatGpt({ model: body.model })
      : await models.connectWithKey({ provider: body.provider, model: body.model, apiKey: body.apiKey });
    res.json({ connection: toConnectionDto(connection) });
  }));

  router.get('/chatgpt/models', handle(async (_req, res) => {
    res.json({ models: await models.listChatGptModels() });
  }));

  router.post('/chatgpt/start', requireCapability(MODEL_WRITE), handle(async (req, res) => {
    const body = parseOr400(ChatGptStartBodySchema, req.body, res);
    if (!body) return;
    const returnTo = `${deps.appUrl}${body.returnTo ?? '/'}`;
    res.json(await deps.chatGpt.start({ redirectUri: deps.chatGptRedirectUri, returnTo }));
  }));

  router.post('/test', requireCapability(MODEL_WRITE), handle(async (_req, res) => {
    const result = await deps.probe();
    if (!result) {
      return sendApiError(res, {
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
        message: 'No model is connected',
        userMessage: 'No model is connected',
      });
    }
    res.json({ ok: result.ok, latencyMs: result.latencyMs, message: result.message });
  }));

  router.delete('/', requireCapability(MODEL_WRITE), handle(async (_req, res) => {
    res.json(await models.disconnect());
  }));

  return router;
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);

const page = (title: string, text: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>`
  + `<body style="font-family:system-ui,sans-serif;background:#0b0b0c;color:#e8e8ea;padding:48px">`
  + `<h1 style="font-size:20px">${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body></html>`;

const backTo = (returnTo: string, params: Record<string, string>): string => {
  const url = new URL(returnTo);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
};

/**
 * GET /auth/callback, where ChatGPT sends the browser back. It is a top-level navigation, so it
 * carries no owner key: the one-time `state` of an attempt this backend started is what admits it.
 * Codes and tokens never reach the browser; it is sent back to the app with an outcome only.
 */
export function createChatGptCallbackRouter(chatGpt: ChatGptSignIn): Router {
  const router = Router();
  router.get('/', handle(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const result = await chatGpt.complete(req.query as Record<string, unknown>);
      if (result.returnTo) return res.redirect(302, backTo(result.returnTo, { chatgpt: result.outcome }));
      const text = result.outcome === 'connected'
        ? `Null AI now uses your ChatGPT plan (${result.connection?.label ?? 'model'}). You can close this tab.`
        : result.outcome === 'no_plan'
          ? 'You signed in, but plan usage was not allowed, so nothing was connected.'
          : 'You signed in, but your plan\'s models could not be listed yet. Choose one in Settings → Model.';
      return res.status(200).type('html').send(page('Sign in with ChatGPT', text));
    } catch (error) {
      if (error instanceof ChatGptSignInError) {
        logger.warn({ reason: error.reason }, '[ChatGptSignIn] Callback refused');
        if (error.returnTo) return res.redirect(302, backTo(error.returnTo, { chatgpt: 'error', reason: error.reason }));
        return res.status(400).type('html').send(page('Sign in with ChatGPT', error.message));
      }
      throw error;
    }
  }));
  return router;
}
