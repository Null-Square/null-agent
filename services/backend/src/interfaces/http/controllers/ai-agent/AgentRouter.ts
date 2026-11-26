import { Router } from 'express';
import { rateLimit, requestId, errorHandler, requestContextMiddleware } from './middleware';
import {
  sessionsRouter,
  streamRouter,
  healthRouter,
} from './routes';
import type { AgentApiServices } from './types';
import type { ResolvedConfig } from '@/config/configTypes';

type CreateAgentRouterOptions = {
  services: AgentApiServices;
  rateLimitOptions?: Parameters<typeof rateLimit>[0];
  config?: ResolvedConfig;
  appRole?: string;
  enableWorkers?: boolean;
};

export const createAgentRouter = (options: CreateAgentRouterOptions): Router => {
  if (!options?.services) {
    throw new Error('AgentRouter requires services to be provided.');
  }
  const services = options.services;

  const router = Router();

  router.use(requestContextMiddleware()); // Request tracing with x-request-id
  router.use(requestId); // (legacy)
  router.use(rateLimit(options.rateLimitOptions));

  router.use(
    sessionsRouter(services, {
      appRole: options.appRole,
      enableWorkers: options.enableWorkers,
    }),
  );
  router.use(streamRouter(services));
  router.use(healthRouter(services));

  router.use(errorHandler);

  return router;
};

export type { AgentApiServices };




