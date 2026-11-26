export interface RetrySchedulerPort {
  scheduleRetry(params: {
    sessionId: string;
    message: string;
    profile?: string;
    processMessage: (sessionId: string, input: string, profile?: string) => Promise<void>;
    delayMs?: number;
    reason?: string;
    executionClaimToken?: string;
  }): Promise<void>;
}
