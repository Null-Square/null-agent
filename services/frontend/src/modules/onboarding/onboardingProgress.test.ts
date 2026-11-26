import { describe, expect, it } from 'vitest';
import { getOnboardingResumeStep, getStepAfterModel, getValidatedCompletedStep } from './onboardingProgress';
import type { OnboardingProgress, SetupFormData } from './types';

const formData: SetupFormData = {
  orgName: 'NullSquare',
  operationalContext: '',
  scopeName: 'Production',
  mission: '',
  impactTolerance: 'non_destructive',
  complianceFrameworks: [],
  targetType: 'domain',
  targetValue: 'example.com',
  domainVerificationMethod: 'dns_txt',
  isTargetVerified: false,
};

const progress = (overrides: Partial<OnboardingProgress> = {}): OnboardingProgress => ({
  version: 1,
  lastCompletedStep: 2,
  formData,
  scopeId: 'scope-1',
  targetId: 'target-1',
  targetSnapshot: 'domain:example.com:dns_txt',
  updatedAt: '2026-07-26T00:00:00.000Z',
  ...overrides,
});

describe('onboarding progress', () => {
  /* Two checkpoints, four screens: the model first, then organization,
     website and authorization. Checkpoint 2 is written by the authorization
     step, so reaching it resumes on that step rather than sending the customer
     back to re-enter the website. */
  it('resumes at the first incomplete step once a model is connected', () => {
    expect(getOnboardingResumeStep(1, true)).toBe(3);
    expect(getOnboardingResumeStep(2, true)).toBe(4);
    expect(getOnboardingResumeStep(5, true)).toBe(4);
  });

  it('opens on the model for a fresh setup, or when no model is connected', () => {
    expect(getOnboardingResumeStep(0, true)).toBe(1);
    expect(getOnboardingResumeStep(0, false)).toBe(1);
    expect(getOnboardingResumeStep(1, false)).toBe(1);
    expect(getOnboardingResumeStep(2, false)).toBe(1);
  });

  /* Progress saved before the model step existed keeps its meaning: after the
     model, it continues at the screen it had reached. */
  it('continues after the model where the saved progress left off', () => {
    expect(getStepAfterModel(0)).toBe(2);
    expect(getStepAfterModel(1)).toBe(3);
    expect(getStepAfterModel(2)).toBe(4);
  });

  it('cannot skip organization or scope with edited progress', () => {
    expect(getValidatedCompletedStep(progress({
      formData: { ...formData, orgName: '' },
    }))).toBe(0);
    expect(getValidatedCompletedStep(progress({
      formData: { ...formData, scopeName: '' },
    }))).toBe(1);
  });

  it('cannot skip target creation with stale identifiers', () => {
    expect(getValidatedCompletedStep(progress({ targetId: null }))).toBe(1);
    expect(getValidatedCompletedStep(progress({
      formData: { ...formData, targetValue: '' },
    }))).toBe(1);
  });
});
