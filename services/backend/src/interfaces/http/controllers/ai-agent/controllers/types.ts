/**
 * SessionControllerContext - Shared dependencies for session controllers
 * 
 * All controllers receive this context to access repositories, services,
 * and shared utilities without duplicating initialization logic.
 */

import type { AgentApiServices } from '../types';
import type { AuthenticatedRequest } from '@/shared/middleware/auth.middleware';
import type { AgentRepositories } from '@/app/services/agent/agentRepositories';
import type { SessionResponseBuilder } from '../services/SessionResponseBuilder';
import type { SessionService } from '@/domains/agent-brain/application/services/SessionService';
import type { S3StorageService } from '@/shared/storage/S3StorageService';
import type { SessionArtifact, SessionState } from '@/domains/agent-brain/domain/types';
import type { Logger } from 'pino';
import type { PlatformKernel } from '@/app/platform/kernel';
import type { ScopeAwareChatContextService } from '@/domains/security-ops/chat/ScopeAwareChatContextService';
import type { ScopeVerificationGate } from '@/domains/security-ops/scopes/scopeVerificationGate';

export interface SessionsRouterOptions {
  appRole?: string;
  enableWorkers?: boolean;
}

export interface SessionControllerContext {
  // Core services from AgentApiServices
  services: AgentApiServices;
  
  // Repositories
  sessionRepository: AgentRepositories['sessionRepository'];
  messageRepository: AgentRepositories['messageRepository'];
  artifactRepository: AgentRepositories['artifactRepository'];
  
  // Domain services
  sessionService: SessionService;
  sessionSummaryService: unknown;
  scopeAwareChatContextService?: ScopeAwareChatContextService;
  /** Defaults to the process-wide gate; injectable for tests. */
  scopeVerificationGate?: Pick<ScopeVerificationGate, 'check'>;
  accessControl: PlatformKernel['accessControl'];
  
  // Response utilities
  responseBuilder: SessionResponseBuilder;
  
  // Storage
  artifactStorageRoot: string;
  s3Artifacts?: S3StorageService;
  
  // Logger
  log: Logger;
  
  // Router options
  options: SessionsRouterOptions;
}

/**
 * Base class for session controllers providing common utilities
 */
export abstract class BaseSessionController {
  protected readonly ctx: SessionControllerContext;

  constructor(context: SessionControllerContext) {
    this.ctx = context;
  }

  // Common helper methods that controllers can use
  
  protected get services() {
    return this.ctx.services;
  }
  
  protected get sessionRepository() {
    return this.ctx.sessionRepository;
  }
  
  protected get messageRepository() {
    return this.ctx.messageRepository;
  }
  
  protected get responseBuilder() {
    return this.ctx.responseBuilder;
  }
  
  protected get log() {
    return this.ctx.log;
  }
}

// Re-export types for controllers
export type { AuthenticatedRequest, SessionArtifact, SessionState };

