/**
 * @null-ai/contracts
 *
 * Shared types and utilities for Null AI services.
 * Import from here for session status, blocked reasons, and derive functions.
 *
 * @example
 * import { SessionStatus, deriveStatus } from '@null-ai/contracts';
 * import { TaskSummary, taskSummarySchema } from '@null-ai/contracts';
 */

// Session types and utilities
export {
  type SessionStatus,
  type DesiredSessionExecution,
  type SessionExecutionCondition,
  type SessionExecutionReadModel,
  type SessionPauseReason,
  type SessionInteractionType,
  type BlockedReason,
  type SystemPauseCauseCode,
  type DerivedSessionState,
  type DeriveStatusInput,
  SESSION_STATUSES,
  DESIRED_SESSION_EXECUTIONS,
  SESSION_EXECUTION_CONDITIONS,
  SESSION_PAUSE_REASONS,
  SESSION_INTERACTION_TYPES,
  BLOCKED_REASONS,
  SYSTEM_PAUSED_BLOCKED_REASON,
  SYSTEM_PAUSE_CAUSE_CODES,
} from './session/types.js';

export { deriveStatus, deriveSessionState } from './session/deriveStatus.js';
export {
  type SessionDisplayKind,
  type SessionPresentationInput,
  type SessionPresentation,
  type SessionActionAvailability,
  SESSION_DISPLAY_KINDS,
  resolveSessionPresentation,
  resolveSessionDisplayKind,
  resolveSessionActions,
  canAcceptSessionInput,
  resolveSystemPauseCauseCode,
  formatSystemPauseCause,
} from './session/presentation.js';

// Task types and schemas
export {
  type TaskInputType,
  type TaskInputComponent,
  type TaskInputValueType,
  type TaskInputFormat,
  type TaskInputOption,
  type TaskInputDefinition,
  type TaskInputDefinitionSeed,
  type TaskSummary,
  type PlanBlueprintStep,
  type TaskManifest,
  taskInputTypeSchema,
  taskInputComponentSchema,
  taskInputValueTypeSchema,
  taskInputFormatSchema,
  taskInputOptionSchema,
  taskInputOptionsSchema,
  taskInputDefinitionSchema,
  taskInputDefinitionSeedSchema,
  taskSummarySchema,
  planBlueprintStepSchema,
  taskManifestSchema,
  normalizeTaskInputOptions,
  normalizeTaskInputDefinition,
  normalizeTaskInputDefinitions,
  validateTaskSummaries,
  validateTaskManifest,
} from './task/types.js';

// Message types and schemas
export {
  type MessageRole,
  type MessageStatus,
  type ChatMessage,
  messageRoleSchema,
  messageStatusSchema,
  chatMessageSchema,
  validateMessages,
} from './message/types.js';

// Artifact types and schemas
export {
  type StorageType,
  type SessionArtifact,
  storageTypeSchema,
  sessionArtifactSchema,
  validateArtifacts,
} from './artifact/types.js';

// Settings types and schemas
export {
  type NetworkSettings,
  type SandboxSettings,
  type RuntimeSettings,
  type TraceSettings,
  type GuardrailSettings,
  type SettingsCategory,
  networkSettingsSchema,
  sandboxSettingsSchema,
  runtimeSettingsSchema,
  traceSettingsSchema,
  guardrailSettingsSchema,
  SETTINGS_CATEGORIES,
} from './settings/types.js';

// Model selection categories
export {
  type ModelCategory,
  MODEL_CATEGORIES,
  DEFAULT_MODEL_CATEGORY,
  MODEL_CATEGORY_LABELS,
  MODEL_CATEGORY_DESCRIPTIONS,
  modelCategorySchema,
  isModelCategory,
  normalizeModelCategory,
} from './model/types.js';

