import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type {
  CompleteToolExecutionInput,
  CreateToolExecutionInput,
  FailToolExecutionInput,
  ToolExecutionPort,
  ToolExecutionRecord,
} from '../../../src/domains/agent-brain/ports';
import type {
  BehaviorMessageObservation,
  DurableObservationSnapshot,
  ModelRequestObservation,
  ProviderAttemptObservation,
  TerminalStateObservation,
  ToolExecutionObservation,
} from './types';

type StoredData = DurableObservationSnapshot & {
  schemaVersion: 1;
  sessionSnapshot?: Record<string, unknown>;
};

const emptyData = (): StoredData => ({
  schemaVersion: 1,
  messages: [],
  modelRequests: [],
  providerAttempts: [],
  toolExecutions: [],
  terminalStates: [],
  deliberateCorruptions: [],
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const toRuntimeRecord = (record: ToolExecutionObservation): ToolExecutionRecord => ({
  ...clone(record),
  startedAt: new Date(record.startedAt),
  completedAt: record.completedAt ? new Date(record.completedAt) : undefined,
});

export class DurableBehaviorStore implements ToolExecutionPort {
  private data: StoredData;

  constructor(
    private readonly filePath: string,
    private readonly options: { rejectTerminalSettlement?: boolean } = {},
  ) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.data = existsSync(filePath)
      ? JSON.parse(readFileSync(filePath, 'utf8')) as StoredData
      : emptyData();
    if (!existsSync(filePath)) this.persist();
  }

  get path(): string {
    return this.filePath;
  }

  saveSessionSnapshot(snapshot: Record<string, unknown>): void {
    this.data.sessionSnapshot = clone(snapshot);
    this.persist();
  }

  loadSessionSnapshot(): Record<string, unknown> | undefined {
    return this.data.sessionSnapshot ? clone(this.data.sessionSnapshot) : undefined;
  }

  appendMessage(message: BehaviorMessageObservation): void {
    this.data.messages.push(clone(message));
    this.persist();
  }

  appendModelRequest(request: ModelRequestObservation): void {
    this.data.modelRequests.push(clone(request));
    this.persist();
  }

  appendProviderAttempt(attempt: ProviderAttemptObservation): void {
    this.data.providerAttempts.push(clone(attempt));
    this.persist();
  }

  appendTerminalState(state: TerminalStateObservation): void {
    this.data.terminalStates.push(clone(state));
    this.persist();
  }

  omitToolExecutionForNegativeControl(toolCallId: string, reason: string): void {
    this.data.toolExecutions = this.data.toolExecutions.filter(
      (record) => record.toolCallId !== toolCallId,
    );
    this.data.deliberateCorruptions.push({
      kind: 'omit_tool_execution_records',
      toolCallId,
      reason,
      recordedAt: new Date().toISOString(),
    });
    this.persist();
  }

  snapshot(): DurableObservationSnapshot {
    return clone({
      messages: this.data.messages,
      modelRequests: this.data.modelRequests,
      providerAttempts: this.data.providerAttempts,
      toolExecutions: this.data.toolExecutions,
      terminalStates: this.data.terminalStates,
      deliberateCorruptions: this.data.deliberateCorruptions,
    });
  }

  async findByToolCallId(
    sessionId: string,
    toolCallId: string,
  ): Promise<ToolExecutionRecord | undefined> {
    const record = this.data.toolExecutions.find(
      (candidate) => candidate.sessionId === sessionId && candidate.toolCallId === toolCallId,
    );
    return record ? toRuntimeRecord(record) : undefined;
  }

  async create(input: CreateToolExecutionInput): Promise<ToolExecutionRecord> {
    const claim = await this.claim(input);
    return claim.record;
  }

  async claim(
    input: CreateToolExecutionInput,
  ): Promise<{ record: ToolExecutionRecord; claimed: boolean }> {
    const existing = await this.findByToolCallId(input.sessionId, input.toolCallId);
    if (existing) return { record: existing, claimed: false };

    const record: ToolExecutionObservation = {
      id: `execution-${input.toolCallId}`,
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: clone(input.args ?? {}),
      status: 'pending',
      startedAt: new Date().toISOString(),
    };
    this.data.toolExecutions.push(record);
    this.persist();
    return { record: toRuntimeRecord(record), claimed: true };
  }

  async complete(input: CompleteToolExecutionInput): Promise<void> {
    if (this.options.rejectTerminalSettlement) {
      throw new Error('behavior_lab_named_fault:terminal_settlement_unavailable');
    }
    const record = this.requireRecord(input.sessionId, input.toolCallId);
    record.status = 'completed';
    record.result = clone(input.result);
    record.completedAt = new Date().toISOString();
    record.durationMs = input.durationMs;
    this.persist();
  }

  async fail(input: FailToolExecutionInput): Promise<void> {
    if (this.options.rejectTerminalSettlement) {
      throw new Error('behavior_lab_named_fault:terminal_settlement_unavailable');
    }
    const record = this.requireRecord(input.sessionId, input.toolCallId);
    record.status = 'failed';
    record.error = input.error;
    record.completedAt = new Date().toISOString();
    record.durationMs = input.durationMs;
    this.persist();
  }

  async findBySession(sessionId: string): Promise<ToolExecutionRecord[]> {
    return this.data.toolExecutions
      .filter((record) => record.sessionId === sessionId)
      .map(toRuntimeRecord);
  }

  async findByTurn(sessionId: string, turnId: string): Promise<ToolExecutionRecord[]> {
    return this.data.toolExecutions
      .filter((record) => record.sessionId === sessionId && record.turnId === turnId)
      .map(toRuntimeRecord);
  }

  private requireRecord(sessionId: string, toolCallId: string): ToolExecutionObservation {
    const record = this.data.toolExecutions.find(
      (candidate) => candidate.sessionId === sessionId && candidate.toolCallId === toolCallId,
    );
    if (!record) throw new Error(`missing tool execution ${sessionId}/${toolCallId}`);
    return record;
  }

  private persist(): void {
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    try {
      renameSync(tempPath, this.filePath);
    } catch {
      copyFileSync(tempPath, this.filePath);
      rmSync(tempPath, { force: true });
    }
  }
}
