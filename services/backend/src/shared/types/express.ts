import type { Request } from 'express';
import type { AppLogger } from '@/shared/logger';
import type { ResolvedConfig } from '@/config/configTypes';
import type { OrgRole } from '@/shared/auth/orgRoles';

export interface AuthenticatedUser {
  id: string;
  email: string;
  email_verified?: boolean;
  disabled?: boolean;
  role?: string;
  created_at?: string;
  updated_at?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
  orgRole?: OrgRole;
  organizationId?: string;
  orgContextSource?: 'primary' | 'resource' | 'explicit';
  requestId?: string;
  logger?: AppLogger;
}

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    logger?: AppLogger;
    user?: AuthenticatedUser;
    orgRole?: OrgRole;
    organizationId?: string;
    orgContextSource?: 'primary' | 'resource' | 'explicit';
    userId?: string;
    auth?: { userId?: string };
  }

  interface Locals {
    requestId?: string;
    config?: ResolvedConfig;
  }
}
