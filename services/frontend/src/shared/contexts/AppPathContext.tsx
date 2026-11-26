import { createContext, useContext, type ReactNode } from 'react';

export type AppPaths = {
  settingsHome: string;
  organizationSettings: string;
  scopesList: string;
  scopeDetail: (scopeId: string) => string;
  runnersList: string;
  runnerDetail: (runnerId: string) => string;
  automationsList: string;
  automationDetail: (automationId: string) => string;
  credentialsList: string;
  auditLogsList: string;
  /** One Risks destination: findings and exposures merged (audit §7A). */
  risksList: string;
  findingDetail: (findingId: string) => string;
  exposureDetail: (exposureId: string) => string;
  assetsList: string;
  assetDetail: (assetId: string) => string;
  runsList: string;
  runDetail: (runId: string) => string;
  runWorkbench: (runId: string) => string;
  codeOccurrence: (occurrenceId: string) => string;
  compliance: string;
  complianceControl: (frameworkKey: string, controlId: string) => string;
  chat: string;
};

export const DEFAULT_APP_PATHS: AppPaths = {
  settingsHome: '/settings',
  organizationSettings: '/settings/organization',
  scopesList: '/scopes',
  scopeDetail: (scopeId: string) => `/scopes/${scopeId}`,
  runnersList: '/runners',
  runnerDetail: (runnerId: string) => `/runners/${runnerId}`,
  automationsList: '/automations',
  automationDetail: (automationId: string) => `/automations/${automationId}`,
  credentialsList: '/credentials',
  auditLogsList: '/audit-logs',
  risksList: '/risks',
  findingDetail: (findingId: string) => `/risks/${findingId}`,
  exposureDetail: (exposureId: string) => `/risks/advisory/${exposureId}`,
  assetsList: '/assets',
  assetDetail: (assetId: string) => `/assets/${assetId}`,
  runsList: '/runs',
  runDetail: (runId: string) => `/runs/${runId}`,
  runWorkbench: (runId: string) => `/runs/${runId}/workbench`,
  codeOccurrence: (occurrenceId: string) => `/risks/code/${occurrenceId}`,
  compliance: '/compliance',
  complianceControl: (frameworkKey: string, controlId: string) => `/compliance/${frameworkKey}/${encodeURIComponent(controlId)}`,
  chat: '/chat',
};

const AppPathContext = createContext<AppPaths>(DEFAULT_APP_PATHS);

export function AppPathProvider({ children, value }: { children: ReactNode; value: AppPaths }) {
  return <AppPathContext.Provider value={value}>{children}</AppPathContext.Provider>;
}

export function useAppPaths(): AppPaths {
  return useContext(AppPathContext);
}
