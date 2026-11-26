import { and, eq } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  auditLogs,
  complianceControlStates,
  organizationMembers,
  scopes,
  type ComplianceControlMonitoringState as DbComplianceControlMonitoringState,
  type ComplianceControlStateRow,
} from '@/db/schema';

import {
  COMPLIANCE_FRAMEWORK_KEYS,
  FRAMEWORK_REGISTRY,
  type ComplianceFrameworkKey,
} from './frameworks';

export interface ComplianceControlStateDto {
  id: string;
  organizationId: string;
  scopeId: string;
  frameworkKey: ComplianceFrameworkKey;
  controlId: string;
  state: DbComplianceControlMonitoringState;
  exclusionReason: string | null;
  assignedToUserId: string | null;
  assignedByUserId: string | null;
  assignedAt: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertComplianceControlStateInput {
  organizationId: string;
  scopeId: string;
  frameworkKey: ComplianceFrameworkKey;
  controlId: string;
  state: DbComplianceControlMonitoringState;
  exclusionReason?: string | null;
  assignedToUserId?: string | null;
  actorUserId?: string | null;
}

export interface BulkUpsertComplianceControlStateInput {
  organizationId: string;
  scopeId: string;
  frameworkKey: ComplianceFrameworkKey;
  controlIds: string[];
  state: DbComplianceControlMonitoringState;
  exclusionReason?: string | null;
  actorUserId?: string | null;
}

const rowToDto = (row: ComplianceControlStateRow): ComplianceControlStateDto => ({
  id: row.id,
  organizationId: row.organizationId,
  scopeId: row.scopeId,
  frameworkKey: row.frameworkKey as ComplianceFrameworkKey,
  controlId: row.controlId,
  state: row.state,
  exclusionReason: row.exclusionReason,
  assignedToUserId: row.assignedToUserId,
  assignedByUserId: row.assignedByUserId,
  assignedAt: row.assignedAt?.toISOString() ?? null,
  createdByUserId: row.createdByUserId,
  updatedByUserId: row.updatedByUserId,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const assertFrameworkKey = (frameworkKey: string): ComplianceFrameworkKey => {
  if ((COMPLIANCE_FRAMEWORK_KEYS as readonly string[]).includes(frameworkKey)) {
    return frameworkKey as ComplianceFrameworkKey;
  }
  throw new Error(`Unsupported compliance framework: ${frameworkKey}`);
};

const resolveControlId = (frameworkKey: ComplianceFrameworkKey, controlId: string): string => {
  const normalized = controlId.trim().toUpperCase();
  const match = FRAMEWORK_REGISTRY[frameworkKey]?.controls.find(
    (control) => control.id.toUpperCase() === normalized,
  );
  if (!match) {
    throw new Error(`Unknown compliance control: ${frameworkKey}:${controlId}`);
  }
  return match.id;
};

const auditSnapshot = (row: ComplianceControlStateRow | null) => row
  ? {
      state: row.state,
      exclusionReason: row.exclusionReason,
      assignedToUserId: row.assignedToUserId,
      assignedByUserId: row.assignedByUserId,
      assignedAt: row.assignedAt?.toISOString() ?? null,
    }
  : null;

export class ComplianceControlStateService {
  constructor(private readonly db: DatabaseClient) {}

  async listExplicitStates(params: {
    organizationId: string;
    scopeId: string;
    frameworkKey?: ComplianceFrameworkKey | null;
  }): Promise<ComplianceControlStateDto[]> {
    await this.assertScope(params.organizationId, params.scopeId);
    const conditions = [
      eq(complianceControlStates.organizationId, params.organizationId),
      eq(complianceControlStates.scopeId, params.scopeId),
    ];
    if (params.frameworkKey) {
      conditions.push(eq(complianceControlStates.frameworkKey, params.frameworkKey));
    }

    const rows = await this.db
      .select()
      .from(complianceControlStates)
      .where(and(...conditions));
    return rows.map(rowToDto);
  }

  async upsertState(input: UpsertComplianceControlStateInput): Promise<ComplianceControlStateDto> {
    const frameworkKey = assertFrameworkKey(input.frameworkKey);
    const controlId = resolveControlId(frameworkKey, input.controlId);
    await this.assertScope(input.organizationId, input.scopeId);
    if (input.assignedToUserId) {
      await this.assertMember(input.organizationId, input.assignedToUserId);
    }

    const now = new Date();
    const state = input.state;
    const exclusionReason = state === 'excluded'
      ? input.exclusionReason?.trim() ?? ''
      : input.exclusionReason?.trim() || null;
    if (state === 'excluded' && (exclusionReason ?? '').length < 5) {
      throw new Error('Exclusion reason is required when excluding a compliance control');
    }
    const assignedToUserId = input.assignedToUserId || null;
    const assignmentChanged = assignedToUserId !== null;

    const row = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(complianceControlStates)
        .where(and(
          eq(complianceControlStates.organizationId, input.organizationId),
          eq(complianceControlStates.scopeId, input.scopeId),
          eq(complianceControlStates.frameworkKey, frameworkKey),
          eq(complianceControlStates.controlId, controlId),
        ))
        .limit(1);

      const [updated] = await tx
        .insert(complianceControlStates)
        .values({
          organizationId: input.organizationId,
          scopeId: input.scopeId,
          frameworkKey,
          controlId,
          state,
          exclusionReason,
          assignedToUserId,
          assignedByUserId: assignmentChanged ? input.actorUserId ?? null : null,
          assignedAt: assignmentChanged ? now : null,
          createdByUserId: input.actorUserId ?? null,
          updatedByUserId: input.actorUserId ?? null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            complianceControlStates.organizationId,
            complianceControlStates.scopeId,
            complianceControlStates.frameworkKey,
            complianceControlStates.controlId,
          ],
          set: {
            state,
            exclusionReason,
            assignedToUserId,
            assignedByUserId: assignmentChanged ? input.actorUserId ?? null : null,
            assignedAt: assignmentChanged ? now : null,
            updatedByUserId: input.actorUserId ?? null,
            updatedAt: now,
          },
        })
        .returning();

      if (!updated) {
        throw new Error('Failed to update compliance control state');
      }

      if (input.actorUserId) {
        await tx.insert(auditLogs).values({
          organizationId: input.organizationId,
          actorId: input.actorUserId,
          actorType: 'user',
          action: 'compliance.control_state.updated',
          resourceType: 'compliance_control',
          resourceId: `${frameworkKey}:${controlId}`,
          changes: {
            previous: auditSnapshot(existing ?? null),
            next: auditSnapshot(updated),
            changed: {
              state: (existing?.state ?? null) !== updated.state,
              exclusionReason: (existing?.exclusionReason ?? null) !== updated.exclusionReason,
              assignedToUserId: (existing?.assignedToUserId ?? null) !== updated.assignedToUserId,
            },
          },
          metadata: {
            scopeId: input.scopeId,
            frameworkKey,
            controlId,
          },
        });
      }

      return updated;
    });

    if (!row) {
      throw new Error('Failed to update compliance control state');
    }
    return rowToDto(row);
  }