// SecurityOps compliance framework keys
export {
  type ComplianceFrameworkKey,
  COMPLIANCE_FRAMEWORK_KEYS,
  isComplianceFrameworkKey,
} from './security-ops/compliance.js';

// SecurityOps target ownership verification (single source of truth)
export {
  type TargetVerificationInstructions,
  DNS_VERIFICATION_HOST_LABEL,
  HTTP_VERIFICATION_WELL_KNOWN_PATH,
  VERIFICATION_VALUE_PREFIX,
  normalizeVerificationDomain,
  dnsVerificationHost,
  expectedVerificationValue,
  httpVerificationUrls,
  buildTargetVerificationInstructions,
  normalizeChallengeValue,
  valueMatchesToken,
  txtRecordsMatchToken,
} from './security-ops/verification.js';

export {
  type ScopeRuleType,
  type ScopeRule,
  type ScopeImpactTolerance,
  type ScopeContract,
  type ScopeWideningReason,
  SCOPE_AUTHORIZATION_STATEMENT,
  SCOPE_AUTHORIZATION_STATEMENT_VERSION,
  SCOPE_WIDENING_REASON_LABELS,
  normalizeContract,
  scopeRuleCovers,
  findScopeWideningReasons,
  scopeChangeRequiresStatement,
} from './security-ops/scopeAuthorization.js';

// SSE Stream Event types
export {
  type SSEEventType,
  type SSEEvent,
  type TokenEvent,
  type MessageStartEvent,
  type MessageEndEvent,
  type DoneEvent,
  type ErrorEvent,
  type ToolStartedEvent,
  type ToolCompletedEvent,
  type ApprovalRequiredEvent,
  type ApprovalGrantedEvent,
  type ContextEstimateEvent,
  type ContextWarningEvent,
  type ContextCompactedEvent,
  type ContextTrimmedEvent,
  type CreditsExhaustedEvent,
  type CreditsLowEvent,
  type TokenLimitExceededEvent,
  type SessionStatusEvent,
  type TimelineEntry,
  type TimelineEntryKind,
  type TimelineEntryStatus,
  type TimelineEntrySource,
  type TimelineEntryImportance,
  type TimelineEvent,
  type AbortedEvent,
  type CheckpointCreatedEvent,
  SSE_EVENT_TYPES,
  SSE_EVENTS,
  sseEventTypeSchema,
  TIMELINE_ENTRY_KINDS,
  TIMELINE_ENTRY_STATUSES,
  TIMELINE_ENTRY_SOURCES,
  TIMELINE_ENTRY_IMPORTANCE,
  timelineEntryKindSchema,
  timelineEntryStatusSchema,
  timelineEntrySourceSchema,
  timelineEntryImportanceSchema,
  timelineEntrySchema,
  type LiveEventKind,
  type LiveEvent,
  LIVE_EVENT_KINDS,
  liveEventSchema,
} from './stream/types.js';

// Error Code types and utilities
export {
  type ErrorCategory,
  type ErrorCodeKey,
  type ErrorCodeValue,
  type ErrorMetadata,
  type BaseErrorContext,
  type SerializedApiError,
  ERROR_CATEGORIES,
  ERROR_CODES,
  ERROR_METADATA,
  errorCategorySchema,
  getErrorMetadata,
  isRetryableCode,
  getHttpStatus,
  getUserMessage,
  getErrorCategory,
  // Client-side error utilities
  ClientApiError,
  isClientApiError,
  parseClientApiError,
} from './errors/types.js';

// Pagination types and schemas
export {
  type CursorPaginationInput,
  type CursorPaginationMeta,
  type CursorPage,
  type OffsetPaginationInput,
  type OffsetPaginationMeta,
  type OffsetPage,
  cursorPaginationInputSchema,
  cursorPaginationMetaSchema,
  offsetPaginationInputSchema,
  offsetPaginationMetaSchema,
  parseCursorPaginationInput,
  parseOffsetPaginationInput,
} from './pagination/types.js';
