/**
 * Session DTOs - API Response Types
 *
 * These types replace `any` usage in session router handlers.
 * For internal session state, use SessionState from @/domains/agent-brain/core/types.
 */

import type { ArtifactDetailDTO } from './ArtifactDTO';
import type { MessageResponseDTO } from './MessageDTO';
import type { TimelineEntry } from '@null-ai/contracts';

// =============================================================================
// Database Row Types (from repositories)
// =============================================================================

/**
 * Session row as returned from SessionRepository.
 * Matches the Drizzle schema for agent_sessions table.
 * Note: Database may return null for optional fields.
 */
export interface SessionRowDTO {
  id: string;
  userId: string | null;
  title: string | null;
  mode: string; // DB returns string, caller can narrow to 'interactive' | 'automated'
  createdAt: Date | number;
  updatedAt?: Date | number | null;
  lastActiveAt?: Date | number | null;
  blockedReason?: string | null;
  completed?: boolean | null;
  summary?: string | null;
  plan?: unknown; // JSONB - can be array or null
  metadata?: Record<string, unknown> | null;
}

// =============================================================================
// Session Usage Types
// =============================================================================

export interface SessionUsageDTO {
  promptTokens: number;
  cachedPromptTokens?: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number;
  overhead?: number;
  platformCost?: number;
  platformPrice?: number;
  credits?: number;
  currency?: string;
  model?: string;
  contextWindow?: number | null;
  contextRemaining?: number | null;
  lastTurnInputTokens?: number;
}

export interface UsageHistoryEntryDTO {
  turn: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number;
  model?: string;
  timestamp?: number;
}

// =============================================================================
// Plan Types
// =============================================================================

export type StepStatusDTO =
  | "pending"
  | "running"
  | "completed"
  | "blocked"
  | "error";

export interface PlanItemDTO {
  id: string;
  title: string;
  status: StepStatusDTO;
  notes?: string;
  startedAt?: number;
  completedAt?: number;
  blockedReason?: string;
  lastTool?: string;
  outputSnippet?: string;
  artifactLinks?: string[];
  checkpointId?: string;
}

// =============================================================================
// API Response Types
// =============================================================================

/**
 * Session list item for GET /sessions endpoint.
 */
export interface SessionListItemDTO {
  id: string;
  userId: string | null;
  title: string | null;
  status: string;
  blocked_reason: string | null;
  blocked_meta?: Record<string, unknown> | null;
  isProcessing: boolean;
  completed: boolean;
  mode: "interactive" | "automated";
  createdAt: number;
  lastActive: number;
  updatedAt: number;
  summary?: string;
}

/**
 * Session detail for GET /sessions/:id endpoint.
 */
export interface SessionDetailDTO extends SessionListItemDTO {
  turn: number;
  report?: string;
  messages: MessageResponseDTO[];
  plan: PlanItemDTO[];
  usage: SessionUsageDTO | null;
  usageHistory?: UsageHistoryEntryDTO[];
  artifacts: ArtifactDetailDTO[];
  timeline?: TimelineEntry[];
}

/**
 * Admin session list item with additional fields.
 */
export interface AdminSessionListItemDTO {
  id: string;
  user_id: string | null;
  status: string;
  blocked_reason: string | null;
  blocked_meta?: Record<string, unknown> | null;
  isProcessing: boolean;
  created_at: number | null;
  updated_at: number | null;
  last_active_at: number | null;
  mode: string;
  model?: string;
  metadata?: Record<string, unknown>;
  title: string | null;
  summary?: string;
}
