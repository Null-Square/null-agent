import * as path from 'path';
import type { SessionState } from '../../domain/types';
import type { ResolvedConfig } from '@/config/configTypes';

export type AgentSessionEndReason = 'explicit' | 'ttl' | 'expired';

export interface AgentSessionRecord {
  id: string;
  status?: string;
  created_at?: string;
  last_active?: string;
  ended_at?: string | null;
  end_reason?: string | null;
  turns?: number;
  plan_length?: number;
  pending_approvals?: number;
  sandbox_profile?: string | null;
  task_title?: string | null;
  is_active?: boolean;
  snapshot?: {
    messages?: SessionState['messages'];
    plan?: SessionState['plan'];
    flags?: SessionState['flags'];
    toolPolicy?: SessionState['toolPolicy'];
    extraContext?: SessionState['extraContext'];
  };
}

export interface AgentSessionHistoryPagination {
  nextCursor?: string | null;
  prevCursor?: string | null;
}

export interface AgentSessionHistoryResult {
  sessions: AgentSessionRecord[];
  pagination: AgentSessionHistoryPagination;
}

const HISTORY_FILENAME = 'session-history.json';

const resolveHistoryPath = (config?: ResolvedConfig): string => {
  const traceRoot = path.resolve(
    process.cwd(),
    config?.trace.traceLogsRoot ?? 'storage/object-store/traces',
  );
  const historyDir = path.dirname(traceRoot);
  return path.resolve(historyDir, HISTORY_FILENAME);
};

const clampMessages = (messages: SessionState['messages']): SessionState['messages'] => {
  if (!Array.isArray(messages)) {
    return [];
  }
  const limit = 25;
  if (messages.length <= limit) {
    return messages;
  }
  return messages.slice(-limit);
};

const toIso = (value: number | undefined): string | undefined => {
  if (!value || Number.isNaN(value)) {
    return undefined;
  }
  try {
    return new Date(value).toISOString();
  } catch {
    return undefined;
  }
};

export class AgentSessionHistoryService {
  private readonly historyPath: string;
  private readonly records = new Map<string, AgentSessionRecord>();
  private ready: Promise<void>;
  private saveTimer?: NodeJS.Timeout;
  private readonly config?: ResolvedConfig;

  constructor(config?: ResolvedConfig) {
    this.config = config;
    this.historyPath = resolveHistoryPath(config);
    this.ready = Promise.resolve(); // disable disk hydration to avoid creating session-history.json
  }

  private async loadFromDisk(): Promise<void> {
    // no-op to prevent creating/reading session-history.json
  }

  private scheduleSave(): void {
    // disabled: we no longer persist session-history.json
  }

  private async persist(): Promise<void> {
    // disabled: avoid writing session-history.json
  }

  private buildRecord(session: SessionState, existing?: AgentSessionRecord): AgentSessionRecord {
    const created = toIso(session.createdAt) ?? existing?.created_at;
    const lastActive = toIso(session.lastActive) ?? existing?.last_active;
    return {
      id: session.id,
      status: (typeof session?.stateMachine?.isProcessing === 'function' && session.stateMachine.isProcessing()) ? 'running' : 'idle',
      created_at: created,
      last_active: lastActive,
      ended_at: existing?.ended_at ?? null,
      end_reason: existing?.end_reason ?? null,
      turns: session.turn,
      plan_length: session.plan?.length ?? 0,
      pending_approvals: session.pendingApproval ? 1 : 0,
      sandbox_profile: session.sandboxProfile ?? null,
      task_title: session.task?.title ?? null,
      is_active: existing?.is_active ?? true,
      snapshot: {
        messages: clampMessages(session.messages),
        plan: session.plan,
        flags: session.flags,
        toolPolicy: session.toolPolicy,
        extraContext: session.extraContext,
      },
    };
  }

  async upsertSnapshots(sessions: SessionState[]): Promise<void> {
    await this.ready;
    let mutated = false;
    for (const session of sessions) {
      if (!session?.id) {
        continue;
      }
      const existing = this.records.get(session.id);
      this.records.set(session.id, this.buildRecord(session, existing));
      mutated = true;
    }
    if (mutated) {
      this.scheduleSave();
    }
  }

  async markSessionEnded(session: SessionState, reason: AgentSessionEndReason): Promise<void> {
    await this.ready;
    if (!session?.id) {
      return;
    }
    const existing = this.records.get(session.id) ?? this.buildRecord(session);
    existing.ended_at = new Date().toISOString();
    existing.end_reason = reason;
    existing.is_active = false;
    this.records.set(session.id, existing);
    this.scheduleSave();
  }

  async expireStaleSessions(thresholdMs: number): Promise<void> {
    await this.ready;
    const cutoff = Date.now() - Math.max(0, thresholdMs);
    let mutated = false;
    for (const [id, record] of this.records.entries()) {
      if (record.is_active !== false && record.last_active) {
        const last = Date.parse(record.last_active);
        if (!Number.isNaN(last) && last < cutoff) {
          record.is_active = false;
          record.end_reason = record.end_reason ?? 'expired';
          record.ended_at = record.ended_at ?? new Date(cutoff).toISOString();
          this.records.set(id, record);
          mutated = true;
        }
      }
    }
    if (mutated) {
      this.scheduleSave();
    }
  }

  async listSessions(options: { limit?: number } = {}): Promise<AgentSessionHistoryResult> {
    await this.ready;
    const limit = Math.max(1, options.limit ?? 50);
    const sessions = Array.from(this.records.values())
      .sort((a, b) => {
        const aTime = a.last_active ?? a.created_at ?? '';
        const bTime = b.last_active ?? b.created_at ?? '';
        return aTime < bTime ? 1 : -1;
      })
      .slice(0, limit);
    return {
      sessions,
      pagination: { nextCursor: null, prevCursor: null },
    };
  }

  async getSessionById(sessionId: string): Promise<AgentSessionRecord | null> {
    await this.ready;
    return this.records.get(sessionId) ?? null;
  }
}

export default AgentSessionHistoryService;

