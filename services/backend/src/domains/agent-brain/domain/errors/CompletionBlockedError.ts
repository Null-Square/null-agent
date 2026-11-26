/**
 * Completion Validation Errors
 * 
 * PHASE 4 HARDENING: Structured errors for completion gating.
 * These enable proper retry/backoff behavior and metrics bucketing.
 */

export type CompletionBlockedReason =
  | 'report_missing_in_s3'
  | 's3_unavailable'
  | 'artifact_upload_pending'
  | 'artifact_validation_failed';

/**
 * Error thrown when completion is blocked due to missing durable artifacts.
 * 
 * This is a RETRYABLE error for 's3_unavailable' and 'artifact_upload_pending'.
 * It is NOT retryable for 'report_missing_in_s3' (genuine missing artifact).
 */
export class CompletionBlockedError extends Error {
  readonly name = 'CompletionBlockedError';
  readonly retryable: boolean;
  readonly reason: CompletionBlockedReason;
  readonly sessionId: string;
  readonly artifactName?: string;

  constructor(options: {
    reason: CompletionBlockedReason;
    sessionId: string;
    artifactName?: string;
    message?: string;
  }) {
    const defaultMessage = `Completion blocked: ${options.reason}`;
    super(options.message ?? defaultMessage);
    
    this.reason = options.reason;
    this.sessionId = options.sessionId;
    this.artifactName = options.artifactName;
    
    // Retryable if infra failure, not if genuinely missing
    this.retryable = options.reason === 's3_unavailable' 
      || options.reason === 'artifact_upload_pending';
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      reason: this.reason,
      retryable: this.retryable,
      sessionId: this.sessionId,
      artifactName: this.artifactName,
    };
  }
}

/**
 * Result of S3 object existence check.
 * Distinguishes between "not found" and "infra failure".
 */
export type S3ExistsResult = 
  | { exists: true }
  | { exists: false; reason: 'not_found' }
  | { exists: false; reason: 's3_error'; error: Error };
