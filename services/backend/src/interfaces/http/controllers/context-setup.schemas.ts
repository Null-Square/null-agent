import { z } from 'zod';

const optionalTrimmedText = (maxLength: number) =>
  z
    .string()
    .trim()
    .max(maxLength)
    .optional();

const optionalLabelList = (maxItems: number, maxLength: number) =>
  z
    .array(z.string().trim().min(1).max(maxLength))
    .max(maxItems)
    .optional();

export const OrgContextSetupAnswersSchema = z
  .object({
    businessContext: optionalTrimmedText(1_500),
    sensitiveDataTypes: optionalLabelList(12, 120),
    sensitiveDataWhere: optionalTrimmedText(1_000),
    compliance: optionalLabelList(12, 120),
    pciDssProfile: optionalTrimmedText(1_000),
    hardNoActions: optionalTrimmedText(1_500),
    escalationContact: optionalTrimmedText(320),
    escalationSla: optionalTrimmedText(120),
  })
  .strict();

export const RoeContextSetupAnswersSchema = z
  .object({
    excludedServices: optionalLabelList(12, 120),
    excludedPaths: optionalTrimmedText(1_000),
    forbiddenTechniques: optionalTrimmedText(1_000),
    priorKnowledge: optionalTrimmedText(1_500),
    operatorNotes: optionalTrimmedText(1_500),
  })
  .strict();

export const ScopeContextSetupSeedSchema = z
  .object({
    scopeName: optionalTrimmedText(160),
    targets: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    existingRoeDocument: optionalTrimmedText(1_500),
  })
  .strict();

export const OrgContextSetupGenerateBodySchema = z
  .object({
    answers: OrgContextSetupAnswersSchema,
  })
  .strict();

export const ScopeContextSetupGenerateBodySchema = z
  .object({
    answers: RoeContextSetupAnswersSchema,
    seed: ScopeContextSetupSeedSchema.optional(),
  })
  .strict();

export type OrgContextSetupAnswers = z.infer<typeof OrgContextSetupAnswersSchema>;
export type RoeContextSetupAnswers = z.infer<typeof RoeContextSetupAnswersSchema>;
export type OrgContextSetupGenerateBody = z.infer<typeof OrgContextSetupGenerateBodySchema>;
export type ScopeContextSetupGenerateBody = z.infer<typeof ScopeContextSetupGenerateBodySchema>;
export type ScopeContextSetupSeed = z.infer<typeof ScopeContextSetupSeedSchema>;
