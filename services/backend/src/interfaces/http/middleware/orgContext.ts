import type { NextFunction, Response } from 'express';

import { organizationContextAppService } from '@/app/services/platform/organizations/organizationContextAppService';
import { resolvePrimaryOrganizationMembership } from '@/shared/auth/resolveOrgMembership';
import { normalizeOrgRole, type OrgRole } from '@/shared/auth/orgRoles';
import { AppError, ERROR_CODES } from '@/shared/errors';
import type { AuthenticatedRequest } from '@/shared/types/express';

type OrgContextSource = NonNullable<AuthenticatedRequest['orgContextSource']>;

const getParam = (req: AuthenticatedRequest, name: string): string | null => {
  const value = req.params?.[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
};

const setResolvedOrgContext = async (
  req: AuthenticatedRequest,
  organizationId: string,
  source: OrgContextSource,
): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) {
    throw new AppError(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS, 'Not authenticated');
  }

  if (req.user?.role === 'system') {
    req.organizationId = organizationId;
    req.orgRole = 'admin';
    req.orgContextSource = source;
    return;
  }

  const membershipRole = await organizationContextAppService.findMembershipRole(organizationId, userId);
  const role = normalizeOrgRole(membershipRole);
  if (!role) {
    throw new AppError(
      ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
      'User is not a member of the requested organization',
    );
  }

  req.organizationId = organizationId;
  req.orgRole = role;
  req.orgContextSource = source;
};

const requireResourceContext =
  (
    paramName: string,
    loadOrganizationId: (resourceId: string) => Promise<string | null>,
  ) =>
  async (req: AuthenticatedRequest, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const resourceId = getParam(req, paramName);
      if (!resourceId) {
        return next(
          new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, `${paramName} must be provided`),
        );
      }

      const organizationId = await loadOrganizationId(resourceId);
      if (!organizationId) {
        return next(new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Resource not found'));
      }

      await setResolvedOrgContext(req, organizationId, 'resource');
      return next();
    } catch (error) {
      return next(error);
    }
  };

export const requirePrimaryOrgContext = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS, 'Not authenticated'));
    }
    const membership = await resolvePrimaryOrganizationMembership(userId);
    req.organizationId = membership.organizationId;
    req.orgRole = membership.role as OrgRole;
    req.orgContextSource = 'primary';
    return next();
  } catch (error) {
    return next(error);
  }
};

/**
 * The application and agent route trees act for the person's primary organization unless a
 * context is already set. A route that names a resource still resolves that resource's own
 * organization (and checks membership) after this.
 */
export const ensurePrimaryOrgContext = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  if (req.organizationId && req.orgRole && req.orgContextSource) return next();
  return requirePrimaryOrgContext(req, res, next);
};

export const requireAssetOrgContext = (paramName = 'id') =>
  requireResourceContext(paramName, organizationContextAppService.findAssetOrganizationId);

export const requireAutomationOrgContext = (paramName = 'id') =>
  requireResourceContext(paramName, organizationContextAppService.findAutomationOrganizationId);

export const requireComplianceEvidenceOrgContext = (paramName = 'id') =>
  requireResourceContext(paramName, organizationContextAppService.findComplianceEvidenceOrganizationId);

export const requireFindingOrgContext = (paramName = 'id') =>
  requireResourceContext(paramName, organizationContextAppService.findFindingOrganizationId);

export const requireRunnerOrgContext = (paramName = 'id') =>
  requireResourceContext(paramName, organizationContextAppService.findRunnerOrganizationId);

export const requireScopeOrgContext = (paramName = 'id') =>
  requireResourceContext(paramName, organizationContextAppService.findScopeOrganizationId);
