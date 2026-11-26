import { z } from 'zod';

export const ATTACK_OBJECTIVE_FAMILIES = [
  'demonstrate_command_execution',
  'demonstrate_authorization_bypass',
  'demonstrate_account_takeover',
  'demonstrate_sensitive_data_access',
  'demonstrate_ssrf_reachability',
  'demonstrate_privilege_change',
] as const;

export const ATTACK_RESULT_STATUSES = [
  'impact_demonstrated',
  'not_demonstrated',
  'inconclusive',
  'denied',
  'cancelled',
  'failed',
  'cleanup_failed',
] as const;

const nonEmptyString = z.string().trim().min(1);
const uniqueStrings = (maximum: number) =>
  z.array(nonEmptyString).max(maximum).transform((values) => Array.from(new Set(values)));

export const AttackMissionV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('controlled_exploitation_v1'),
  objectiveFamily: z.enum(ATTACK_OBJECTIVE_FAMILIES),
  objective: nonEmptyString.max(2_000),
  validatedFindingIds: uniqueStrings(3).pipe(z.array(nonEmptyString).min(1).max(3)),
  targetRef: nonEmptyString.max(2_048),
  boundedPaths: uniqueStrings(25).optional(),
  allowedImpact: uniqueStrings(12).pipe(z.array(nonEmptyString).min(1).max(12)),
  requestBudget: z.number().int().min(1).max(100).default(60),
  toolBudget: z.number().int().min(1).max(45).default(30),
  timeBudgetSeconds: z.number().int().min(1).max(900).default(600),
  maxRequestConcurrency: z.number().int().min(1).max(2).default(1),
  requiredProof: uniqueStrings(12).pipe(z.array(nonEmptyString).min(1).max(12)),
  stopConditions: uniqueStrings(12).pipe(z.array(nonEmptyString).min(1).max(12)),
  cleanupPlan: uniqueStrings(12).pipe(z.array(nonEmptyString).min(1).max(12)),
}).strict();

export const AttackAttemptV1Schema = z.object({
  sequence: z.number().int().min(1).max(45),
  action: nonEmptyString.max(500),
  status: z.enum(['completed', 'blocked', 'failed']),
  evidenceIds: uniqueStrings(25),
  changedState: z.boolean().default(false),
}).strict();

export const AttackPolicySnapshotV1Schema = z.object({
  featureEnabled: z.literal(true),
  organizationAllowlisted: z.literal(true),
  runTrigger: z.literal('manual'),
  workflowDiscipline: z.literal('pentest'),
  impactTolerance: z.literal('full'),
  phaseKey: z.literal('exploitation'),
  verifiedTarget: z.literal(true),
  requestBudget: z.number().int().min(1).max(100),
  toolBudget: z.number().int().min(1).max(45),
  timeBudgetSeconds: z.number().int().min(1).max(900),
  capturedAt: z.string().datetime(),
}).strict();

export const AttackCleanupV1Schema = z.object({
  required: z.boolean(),
  status: z.enum(['not_required', 'completed', 'failed', 'unknown']),
  actions: uniqueStrings(25),
  evidenceIds: uniqueStrings(25),
  remainingRisk: nonEmptyString.max(4_000).nullable(),
}).strict().superRefine((cleanup, context) => {
  if (cleanup.required && cleanup.status === 'not_required') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'cleanup status cannot be not_required when cleanup is required',
    });
  }
  if ((cleanup.status === 'failed' || cleanup.status === 'unknown') && !cleanup.remainingRisk) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['remainingRisk'],
      message: 'remainingRisk is required when cleanup failed or is unknown',
    });
  }
});

export const AttackResultV1Schema = z.object({
  schemaVersion: z.literal(1),
  missionId: nonEmptyString.max(200),
  validatedFindingIds: uniqueStrings(3).pipe(z.array(nonEmptyString).min(1).max(3)),
  targetRef: nonEmptyString.max(2_048),
  objectiveFamily: z.enum(ATTACK_OBJECTIVE_FAMILIES),
  status: z.enum(ATTACK_RESULT_STATUSES),
  attempts: z.array(AttackAttemptV1Schema).max(45),
  proofClaim: nonEmptyString.max(8_000),
  evidenceIds: uniqueStrings(100),
  changedStateSummary: nonEmptyString.max(4_000).nullable(),
  cleanup: AttackCleanupV1Schema,
  limitations: uniqueStrings(25),
  policySnapshot: AttackPolicySnapshotV1Schema,
}).strict().superRefine((result, context) => {
  if (
    result.status === 'impact_demonstrated' &&
    result.evidenceIds.length === 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evidenceIds'],
      message: 'impact_demonstrated requires durable evidence',
    });
  }
  if (
    result.status === 'cleanup_failed' &&
    result.cleanup.status !== 'failed' &&
    result.cleanup.status !== 'unknown'
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cleanup', 'status'],
      message: 'cleanup_failed requires failed or unknown cleanup status',
    });
  }
});

export type AttackMissionV1 = z.infer<typeof AttackMissionV1Schema>;
export type AttackResultV1 = z.infer<typeof AttackResultV1Schema>;
export type AttackObjectiveFamily = AttackMissionV1['objectiveFamily'];
export type AttackResultStatus = AttackResultV1['status'];

export const parseAttackMissionV1 = (value: unknown): AttackMissionV1 =>
  AttackMissionV1Schema.parse(value);

export const parseAttackResultV1 = (value: unknown): AttackResultV1 =>
  AttackResultV1Schema.parse(value);

