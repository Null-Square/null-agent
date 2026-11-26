import { sessionResolverService } from '@/domains/platform/sessions/SessionResolverService';

export type SessionResolverAppService = typeof sessionResolverService;

export const sessionResolverAppService: SessionResolverAppService = sessionResolverService;

export type {
  DerivedRuntimeState,
  LiveSessionState,
  SandboxInfo,
  SessionResolverService,
} from '@/domains/platform/sessions/SessionResolverService';
