import { actionIdBodySchema, sessionIdParamSchema } from './common';

export const approvalsParamsSchema = sessionIdParamSchema;

export const approvalDecisionBodySchema = actionIdBodySchema;
