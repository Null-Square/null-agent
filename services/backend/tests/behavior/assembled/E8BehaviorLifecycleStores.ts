import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  AppendModelRequestInput,
  BlockToolExecutionInput,
  CanonicalToolExecutionStatus,
  CompleteToolExecutionInput,
  CreateToolExecutionInput,
  FailToolExecutionInput,
  ModelRequestPort,
  ModelRequestRecord,
  OutcomeUnknownToolExecutionInput,
  ToolExecutionIdentity,
  ToolExecutionPort,
  ToolExecutionRecord,
} from '../../../src/domains/agent-brain/ports';

type StoredToolRecord = Omit<ToolExecutionRecord, 'claimedAt' | 'startedAt' | 'completedAt'> & {
  claimedAt?: string;
  startedAt?: string;
  completedAt?: string;
};

type StoredModelRequest = Omit<ModelRequestRecord, 'createdAt'> & { createdAt: string };

const clone = <T>(value: T): T => structuredClone(value);

const readRecords = <T>(filePath: string): T[] => {
  if (!existsSync(filePath)) return [];
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { records?: T[] };
  return Array.isArray(parsed.records) ? parsed.records : [];
};

const writeRecords = <T>(filePath: string, schemaVersion: number, records: T[]): void => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion, records }, null, 2)}\n`, 'utf8');
  renameSync(temporary, filePath);
};

const toToolRecord = (record: StoredToolRecord): ToolExecutionRecord => ({
  ...clone(record),
  claimedAt: record.claimedAt ? new Date(record.claimedAt) : undefined,
  startedAt: record.startedAt ? new Date(record.startedAt) : undefined,
  completedAt: record.completedAt ? new Date(record.completedAt) : undefined,
});

export class E8BehaviorToolExecutionStore implements ToolExecutionPort {
  constructor(private readonly filePath: string) {
    if (!existsSync(filePath)) writeRecords(filePath, 2, []);
  }

  async findByToolCallId(
    sessionId: string,
    toolCallId: string,
  ): Promise<ToolExecutionRecord | undefined> {
    const record = readRecords<StoredToolRecord>(this.filePath).find(
      (candidate) => candidate.sessionId === sessionId && candidate.toolCallId === toolCallId,
    );
    return record ? toToolRecord(record) : undefined;
  }

  async create(input: CreateToolExecutionInput): Promise<ToolExecutionRecord> {
    return (await this.claim(input)).record;
  }

  async claim(
    input: CreateToolExecutionInput,
  ): Promise<{ record: ToolExecutionRecord; claimed: boolean }> {
    const records = readRecords<StoredToolRecord>(this.filePath);
    const existing = records.find(
      (candidate) => candidate.sessionId === input.sessionId
        && candidate.toolCallId === input.toolCallId,
    );
    if (existing) return { record: toToolRecord(existing), claimed: false };
    const record: StoredToolRecord = {
      id: randomUUID(),
      ...clone(input),
      status: 'claimed',
      claimedAt: new Date().toISOString(),
    };
    records.push(record);
    writeRecords(this.filePath, 2, records);
    return { record: toToolRecord(record), claimed: true };
  }

  async markStarted(input: ToolExecutionIdentity): Promise<void> {
    this.transition(input, ['claimed'], 'started', (record) => {
      record.status = 'started';
      record.startedAt = new Date().toISOString();
    });
  }

  async complete(input: CompleteToolExecutionInput): Promise<void> {
    this.transition(input, ['started'], 'succeeded', (record) => {
      record.status = 'succeeded';
      record.result = clone(input.result);
      record.durationMs = input.durationMs;
      record.completedAt = new Date().toISOString();
    });
  }

  async fail(input: FailToolExecutionInput): Promise<void> {
    this.transition(input, ['started'], 'failed', (record) => {
      record.status = 'failed';
      record.error = input.error;
      record.durationMs = input.durationMs;
      record.completedAt = new Date().toISOString();
    });
  }

  async block(input: BlockToolExecutionInput): Promise<void> {
    this.transition(input, ['claimed', 'started'], 'blocked', (record) => {
      record.status = 'blocked';
      record.error = input.reason;
      record.durationMs = input.durationMs;
      record.completedAt = new Date().toISOString();
    });
  }

  async markOutcomeUnknown(input: OutcomeUnknownToolExecutionInput): Promise<void> {
    this.transition(input, ['started'], 'outcome_unknown', (record) => {
      record.status = 'outcome_unknown';
      record.error = input.reason;
      record.completedAt = new Date().toISOString();
    });
  }

  async findBySession(sessionId: string): Promise<ToolExecutionRecord[]> {
    return readRecords<StoredToolRecord>(this.filePath)
      .filter((record) => record.sessionId === sessionId)
      .map(toToolRecord);
  }

  async findByTurn(sessionId: string, turnId: string): Promise<ToolExecutionRecord[]> {
    return readRecords<StoredToolRecord>(this.filePath)
      .filter((record) => record.sessionId === sessionId && record.turnId === turnId)
      .map(toToolRecord);
  }

  private transition(
    input: ToolExecutionIdentity,
    allowed: CanonicalToolExecutionStatus[],
    target: CanonicalToolExecutionStatus,
    mutate: (record: StoredToolRecord) => void,
  ): void {
    const records = readRecords<StoredToolRecord>(this.filePath);
    const record = records.find(
      (candidate) => candidate.sessionId === input.sessionId
        && candidate.toolCallId === input.toolCallId,
    );
    if (record?.status === target) return;
    if (!record || !allowed.includes(record.status as CanonicalToolExecutionStatus)) {
      throw new Error(
        `tool_execution_transition_rejected:${record?.status ?? 'missing'}->${target}`,
      );
    }
    mutate(record);
    writeRecords(this.filePath, 2, records);
  }
}

export class E8BehaviorModelRequestStore implements ModelRequestPort {
  constructor(private readonly filePath: string) {
    if (!existsSync(filePath)) writeRecords(filePath, 3, []);
  }

  async append(input: AppendModelRequestInput): Promise<ModelRequestRecord> {
    const records = readRecords<StoredModelRequest>(this.filePath);
    const existing = records.find((record) => record.requestId === input.requestId);
    if (existing) {
      if (existing.digest !== input.digest) {
        throw new Error(`model_request_immutable_conflict:${input.requestId}`);
      }
      return this.toRuntime(existing);
    }
    const record: StoredModelRequest = {
      ...clone(input),
      provenance: 'recorded',
      createdAt: (input.createdAt ?? new Date()).toISOString(),
    };
    records.push(record);
    writeRecords(this.filePath, 3, records);
    return this.toRuntime(record);
  }

  async findByRequestId(requestId: string): Promise<ModelRequestRecord | undefined> {
    const record = readRecords<StoredModelRequest>(this.filePath)
      .find((candidate) => candidate.requestId === requestId);
    return record ? this.toRuntime(record) : undefined;
  }

  async findBySession(sessionId: string): Promise<ModelRequestRecord[]> {
    return readRecords<StoredModelRequest>(this.filePath)
      .filter((record) => record.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((record) => this.toRuntime(record));
  }

  private toRuntime(record: StoredModelRequest): ModelRequestRecord {
    return { ...clone(record), createdAt: new Date(record.createdAt) };
  }
}
