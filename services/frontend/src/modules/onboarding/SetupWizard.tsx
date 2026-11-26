import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button, CellIcon, type CellIconName } from '@null-ai/design-tokens/ui';
import { toastService } from '@shared/services/toastService';
import { toApiError } from '@shared/lib/apiError';
import {
  useAddTargetMutation,
  useCreateScopeMutation,
  useRemoveTargetMutation,
  useOrganizationQuery,
  useScopesQuery,
  useUpdateScopeMutation,
  useVerifyTargetMutation,
  useUpdateOrganizationMutation,
  type ScopeTarget,
} from '@modules/security-ops/api';
import { useScope } from '@shared/contexts/ScopeContext';
import { cn } from '@shared/lib/utils';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/modules/auth';
import { authClient } from '@/modules/auth/api/authClient';
import { fetchModelOverview, modelConnectionQueryKey, useModelConnectionQuery } from '@modules/model';
import StepModel from './steps/StepModel';
import Step1Organization from './steps/Step1Organization';
import Step2Target from './steps/Step2Target';
import Step3Authorize from './steps/Step3Authorize';
import type { OnboardingProgress, SetupFormData } from './types';
import {
  AUTHORIZE_STEP,
  MODEL_STEP,
  ORGANIZATION_STEP,
  WEBSITE_STEP,
  getOnboardingResumeStep,
  getStepAfterModel,
  getValidatedCompletedStep,
} from './onboardingProgress';
import { toNullableText } from '@/modules/context-setup/lib/contextDocuments';

// Each step names its subject with the icon that page uses everywhere else,
// so the wizard is recognisably about the same things the product is about.
const STEPS = [
  {
    id: MODEL_STEP,
    icon: 'integrations',
    label: 'Model',
    title: 'Connect a model',
    description: 'Null thinks with a model you choose. You can change it later in Settings.',
  },
  {
    id: ORGANIZATION_STEP,
    icon: 'orgs',
    label: 'Organization',
    title: 'Create your organization',
    description: 'Give your workspace a name. You can change it later.',
  },
  {
    id: WEBSITE_STEP,
    icon: 'website-watch',
    label: 'Website',
    title: 'Add your website',
    description: 'Enter a website you own or are authorized to assess. After ownership verification, its one-time discovery assessment starts automatically.',
  },
  {
    id: AUTHORIZE_STEP,
    icon: 'lock-open',
    label: 'Authorization',
    title: 'Authorize the assessment',
    description: 'One last thing: confirm you are permitted to have this website tested.',
  },
] as const satisfies ReadonlyArray<{ id: number; icon: CellIconName; label: string; title: string; description: string }>;

type VerificationState = 'idle' | 'pending' | 'success' | 'failed';

const ONBOARDING_DRAFT_STORAGE_KEY = 'nullai.onboarding.draft';

type OnboardingDraft = OnboardingProgress & {
  currentStep?: number;
  verificationStatus: VerificationState;
  verificationMessage: string;
  verificationToken: string | null;
};

const INITIAL_FORM_DATA: SetupFormData = {
  orgName: '',
  operationalContext: '',
  scopeName: '',
  mission: '',
  impactTolerance: 'poc',
  complianceFrameworks: [],
  targetType: 'domain',
  targetValue: '',
  domainVerificationMethod: 'dns_txt',
  isTargetVerified: false,
};

const getDraftStorageKey = (userId: string | undefined) =>
  userId ? `${ONBOARDING_DRAFT_STORAGE_KEY}.${userId}` : ONBOARDING_DRAFT_STORAGE_KEY;

