import type { OnboardingProgress, SetupFormData } from './types';

/* Four screens: the model, the organization, the website, the authorization. */
export const MODEL_STEP = 1;
export const ORGANIZATION_STEP = 2;
export const WEBSITE_STEP = 3;
export const AUTHORIZE_STEP = 4;
export const ONBOARDING_STEP_COUNT = 4;
/* Checkpoints are writes, not screens. There are two: the organization, and
   the authorized scope with its target. The authorization step writes the
   second, so no third checkpoint exists and the resume step stops at the last
   screen. The model is not a checkpoint: its truth is the connection the
   server holds, so saved progress counts the same as before it was added. */
export const LAST_CHECKPOINT_STEP = 2;

const clampCompletedStep = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), LAST_CHECKPOINT_STEP);
};

const hasOrganization = (data: SetupFormData) => data.orgName.trim().length > 2;
const hasScope = (data: SetupFormData) => data.scopeName.trim().length > 2;
const hasTarget = (data: SetupFormData) => data.targetValue.trim().length > 3;

export const getValidatedCompletedStep = (
  progress: Pick<OnboardingProgress, 'lastCompletedStep' | 'formData' | 'scopeId' | 'targetId'>,
): number => {
  const reported = clampCompletedStep(progress.lastCompletedStep);
  if (reported < 1 || !hasOrganization(progress.formData)) return 0;
  if (
    reported < 2 ||
    !hasScope(progress.formData) ||
    !hasTarget(progress.formData) ||
    !progress.scopeId ||
    !progress.targetId
  ) {
    return Math.min(reported, 1);
  }
  return reported;
};

/** The first screen after the model whose checkpoint is not written yet. */
export const getStepAfterModel = (lastCompletedStep: number): number =>
  Math.min(clampCompletedStep(lastCompletedStep) + ORGANIZATION_STEP, ONBOARDING_STEP_COUNT);

/**
 * Where setup opens. A fresh setup, or one with no model connected, opens on
 * the model; progress made before the model step existed resumes where it was
 * once a model is connected.
 */
export const getOnboardingResumeStep = (lastCompletedStep: number, modelConnected: boolean): number => {
  if (!modelConnected || clampCompletedStep(lastCompletedStep) === 0) return MODEL_STEP;
  return getStepAfterModel(lastCompletedStep);
};
