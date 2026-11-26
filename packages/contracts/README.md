# @null-ai/contracts

**Shared types and utilities for the Null AI backend and app.**

This package is the **single source of truth** for types used by the backend and the frontend. Import from here to prevent type drift between them.

## Installation

Already included as a workspace dependency. Import directly:

```typescript
import { SessionStatus, deriveStatus, TaskSummary } from '@null-ai/contracts';
```

## Quick Reference

### Session Types

```typescript
import { SessionStatus, BlockedReason, deriveSessionState, deriveStatus, DeriveStatusInput } from '@null-ai/contracts';

// Derive canonical session state from DB/runtime fields
const state = deriveSessionState({ blockedReason: 'awaiting_user' });
// Returns:
// {
//   status: 'paused',
//   pauseReason: 'manual',
//   interactionType: 'none',
//   blockedReason: 'awaiting_user'
// }

// Derive just the top-level status when needed
const status = deriveStatus({ isProcessing: true, blockedReason: null });
// Returns: 'running' | 'idle' | 'paused' | 'completed' | 'failed' | 'error'
```

### Task Types

```typescript
import { 
  TaskSummary, 
  TaskManifest, 
  TaskInputDefinition,
  validateTaskSummaries 
} from '@null-ai/contracts';
```

### Message Types

```typescript
import { ChatMessage, MessageRole, validateMessages } from '@null-ai/contracts';
```

### Error Codes

```typescript
import { 
  ERROR_CODES, 
  getErrorMetadata, 
  isRetryableCode,
  ClientApiError,
  parseClientApiError 
} from '@null-ai/contracts';

// Example: Check if error is retryable
if (isRetryableCode(ERROR_CODES.LLM_RATE_LIMIT_EXCEEDED)) {
  // Implement retry logic
}

// Example: Parse any error to typed ClientApiError
const apiError = parseClientApiError(caughtError);
if (apiError.isCreditsError) {
  showUpgradeModal();
}
```

### SSE Stream Events

```typescript
import { SSE_EVENTS, SSEEventType } from '@null-ai/contracts';
```

### Settings Types

```typescript
import { 
  BillingSettings, 
  NetworkSettings, 
  EmailSettings,
  SandboxSettings 
} from '@null-ai/contracts';
```

## All Exports

| Category | Types | Utilities |
|----------|-------|-----------|
| **Session** | `SessionStatus`, `BlockedReason`, `DeriveStatusInput`, `DerivedSessionState` | `deriveStatus()`, `deriveSessionState()` |
| **Task** | `TaskSummary`, `TaskManifest`, `TaskInputDefinition` | `validateTaskSummaries()`, `validateTaskManifest()` |
| **Message** | `ChatMessage`, `MessageRole`, `MessageStatus` | `validateMessages()` |
| **Artifact** | `SessionArtifact`, `StorageType` | `validateArtifacts()` |
| **Usage** | `UsageStats` | — |
| **Settings** | 8 settings types | Zod schemas |
| **Stream** | `SSEEventType`, `SSEEvent` | `SSE_EVENTS` constant |
| **Errors** | `ErrorCodeValue`, `ErrorMetadata`, `ClientApiError` | `getErrorMetadata()`, `isRetryableCode()`, `parseClientApiError()` |
| **Support** | `SupportTicket`, `CreateTicketRequest` | Zod schemas |
| **Pagination** | `CursorPage`, `OffsetPage` | `parseCursorPaginationInput()` |

## Building

```bash
cd packages/contracts
npm run build
```

Output goes to `dist/`. The build is required when types change for other services to pick up updates.

## Validation with Zod

All types have corresponding Zod schemas for runtime validation:

```typescript
import { taskSummarySchema, chatMessageSchema } from '@null-ai/contracts';

// Validate at runtime
const result = taskSummarySchema.safeParse(unknownData);
if (result.success) {
  const task: TaskSummary = result.data;
}
```

## For AI Agents

When modifying shared types:
1. Update schema in `src/<category>/types.ts`
2. Re-export from `src/index.ts` if adding new types
3. Run `npm run build`
4. Update consumers (backend/frontend) as needed
5. Types must stay backward-compatible (add optional fields, don't remove)