export default function SetupWizard() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { setActiveScopeId } = useScope();
  const [currentStep, setCurrentStep] = useState(1);
  const [lastCompletedStep, setLastCompletedStep] = useState(0);
  const [direction, setDirection] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRestoring, setIsRestoring] = useState(true);

  const updateOrganization = useUpdateOrganizationMutation();
  /* Targets returned by the atomic create, so `ensureTarget` can adopt one
     instead of adding a duplicate. A ref rather than state: it is read inside
     the same async flow that sets it, and must not wait for a re-render. */
  const createdTargetsRef = useRef<ScopeTarget[]>([]);
  const createScope = useCreateScopeMutation();
  const updateScope = useUpdateScopeMutation();
  const addTarget = useAddTargetMutation();
  const removeTarget = useRemoveTargetMutation();
  const verifyTarget = useVerifyTargetMutation();
  const { data: organization } = useOrganizationQuery();
  const { data: scopes } = useScopesQuery();
  const { data: modelOverview } = useModelConnectionQuery();
  const hasModel = Boolean(modelOverview?.connection);
  // Read at the first render: the model step cleans `?chatgpt` from the address.
  const [returnedFromChatGpt] = useState(() => searchParams.has('chatgpt'));

  const [scopeId, setScopeId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [targetSnapshot, setTargetSnapshot] = useState('');

  const [verificationStatus, setVerificationStatus] = useState<VerificationState>('idle');
  const [verificationMessage, setVerificationMessage] = useState('');
  const [verificationToken, setVerificationToken] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const pollTimeoutRef = useRef<number | null>(null);

  const [formData, setFormData] = useState<SetupFormData>(INITIAL_FORM_DATA);
  const didRestoreDraftRef = useRef(false);

  const resumableEmptyScope = scopes?.find(
    (scope) => scope.status !== 'archived' && (scope.targetCount ?? 0) === 0,
  );

  const clearPolling = useCallback(() => {
    if (pollTimeoutRef.current) {
      window.clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
    setIsPolling(false);
  }, []);

  useEffect(() => {
    return () => {
      clearPolling();
    };
  }, [clearPolling]);

  useEffect(() => {
    if (didRestoreDraftRef.current) {
      return;
    }
    didRestoreDraftRef.current = true;

    let cancelled = false;

    const parseDraft = (raw: unknown): OnboardingDraft | null => {
      if (!raw || typeof raw !== 'object') return null;
      const candidate = raw as Partial<OnboardingDraft> & {
        formData?: Partial<SetupFormData> & { targetDomain?: string };
      };
      if (!candidate.formData) return null;
      const legacyTargetValue =
        typeof candidate.formData.targetDomain === 'string'
          ? candidate.formData.targetDomain
          : undefined;
      const mergedFormData: SetupFormData = {
        ...INITIAL_FORM_DATA,
        ...candidate.formData,
        targetType: candidate.formData.targetType === 'cidr' ? 'domain' : candidate.formData.targetType ?? 'domain',
        targetValue: candidate.formData.targetValue ?? legacyTargetValue ?? '',
      };
      if (candidate.formData.targetType === 'cidr') {
        mergedFormData.targetValue = '';
        mergedFormData.isTargetVerified = false;
      }
      const inferredCompletedStep =
        typeof candidate.lastCompletedStep === 'number'
          ? candidate.lastCompletedStep
          : typeof candidate.currentStep === 'number'
            ? candidate.currentStep - 1
            : 0;
      return {
        version: 1,
        lastCompletedStep: inferredCompletedStep,
        formData: mergedFormData,
        scopeId: candidate.scopeId ?? null,
        targetId: candidate.targetId ?? null,
        targetSnapshot: candidate.targetSnapshot ?? '',
        updatedAt: candidate.updatedAt ?? '',
        currentStep: candidate.currentStep,
        verificationStatus: candidate.verificationStatus ?? 'idle',
        verificationMessage: candidate.verificationMessage ?? '',
        verificationToken: candidate.verificationToken ?? null,
      };
    };

    const restore = async () => {
      let localDraft: OnboardingDraft | null = null;
      try {
        const userDraft = sessionStorage.getItem(getDraftStorageKey(user?.id));
        const legacyDraft = sessionStorage.getItem(ONBOARDING_DRAFT_STORAGE_KEY);
        localDraft = parseDraft(JSON.parse(userDraft ?? legacyDraft ?? 'null'));
      } catch {
        localDraft = null;
      }

      let serverDraft: OnboardingDraft | null = null;
      const profileResult = await authClient.getProfile();
      if (!profileResult.error) {
        serverDraft = parseDraft(profileResult.data?.preferences?.onboardingProgress ?? null);
      }

      /* The model is the server's, not part of saved progress: ask for it, and
         treat a failed answer as no model, which opens the model step. */
      let modelConnected = false;
      try {
        const overview = await queryClient.fetchQuery({
          queryKey: modelConnectionQueryKey,
          queryFn: fetchModelOverview,
        });
        modelConnected = Boolean(overview.connection);
      } catch {
        modelConnected = false;
      }

      if (cancelled) return;

      const localUpdatedAt = Date.parse(localDraft?.updatedAt ?? '');
      const serverUpdatedAt = Date.parse(serverDraft?.updatedAt ?? '');
      const selectedDraft =
        localDraft && (!serverDraft || (Number.isFinite(localUpdatedAt) && localUpdatedAt >= serverUpdatedAt))
          ? localDraft
          : serverDraft;
      const nextFormData = selectedDraft?.formData ?? INITIAL_FORM_DATA;
      let validatedCompletedStep = 0;
      if (selectedDraft) {
        validatedCompletedStep = getValidatedCompletedStep(selectedDraft);
        setScopeId(validatedCompletedStep >= 2 ? selectedDraft.scopeId : null);
        setTargetId(validatedCompletedStep >= 2 ? selectedDraft.targetId : null);
        setTargetSnapshot(validatedCompletedStep >= 2 ? selectedDraft.targetSnapshot : '');
        setVerificationStatus(selectedDraft.verificationStatus);
        setVerificationMessage(selectedDraft.verificationMessage);
        setVerificationToken(selectedDraft.verificationToken);
      }

      setFormData(nextFormData);
      setLastCompletedStep(validatedCompletedStep);
      setCurrentStep(
        returnedFromChatGpt ? MODEL_STEP : getOnboardingResumeStep(validatedCompletedStep, modelConnected),
      );
      setIsRestoring(false);
    };

    void restore();

    return () => {
      cancelled = true;
    };
  }, [queryClient, returnedFromChatGpt, user?.id]);

  useEffect(() => {
    if (isRestoring || lastCompletedStep > 0) return;
    // Only the operational context is carried over. Pre-filling the name from
    // an existing organization made step one look answered on arrival — the
    // field the wizard exists to ask about already had an answer in it.
    setFormData((previous) => ({
      ...previous,
      operationalContext: previous.operationalContext || organization?.operationalContext || '',
    }));
  }, [isRestoring, lastCompletedStep, organization]);

  const updateData = useCallback((updates: Partial<SetupFormData>) => {
    setFormData((prev) => {
      const next = { ...prev, ...updates };

      if (
        (updates.targetValue !== undefined && updates.targetValue !== prev.targetValue) ||
        (updates.targetType !== undefined && updates.targetType !== prev.targetType)
      ) {
        next.isTargetVerified = false;
        setVerificationStatus('idle');
        setVerificationMessage('');
        setVerificationToken(null);
        // Keep the persisted target identity until ensureTarget runs so an edited
        // target can replace the old record instead of silently creating a duplicate.
        clearPolling();
      } else if (updates.domainVerificationMethod !== undefined && updates.domainVerificationMethod !== prev.domainVerificationMethod) {
        // If only methodology changed, we keep the targetId so we can remove/replace it,
        // but we reset verification status because the new method isn't verified yet.
        next.isTargetVerified = false;
        setVerificationStatus('idle');
        setVerificationMessage('');
        // We keep verificationToken and targetId so ensureTarget can clean them up correctly
        clearPolling();
      }

      return next;
    });
  }, [clearPolling]);

  const normalizeTargetValue = (type: SetupFormData['targetType'], value: string) => {
    const trimmedValue = value.trim().toLowerCase();
    if (type !== 'domain' || !trimmedValue) return trimmedValue;

    try {
      const parsed = new URL(
        trimmedValue.includes('://') ? trimmedValue : `https://${trimmedValue}`,
      );
      return parsed.hostname.replace(/\.$/, '');
    } catch {
      return trimmedValue.replace(/\.$/, '');
    }
  };

  const getEffectiveTargetInput = () => {
    return {
      targetType: formData.targetType,
      targetValue: normalizeTargetValue(formData.targetType, formData.targetValue),
    };
  };

  const getDefaultScopeName = () => {
    const explicitName = formData.scopeName.trim();
    if (explicitName) return explicitName;
    const target = getEffectiveTargetInput().targetValue;
    if (target) return `${target} Website`;
    return `${formData.orgName.trim()} Website`;
  };

  const resolveTargetVerificationMethod = (data: SetupFormData) => data.domainVerificationMethod;

  const buildTargetSnapshot = (data: SetupFormData) => {
    const normalizedTargetValue = normalizeTargetValue(data.targetType, data.targetValue);
    return `${data.targetType}:${normalizedTargetValue}:${resolveTargetVerificationMethod(data)}`;
  };

  const ensureScope = async (): Promise<string> => {
    const scopeName = getDefaultScopeName();
    const engagementBrief = {
      mission: toNullableText(formData.mission),
      impactTolerance: formData.impactTolerance,
      complianceFrameworks: formData.complianceFrameworks,
    };

    let nextScopeId = scopeId ?? resumableEmptyScope?.id ?? null;
    if (!nextScopeId) {
      /* Scope and target in one request. Creating the scope and then adding the
         target as a second call is what made `resumableEmptyScope` necessary: a
         failure between them left a scope with no target at all. */
      const initialTarget = getEffectiveTargetInput();
      const created = await createScope.mutateAsync({
        name: scopeName,
        ...engagementBrief,
        ...(initialTarget.targetValue
          ? {
              targets: [{
                type: initialTarget.targetType,
                value: initialTarget.targetValue,
                verificationMethod: resolveTargetVerificationMethod(formData),
              }],
            }
          : {}),
      });
      nextScopeId = created.id;
      createdTargetsRef.current = created.targets ?? [];
      setScopeId(created.id);
    } else {
      if (!scopeId) {
        setScopeId(nextScopeId);
      }
      await updateScope.mutateAsync({
        id: nextScopeId,
        name: scopeName,
        ...engagementBrief,
      });
    }

    return nextScopeId;
  };

  const ensureTarget = async (
    currentScopeId: string,
  ): Promise<{ scopeId: string; targetId: string }> => {
    const effectiveTarget = getEffectiveTargetInput();
    const normalizedTargetValue = effectiveTarget.targetValue;
    if (!normalizedTargetValue) {
      throw new Error('Target value is required.');
    }

    const nextTargetSnapshot = buildTargetSnapshot(formData);
    const verificationMethod = resolveTargetVerificationMethod(formData);
    let nextTargetId = targetId;
    if (nextTargetId && targetSnapshot && targetSnapshot !== nextTargetSnapshot) {
      await removeTarget.mutateAsync({ scopeId: currentScopeId, targetId: nextTargetId });
      nextTargetId = null;
      setTargetId(null);
    }

    if (!nextTargetId) {
      /* The atomic create may already have made this target. Adopt it rather
         than asking the API to add a duplicate. */
      const alreadyCreated = createdTargetsRef.current.find(
        (candidate) => candidate.value.toLowerCase() === normalizedTargetValue.toLowerCase(),
      );
      if (alreadyCreated) {
        setTargetId(alreadyCreated.id);
        setVerificationToken(alreadyCreated.verificationToken ?? null);
        setTargetSnapshot(nextTargetSnapshot);
        return { scopeId: currentScopeId, targetId: alreadyCreated.id };
      }

      const createdTarget = await addTarget.mutateAsync({
        scopeId: currentScopeId,
        type: effectiveTarget.targetType,
        value: normalizedTargetValue,
        verificationMethod,
      });
      nextTargetId = createdTarget.id;
      setTargetId(createdTarget.id);
      setVerificationToken(createdTarget.verificationToken ?? null);
      setTargetSnapshot(nextTargetSnapshot);
    }

    return { scopeId: currentScopeId, targetId: nextTargetId };
  };

  const ensureScopeAndTarget = async (): Promise<{ scopeId: string; targetId: string }> => {
    const nextScopeId = await ensureScope();
    return ensureTarget(nextScopeId);
  };

  const persistCheckpoint = async (
    completedStep: number,
    ids?: { scopeId: string; targetId: string },
  ): Promise<void> => {
    const nextCompletedStep = Math.max(lastCompletedStep, completedStep);
    const effectiveTarget = getEffectiveTargetInput();
    const checkpointFormData: SetupFormData = completedStep >= 2
      ? {
          ...formData,
          scopeName: getDefaultScopeName(),
          targetType: effectiveTarget.targetType,
          targetValue: effectiveTarget.targetValue,
        }
      : formData;
    const checkpointTargetSnapshot = ids
      ? buildTargetSnapshot(checkpointFormData)
      : targetSnapshot;
    const progress: OnboardingProgress = {
      version: 1,
      lastCompletedStep: nextCompletedStep,
      formData: checkpointFormData,
      scopeId: ids?.scopeId ?? scopeId,
      targetId: ids?.targetId ?? targetId,
      targetSnapshot: checkpointTargetSnapshot,
      updatedAt: new Date().toISOString(),
    };
    const validatedCompletedStep = getValidatedCompletedStep(progress);
    if (validatedCompletedStep < completedStep) {
      throw new Error('This onboarding step is incomplete. Review the required details and try again.');
    }
    progress.lastCompletedStep = validatedCompletedStep;

    const result = await authClient.updateProfile({
      preferences: {
        onboardingProgress: progress,
      },
    });
    if (result.error) {
      throw new Error(result.error.message || 'Unable to save onboarding progress.');
    }

    setLastCompletedStep(validatedCompletedStep);
    if (
      completedStep >= 2 &&
      (
        formData.scopeName !== checkpointFormData.scopeName ||
        formData.targetType !== checkpointFormData.targetType ||
        formData.targetValue !== checkpointFormData.targetValue
      )
    ) {
      setFormData(checkpointFormData);
    }
    if (ids) setTargetSnapshot(checkpointTargetSnapshot);
    try {
      const localDraft: OnboardingDraft = {
        ...progress,
        verificationStatus,
        verificationMessage,
        verificationToken,
      };
      sessionStorage.setItem(getDraftStorageKey(user?.id), JSON.stringify(localDraft));
      sessionStorage.removeItem(ONBOARDING_DRAFT_STORAGE_KEY);
    } catch {
      // Server-side progress remains authoritative when browser storage is unavailable.
    }
  };

  const pollVerification = async (ids: { scopeId: string; targetId: string }, attempt = 0): Promise<void> => {
    if (attempt >= 12) {
      setIsPolling(false);
      return;
    }

    pollTimeoutRef.current = window.setTimeout(async () => {
      try {
        const result = await verifyTarget.mutateAsync(ids);
        setVerificationMessage(result.message);

        if (result.verified) {
          setVerificationStatus('success');
          updateData({ isTargetVerified: true });
          clearPolling();
          return;
        }

        setVerificationStatus('pending');
      } catch (error) {
        const apiError = toApiError(error);
        setVerificationMessage(apiError.message || 'DNS verification check failed.');
      }

      void pollVerification(ids, attempt + 1);
    }, 10000);
  };

  const handleVerifyTarget = async () => {
    if (isVerifying || formData.targetType !== 'domain') return;

    setIsVerifying(true);
    setVerificationStatus('idle');
    setVerificationMessage(
      formData.domainVerificationMethod === 'http_well_known'
        ? 'Checking verification file...'
        : 'Checking DNS TXT record...',
    );

    try {
      const ids = await ensureScopeAndTarget();
      await persistCheckpoint(2, ids);
      const result = await verifyTarget.mutateAsync(ids);
      setVerificationMessage(result.message);

      if (result.verified) {
        setVerificationStatus('success');
        updateData({ isTargetVerified: true });
        clearPolling();
      } else {
        setVerificationStatus('pending');
        updateData({ isTargetVerified: false });
        clearPolling();
        setIsPolling(true);
        void pollVerification(ids);
      }
    } catch (error) {
      const apiError = toApiError(error);
      setVerificationStatus('failed');
      setVerificationMessage(apiError.message || 'Unable to verify target.');
      updateData({ isTargetVerified: false });
    } finally {
      setIsVerifying(false);
    }
  };

  const completeSetup = async () => {
    setIsSubmitting(true);

    try {
      const ids = await ensureScopeAndTarget();
      /* The statement, recorded against the scope the customer has been looking
         at. The verification step may already have created that scope, so this
         is a write of its own rather than something folded into the create —
         proving you control a domain and warranting that you may test it are
         two different claims, made on two different screens. */
      await updateScope.mutateAsync({
        id: ids.scopeId,
        authorization: { accepted: true as const },
      });
      await persistCheckpoint(2, ids);

      const effectiveTarget = getEffectiveTargetInput();
      const completionFormData: SetupFormData = {
        ...formData,
        scopeName: getDefaultScopeName(),
        targetType: effectiveTarget.targetType,
        targetValue: effectiveTarget.targetValue,
      };
      const completionTargetSnapshot = buildTargetSnapshot(completionFormData);
      const completionResult = await authClient.updateProfile({
        preferences: {
          onboardingCompletedAt: new Date().toISOString(),
          onboardingProgress: {
            version: 1,
            lastCompletedStep: 2,
            formData: completionFormData,
            scopeId: ids.scopeId,
            targetId: ids.targetId,
            targetSnapshot: completionTargetSnapshot,
            updatedAt: new Date().toISOString(),
          },
        },
      });
      if (completionResult.error) {
        throw new Error(completionResult.error.message || 'Unable to finalize onboarding.');
      }
      setActiveScopeId(ids.scopeId);
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ['scopes'] }),
        queryClient.invalidateQueries({ queryKey: ['scope'] }),
      ]);
      try {
        sessionStorage.removeItem(getDraftStorageKey(user?.id));
        sessionStorage.removeItem(ONBOARDING_DRAFT_STORAGE_KEY);
      } catch {
        // Ignore storage failures during completion cleanup.
      }
      toastService.success(
        'Setup complete',
        completionFormData.isTargetVerified
          ? 'Your verified website is ready.'
          : 'Your website was added. You can verify it later from your dashboard.',
      );
      navigate('/');
    } catch (error) {
      const apiError = toApiError(error);
      toastService.error('Could not authorize', apiError.message || 'Unable to complete setup.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const nextStep = async () => {
    if (currentStep === MODEL_STEP) {
      if (!hasModel) return;
      setDirection(1);
      setCurrentStep(getStepAfterModel(lastCompletedStep));
      return;
    }

    if (currentStep === ORGANIZATION_STEP) {
      if (!formData.orgName.trim()) {
        toastService.error('Missing details', 'Please add your organization name before continuing.');
        return;
      }

      try {
        // Establish the server-side onboarding checkpoint before using the
        // narrow inactive-account organization mutation allowance.
        await persistCheckpoint(0);
        await updateOrganization.mutateAsync({
          name: formData.orgName.trim(),
          operationalContext: null,
        });
        await persistCheckpoint(1);
      } catch (error) {
        const apiError = toApiError(error);
        toastService.error('Failed to save', apiError.message || 'Could not update organization profile.');
        return;
      }

      setDirection(1);
      setCurrentStep(WEBSITE_STEP);
      return;
    }

    if (currentStep === WEBSITE_STEP) {
      if (formData.targetValue.trim().length <= 3) {
        toastService.error('Missing details', 'Add the website you want assessed before continuing.');
        return;
      }
      setDirection(1);
      setCurrentStep(AUTHORIZE_STEP);
      return;
    }

    await completeSetup();
  };

  const prevStep = () => {
    if (currentStep > MODEL_STEP) {
      setDirection(-1);
      setCurrentStep((prev) => prev - 1);
    }
  };

  const isStepValid = () => {
    switch (currentStep) {
      case MODEL_STEP:
        return hasModel;
      case ORGANIZATION_STEP:
        return formData.orgName.trim().length > 2;
      case WEBSITE_STEP:
      case AUTHORIZE_STEP:
        return formData.targetValue.trim().length > 3;
      default:
        return false;
    }
  };

  const renderCurrentStep = () => {
    switch (currentStep) {
      case MODEL_STEP:
        return <StepModel />;
      case ORGANIZATION_STEP:
        return <Step1Organization data={formData} updateData={updateData} />;
      case WEBSITE_STEP:
        return (
          <Step2Target
            data={formData}
            updateData={updateData}
            verificationStatus={verificationStatus}
            verificationMessage={verificationMessage}
            verificationToken={verificationToken}
            isVerifying={isVerifying}
            isPolling={isPolling}
            onVerify={handleVerifyTarget}
          />
        );
      case AUTHORIZE_STEP:
        return (
          <Step3Authorize
            data={formData}
            organizationName={formData.orgName.trim() || organization?.name || ''}
          />
        );
      default:
        return null;
    }
  };

  const activeStep = STEPS.find((step) => step.id === currentStep) ?? STEPS[0];
  const displayedStep = currentStep;
  const displayedStepCount = STEPS.length;
  /* On the last step the button *is* the statement, so its label says exactly
     what pressing it means. Once pressed it becomes the way out of the wizard. */
  const primaryActionLabel = (() => {
    if (currentStep !== STEPS.length) return 'Continue';
    if (isSubmitting) return 'Authorizing...';
    return 'I authorize';
  })();
  const isPrimaryActionDisabled = !isStepValid() || isSubmitting || (currentStep === WEBSITE_STEP && isVerifying);

  if (isRestoring) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-3 bg-background text-sm text-muted-foreground">
        <span className="ns-live-mark" aria-hidden />
        Restoring your setup
      </div>
    );
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-background font-sans text-foreground selection:bg-primary selection:text-primary-foreground">
      <div className="absolute inset-0 z-0">
        <div className="absolute inset-0 bg-grid-white/[0.02]" />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent" />
      </div>

      <div className="relative z-10 flex min-h-screen flex-col">
        <header className="px-5 py-5 md:px-8">
          <div className="mx-auto grid w-full max-w-6xl grid-cols-[1fr_auto_1fr] items-center gap-4">
            {/* Keeps the step dots centred where the way out used to sit. */}
            <div />

            <div className="justify-self-center">
              <div className="flex items-center gap-1.5" aria-label={`Step ${displayedStep} of ${displayedStepCount}`}>
                {Array.from({ length: displayedStepCount }, (_, index) => index + 1).map((step) => {
                  const isActive = step === displayedStep;
                  const isCompleted = step < displayedStep;

                  return (
                    <span
                      key={step}
                      className={cn(
                        'block h-1 transition-all ',
                        isActive ? 'w-8 bg-primary' : 'w-1.5 bg-border',
                        isCompleted && 'bg-primary/40',
                      )}
                    />
                  );
                })}
              </div>
            </div>

            <div className="justify-self-end text-sm text-muted-foreground/60">
              {displayedStep} / {displayedStepCount}
            </div>
          </div>
        </header>

        <main className="flex flex-1 items-center justify-center px-6 pb-16 pt-2 md:px-8 md:pb-20">
          <div className="w-full max-w-4xl">
            <AnimatePresence mode="wait" custom={direction}>
              <motion.section
                key={currentStep}
                custom={direction}
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -18 }}
                transition={{ duration: 0.24, ease: 'easeOut' }}
                className="mx-auto flex w-full max-w-2xl flex-col items-center text-center"
              >
                <CellIcon name={activeStep.icon} size={56} className="text-foreground/45" />
                <p className="mt-7 font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-primary">
                  {activeStep.label}
                </p>
                <h1 className={cn(
                  'mt-4 text-3xl font-bold uppercase tracking-tight text-foreground md:text-5xl',
                )}>
                  {activeStep.title}
                </h1>
                <p className="mt-5 max-w-xl text-sm leading-7 text-muted-foreground md:text-base font-sans">
                  {activeStep.description}
                </p>

                <div className="mt-10 w-full">
                  {renderCurrentStep()}
                </div>

                <div className="mt-10 flex flex-col items-center gap-4">
                  <Button
                    variant="primary"
                    onClick={() => { void nextStep(); }}
                    disabled={isPrimaryActionDisabled}
                    className={cn(
                      'h-11 min-w-[160px] font-mono uppercase text-[10px] font-bold tracking-widest',
                      isPrimaryActionDisabled && 'opacity-50'
                    )}
                  >
                    {primaryActionLabel}
                    {currentStep !== STEPS.length ? <ChevronRight className="h-3.5 w-3.5 ml-2" /> : null}
                  </Button>

                  <Button
                    variant="ghost"
                    onClick={prevStep}
                    disabled={currentStep === MODEL_STEP}
                    className={cn(
                      'h-auto border-0 px-0 py-0 text-sm text-muted-foreground/60 hover:bg-transparent hover:text-primary',
                      currentStep === MODEL_STEP && 'pointer-events-none opacity-0',
                    )}
                  >
                    <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                    Back
                  </Button>
                </div>
              </motion.section>
            </AnimatePresence>
          </div>
        </main>
      </div>
    </div>
  );
}