  async bulkUpsertState(input: BulkUpsertComplianceControlStateInput): Promise<ComplianceControlStateDto[]> {
    const uniqueControlIds = Array.from(new Set(input.controlIds.map((controlId) => controlId.trim()).filter(Boolean)));
    if (uniqueControlIds.length === 0) {
      throw new Error('At least one compliance control is required');
    }
    if (uniqueControlIds.length > 100) {
      throw new Error('Cannot update more than 100 compliance controls at once');
    }
    const states: ComplianceControlStateDto[] = [];
    for (const controlId of uniqueControlIds) {
      states.push(await this.upsertState({
        organizationId: input.organizationId,
        scopeId: input.scopeId,
        frameworkKey: input.frameworkKey,
        controlId,
        state: input.state,
        exclusionReason: input.exclusionReason ?? null,
        actorUserId: input.actorUserId ?? null,
      }));
    }
    return states;
  }

  private async assertScope(organizationId: string, scopeId: string): Promise<void> {
    const [scope] = await this.db
      .select({ id: scopes.id })
      .from(scopes)
      .where(and(eq(scopes.organizationId, organizationId), eq(scopes.id, scopeId)))
      .limit(1);
    if (!scope) {
      throw new Error('Scope not found');
    }
  }

  private async assertMember(organizationId: string, userId: string): Promise<void> {
    const [member] = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
      .limit(1);
    if (!member) {
      throw new Error('Assigned user is not a member of this organization');
    }
  }
}
