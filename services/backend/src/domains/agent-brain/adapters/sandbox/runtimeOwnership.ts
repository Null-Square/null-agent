import type { SessionState } from '../../domain/types';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

export type CloudAdmissionRuntimeOwnership = {
  runId?: string;
  admissionEpoch?: number;
  leaseId?: string;
  bundleKey?: string;
  workerTaskId?: string;
};

export const readCloudAdmissionRuntimeOwnership = (
  session: Pick<SessionState, 'flags' | 'coordination'>,
): CloudAdmissionRuntimeOwnership => {
  const securityOps = asRecord(session.flags?.securityops);
  const admission = asRecord(securityOps?.cloudAdmission);
  const rawEpoch = admission?.admissionEpoch;
  const admissionEpoch =
    typeof rawEpoch === 'number' && Number.isSafeInteger(rawEpoch) && rawEpoch > 0 ? rawEpoch : undefined;

  return {
    runId: asNonEmptyString(securityOps?.runId),
    admissionEpoch,
    leaseId: asNonEmptyString(admission?.leaseId),
    bundleKey: asNonEmptyString(admission?.bundleKey),
    workerTaskId:
      asNonEmptyString(admission?.workerTaskId) ??
      (session.coordination?.role === 'worker' ? asNonEmptyString(session.coordination.parentTaskId) : undefined),
  };
};

export const buildAdmissionRuntimeLabels = (
  session: Pick<SessionState, 'id' | 'flags' | 'coordination'>,
  runtimeKind: 'sandbox' | 'sidecar',
): Record<string, string> => {
  const ownership = readCloudAdmissionRuntimeOwnership(session);
  return {
    'nullai.sandbox': 'true',
    'nullai.runtime-kind': runtimeKind,
    'nullai.session-id': session.id,
    ...(ownership.runId ? { 'nullai.run-id': ownership.runId } : {}),
    ...(ownership.admissionEpoch ? { 'nullai.admission-epoch': String(ownership.admissionEpoch) } : {}),
    ...(ownership.leaseId ? { 'nullai.capacity-lease-id': ownership.leaseId } : {}),
    ...(ownership.bundleKey ? { 'nullai.capacity-bundle-key': ownership.bundleKey } : {}),
    ...(ownership.workerTaskId ? { 'nullai.worker-task-id': ownership.workerTaskId } : {}),
  };
};
