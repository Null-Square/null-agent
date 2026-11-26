import { createModelConfigPort } from '@/app/adapters/portFactories';
import { db } from '@/db/client';
import type { ResolvedConfig } from '@/config/configTypes';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { ScopeService } from '@/domains/security-ops/scopes/ScopeService';
import { SecurityOpsToolService } from '@/domains/security-ops/tools/SecurityOpsToolService';
import { AutomationService } from '@/domains/security-ops/automations/AutomationService';
import { LlmFindingDuplicateJudge } from '@/domains/security-ops/tools/FindingDuplicateJudge';
import { PersonaService } from '@/domains/security-ops/personas/PersonaService';
import { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import { SetupReadinessService } from '@/domains/security-ops/setup/SetupReadinessService';
import { WebsitePlatformDetectionService } from '@/domains/security-ops/setup/WebsitePlatformDetectionService';
import { ScopeDocumentService } from '@/domains/security-ops/setup/ScopeDocumentService';
import { AccessControlService } from '@/domains/platform/subscriptions/accessControlService';

// Marker for ToolManifestRegistry: this is a helper module, not a tool module definition.
export const __skipToolManifest = true as const;

const scopeService = new ScopeService(db);
const automationService = new AutomationService({ db });
const personaService = new PersonaService(db);
const organizationService = new OrganizationService(db);
const websitePlatformDetectionService = new WebsitePlatformDetectionService();
const scopeDocumentService = new ScopeDocumentService(db);
const accessControlService = new AccessControlService();
const setupReadinessService = new SetupReadinessService(db, organizationService, scopeService, accessControlService);
const modelConfigPort = createModelConfigPort();
const fallbackService = new SecurityOpsToolService({
  db,
  scopeService,
  automationService,
});
const servicesByConfig = new WeakMap<ResolvedConfig, SecurityOpsToolService>();

export const getSecurityOpsService = (ctx: ToolContext): SecurityOpsToolService => {
  if (!ctx.config) {
    return fallbackService;
  }

  const cached = servicesByConfig.get(ctx.config);
  if (cached) {
    return cached;
  }

  const service = new SecurityOpsToolService({
    db,
    scopeService,
    automationService,
    duplicateJudge: new LlmFindingDuplicateJudge(),
  });
  servicesByConfig.set(ctx.config, service);
  return service;
};

export const getPersonaService = (): PersonaService => personaService;
export const getOrganizationService = (): OrganizationService => organizationService;
export const getScopeService = (): ScopeService => scopeService;
export const getAutomationService = (): AutomationService => automationService;
export const getSetupReadinessService = (): SetupReadinessService => setupReadinessService;
export const getWebsitePlatformDetectionService = (): WebsitePlatformDetectionService => websitePlatformDetectionService;
export const getScopeDocumentService = (): ScopeDocumentService => scopeDocumentService;
export const getAccessControlService = (): AccessControlService => accessControlService;
export const getModelConfigPort = () => modelConfigPort;
