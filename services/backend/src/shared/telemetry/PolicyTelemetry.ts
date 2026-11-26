import { opsMetrics } from '@/shared/metrics/opsMetrics';

export interface PolicyTelemetry {
  policyResolved(source: string, profile?: string): void;
  automationGuard(status: 'fired' | 'exhausted' | 'none', retryCount?: number, pendingSteps?: number): void;
}

export class OpsPolicyTelemetry implements PolicyTelemetry {
  policyResolved(source: string, profile?: string): void {
    opsMetrics.recordPolicyResolution(source, profile);
  }
  automationGuard(status: 'fired' | 'exhausted' | 'none', retryCount: number = 0, pendingSteps: number = 0): void {
    opsMetrics.recordAutomationGuard(status, retryCount, pendingSteps);
  }
}
