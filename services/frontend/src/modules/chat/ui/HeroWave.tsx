/* eslint-disable @typescript-eslint/no-explicit-any */
// features/ai-chat/components/HeroWave.tsx
import React, { useEffect, useRef, useState, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import gsap from "gsap";
import {
  WorkingOverlay,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  Textarea,
} from '@null-ai/design-tokens/ui';
import { ArrowUpRight } from 'lucide-react';
import { useTheme } from "@shared/contexts/ThemeContext";
import { toApiError } from '@/shared/lib/apiError';
import { useContextualRunActions } from '@modules/security-ops/hooks/useContextualRunActions';
import {
  useComplianceReadinessQuery,
  useCreateRunMutation,
  useRunsQuery,
  useStartCodeReviewMutation,
  useStartComplianceAssessmentMutation,
} from '@modules/security-ops/api';
import { codeSourceName, describeCodeSource } from '@modules/security-ops/lib/codeSource';
import type { ComplianceFrameworkKey, ExecutionTarget, Run, RunWorkflowDiscipline } from '@modules/security-ops/types';
import { COMPLIANCE_FRAMEWORK_SHORT_LABELS } from '@modules/security-ops/complianceFrameworks';
import { buildQuickSuggestions, type QuickSuggestion } from '@modules/security-ops/lib/quickSuggestions';
import { toastService } from '@shared/services/toastService';
import { getModelEffortLabel, type AvailableModel, useAvailableModelsQuery } from '@modules/sessions/api';
import { cn } from '@shared/lib/utils';
import { ExecutionTargetSelector } from '@shared/ui/ExecutionTargetSelector';
import { useAppPaths } from '@shared/contexts/AppPathContext';

// Theme-aware color configuration for the wave animation
const themeColors = {
  dark: {
    barHue: 51,        // Yellow hue
    barSaturation: 100,
    barLightness: 50,
    sectionBg: 'bg-background',
    textPrimary: 'text-foreground',
    textSecondary: 'text-muted-foreground/90',
    inputBg: 'bg-surface-inset/55',
    inputBorder: 'border-border/10',
    inputText: 'text-foreground',
    inputPlaceholder: 'placeholder:text-muted-foreground/40',
    inputFocusRing: 'focus:ring-primary/40 focus:border-primary/40',
    buttonBg: 'bg-primary',
    buttonText: 'text-primary-foreground',
    cardBg: 'bg-card/60',
    cardBorder: 'border-primary/40',
  },
  light: {
    barHue: 0,         // Black (achromatic)
    barSaturation: 0,
    barLightness: 15,  // Dark gray/black
    sectionBg: 'bg-background',
    textPrimary: 'text-foreground',
    textSecondary: 'text-muted-foreground',
    inputBg: 'bg-background',
    inputBorder: 'border-border',
    inputText: 'text-foreground',
    inputPlaceholder: 'placeholder:text-muted-foreground',
    inputFocusRing: 'focus:ring-primary/50 focus:border-primary',
    buttonBg: 'bg-primary',
    buttonText: 'text-primary-foreground',
    cardBg: 'bg-card/90',
    cardBorder: 'border-primary',
  }
};

export type HeroWaveProps = {
  className?: string;
  style?: React.CSSProperties;
  extendLeftPx?: number; // how far to extend bars past the left edge
  title?: string;
  subtitle?: string;
  placeholder?: string;
  buttonText?: string;
  motionPreset?: 'default' | 'calm';
};

type WaveKeyframe = {
  time: number;
  gain: number;
  frequency: number;
  waveLength: number;
};

const BASE_WAVE_KEYFRAMES_1: WaveKeyframe[] = [
  { time: 0, gain: 10, frequency: 0, waveLength: 0.5 },
  { time: 4, gain: 300, frequency: 1, waveLength: 0.5 },
  { time: 6, gain: 300, frequency: 4, waveLength: Math.PI * 1.5 },
  { time: 8, gain: 225, frequency: 4, waveLength: Math.PI * 1.5 },
  { time: 10, gain: 500, frequency: 1, waveLength: Math.PI * 1.5 },
  { time: 14, gain: 225, frequency: 3, waveLength: Math.PI * 1.5 },
  { time: 22, gain: 100, frequency: 6, waveLength: Math.PI * 1.5 },
  { time: 28, gain: 0, frequency: 0.9, waveLength: 0.5 },
  { time: 30, gain: 128, frequency: 0.9, waveLength: 0.5 },
  { time: 32, gain: 190, frequency: 1.42, waveLength: 0.5 },
  { time: 39, gain: 499, frequency: 4.0, waveLength: Math.PI * 1.5 },
  { time: 40, gain: 500, frequency: 4.0, waveLength: Math.PI * 1.5 },
  { time: 42, gain: 400, frequency: 2.82, waveLength: Math.PI * 1.5 },
  { time: 44, gain: 327, frequency: 2.56, waveLength: Math.PI * 1.5 },
  { time: 48, gain: 188, frequency: 5.4, waveLength: 0.5 },
  { time: 52, gain: 32, frequency: 0.1, waveLength: 0.5 },
  { time: 55, gain: 10, frequency: 0, waveLength: 0.5 },
];

const BASE_WAVE_KEYFRAMES_2: WaveKeyframe[] = [
  { time: 0, gain: 0, frequency: 0, waveLength: 0.5 },
  { time: 9, gain: 0, frequency: 0, waveLength: 0.5 },
  { time: 10, gain: 400, frequency: 1, waveLength: 0.5 },
  { time: 13, gain: 300, frequency: 4, waveLength: Math.PI * 1.5 },
  { time: 24, gain: 96, frequency: 2, waveLength: 0.5 },
  { time: 28, gain: 0, frequency: 0.9, waveLength: 0.5 },
  { time: 30, gain: 142, frequency: 0.9, waveLength: 0.5 },
  { time: 36, gain: 374, frequency: 4.0, waveLength: Math.PI * 1.5 },
  { time: 38, gain: 375, frequency: 4.0, waveLength: Math.PI * 1.5 },
  { time: 40, gain: 300, frequency: 2.26, waveLength: Math.PI * 1.5 },
  { time: 44, gain: 245, frequency: 2.05, waveLength: Math.PI * 1.5 },
  { time: 48, gain: 141, frequency: 5.12, waveLength: 0.5 },
  { time: 52, gain: 24, frequency: 0.08, waveLength: 0.5 },
  { time: 52, gain: 8, frequency: 0, waveLength: 0.5 },
];

const HERO_WAVE_MOTION_PRESETS = {
  default: {
    gainScale: 1,
    frequencyScale: 1,
    timeScale: 1,
    screenCoverage: 0.6,
    speedScale: 0.52,
    mouseSmoothing: 30,
    glowMax: 40,
    accumEase: 1.5,
    speedEase: 8.5,
    bloomStrength: 1.0,
    bloomRadius: 0.68,
    darkGrainIntensity: 0.9,
    lightGrainIntensity: 0.3,
    darkGrainScale: 0.3,
    lightGrainScale: 0.2,
    resizeGrainScale: 0.5,
    darkAlpha: 0.35,
    baseEmissive: 0.05,
  },
  calm: {
    gainScale: 0.82,
    frequencyScale: 0.82,
    timeScale: 1.28,
    screenCoverage: 0.52,
    speedScale: 0.34,
    mouseSmoothing: 22,
    glowMax: 32,
    accumEase: 1.5,
    speedEase: 5.6,
    bloomStrength: 1.0,
    bloomRadius: 0.68,
    darkGrainIntensity: 0.9,
    lightGrainIntensity: 0.3,
    darkGrainScale: 0.3,
    lightGrainScale: 0.2,
    resizeGrainScale: 0.5,
    darkAlpha: 0.35,
    baseEmissive: 0.05,
  },
} as const;

function scaleWaveKeyframes(
  keyframes: WaveKeyframe[],
  motion: (typeof HERO_WAVE_MOTION_PRESETS)[keyof typeof HERO_WAVE_MOTION_PRESETS],
): WaveKeyframe[] {
  return keyframes.map((keyframe) => ({
    ...keyframe,
    time: keyframe.time * motion.timeScale,
    gain: keyframe.gain * motion.gainScale,
    frequency: keyframe.frequency * motion.frequencyScale,
  }));
}

type HeroModelSelectProps = {
  availableModels: AvailableModel[];
  selectedModel?: AvailableModel;
  value?: string;
  disabled?: boolean;
  isDark: boolean;
  isLoading: boolean;
  onValueChange: (value?: string) => void;
};

const HeroModelSelect: React.FC<HeroModelSelectProps> = ({
  availableModels,
  selectedModel,
  value,
  disabled,
  isDark,
  isLoading,
  onValueChange,
}) => {
  const triggerClasses = isDark
    ? 'text-foreground/78 hover:text-foreground data-[state=open]:text-foreground'
    : 'text-foreground/78 hover:text-foreground data-[state=open]:text-foreground';
  const subtleTextClass = isDark ? 'text-foreground/55' : 'text-foreground/55';
  const contentClasses = isDark
    ? 'border-border/10 bg-background text-foreground'
    : 'border-border/10 bg-background text-foreground';

  if (isLoading) {
    return (
      <div className={cn('flex items-center gap-2 text-sm', subtleTextClass)}>
        <span className="ns-live-mark" aria-hidden />
        <span>Loading categories...</span>
      </div>
    );
  }

  if (availableModels.length === 0) {
    return <div className={cn('text-sm', subtleTextClass)}>Default intelligence</div>;
  }

  return (
    <Select value={value ?? ''} onValueChange={(nextValue) => onValueChange(nextValue || undefined)} disabled={disabled}>
      <SelectTrigger
        data-testid="chat-hero-model-select"
        className={cn(
          'h-auto min-h-0 w-auto rounded-none border-0 bg-transparent px-0 py-0 text-sm font-medium shadow-none outline-none transition-colors focus:ring-0 focus:ring-offset-0',
          triggerClasses,
        )}
      >
        <span className="truncate">{selectedModel ? getModelEffortLabel(selectedModel) : 'Select intelligence'}</span>
      </SelectTrigger>
      <SelectContent className={cn('z-[120] rounded-none border p-1 ', contentClasses)}>
        <SelectGroup>
          <SelectLabel className={cn('px-3 pb-1 pt-2 text-sm font-normal', subtleTextClass)}>
            Intelligence
          </SelectLabel>
          {availableModels.map((model) => (
            <SelectItem
              key={model.id}
              value={model.id}
              className={cn(
                'rounded-none py-2 pl-8 pr-3 text-left text-sm outline-none',
                isDark ? 'focus:bg-primary/10 focus:text-foreground' : 'focus:bg-primary/5 focus:text-foreground',
              )}
            >
              <span className="truncate font-medium">{getModelEffortLabel(model)}</span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
};

const ACTIVE_RUN_STATUSES = new Set(['running', 'queued']);
const COMPOSER_OWNED_SUGGESTION_IDS = new Set(['start_first_assessment', 'start_discovery_session', 'default_next_step']);

const inferRunWorkflowDiscipline = (run: Run): RunWorkflowDiscipline => {
  if (run.workflowDiscipline === 'compliance' || run.workflowDiscipline === 'pentest') {
    return run.workflowDiscipline;
  }
  const searchable = [
    run.title,
    run.goal,
    Array.isArray((run as { assignedSkillSlugs?: unknown }).assignedSkillSlugs)
      ? ((run as { assignedSkillSlugs?: string[] }).assignedSkillSlugs ?? []).join(' ')
      : '',
  ].filter(Boolean).join(' ').toLowerCase();
  return searchable.includes('compliance') || searchable.includes('soc 2') || searchable.includes('soc2')
    ? 'compliance'
    : 'pentest';
};

const selectCurrentOperationalRun = (
  runs: Run[] | undefined,
  scopeId?: string | null,
  workflowDiscipline: RunWorkflowDiscipline = 'pentest',
): Run | null => {
  const scopedRuns = (runs ?? []).filter((run) => !scopeId || run.scopeId === scopeId);
  return [...scopedRuns]
    .filter((run) => ACTIVE_RUN_STATUSES.has((run.status ?? '').toLowerCase()))
    .filter((run) => inferRunWorkflowDiscipline(run) === workflowDiscipline)
    .sort((left, right) => {
      const rightTs = Date.parse(right.startedAt ?? right.createdAt ?? '') || 0;
      const leftTs = Date.parse(left.startedAt ?? left.createdAt ?? '') || 0;
      return rightTs - leftTs;
    })[0] ?? null;
};

const promptFromSuggestion = (suggestion?: QuickSuggestion | null): string => {
  if (!suggestion?.to.includes('?')) return '';
  return new URLSearchParams(suggestion.to.slice(suggestion.to.indexOf('?') + 1)).get('prompt')?.trim() ?? '';
};

export const HeroWave: React.FC<HeroWaveProps> = ({
  className,
  style,
  extendLeftPx = 320,
  title = "Build with AI.",
  subtitle = "The AI Fullstack Engineer. Build prototypes, apps, and websites",
  placeholder = "Describe what you want to create...",
  buttonText = "Generate",
  motionPreset = 'default',
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const paths = useAppPaths();
  const { theme } = useTheme();
  const colors = useMemo(() => themeColors[theme] || themeColors.dark, [theme]);
  const isDark = theme === 'dark';
  const motion = HERO_WAVE_MOTION_PRESETS[motionPreset];
  const prefersReducedMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );
  const [prompt, setPrompt] = useState("");
  const [agentStartMode, setAgentStartMode] = useState<'recommended' | 'manual'>('recommended');
  const [inputMode, setInputMode] = useState<'pentest' | 'compliance' | 'code_review' | 'chat'>(() =>
    location.pathname === '/chat' ? 'chat' : 'pentest',
  );
  const [selectedComplianceFramework, setSelectedComplianceFramework] = useState<ComplianceFrameworkKey | undefined>('soc2');
  const [selectedModelCategory, setSelectedModelCategory] = useState<string | undefined>(undefined);
  const [executionTarget, setExecutionTarget] = useState<ExecutionTarget>('cloud');
  const isChatMode = inputMode === 'chat';
  const isComplianceMode = inputMode === 'compliance';
  const isCodeReviewMode = inputMode === 'code_review';
  const {
    hasScope: hasActiveScope,
    scope: activeScope,
    targetCount,
    verifiedTargetCount,
    targetVerificationState,
    targetVerificationMessage,
    assetsCount,
    openRisksCount,
    resolvedRisksCount,
    criticalCount,
    highCount,
    activeAutomationsCount,
    runnersTotal,
    runnersOnline,
    loadingSignals,
    // Enabled in every mode: chat is gated on target ownership too, so the
    // verification signals must be loaded even when the agent panels are not.
  } = useContextualRunActions(undefined, { enabled: true });

  const createRunMutation = useCreateRunMutation();
  const startComplianceAssessment = useStartComplianceAssessmentMutation();
  const startCodeReview = useStartCodeReviewMutation();
  /* Code Review reads the scope's code source: one folder or one git URL, set
     on the scope page. The scope list carries it, so it is read from there. */
  const codeSource = activeScope?.codeSource ?? null;
  const needsCodeSource = isCodeReviewMode && Boolean(activeScope?.id) && !targetVerificationMessage && !codeSource;
  const { data: complianceReadiness } = useComplianceReadinessQuery(activeScope?.id, {
    enabled: isComplianceMode && Boolean(activeScope?.id),
  });
  const { data: runs } = useRunsQuery(undefined, { enabled: !isChatMode });
  const { data: scopedRuns } = useRunsQuery(
    activeScope?.id ? { scopeId: activeScope.id } : undefined,
    { enabled: !isChatMode && !!activeScope?.id },
  );
  const { data: availableModels = [], isLoading: isModelsLoading } = useAvailableModelsQuery();
  const allQuickSuggestions = useMemo(
    () =>
      buildQuickSuggestions(
        {
          scopeId: activeScope?.id ?? null,
          hasScope: hasActiveScope,
          targetCount,
          verifiedTargetCount,
          assetsCount,
          openRisksCount,
          resolvedRisksCount,
          criticalCount,
          highCount,
          activeAutomationsCount,
          runnersTotal,
          runnersOnline,
          activeRunsCount: runs?.filter(r => r.status === 'running' || r.status === 'queued').length ?? 0,
        },
        6,
      ),
    [
      activeAutomationsCount,
      activeScope?.id,
      assetsCount,
      criticalCount,
      hasActiveScope,
      highCount,
      openRisksCount,
      resolvedRisksCount,
      runs,
      runnersOnline,
      runnersTotal,
      targetCount,
      verifiedTargetCount,
    ],
  );
  const launchSuggestion = useMemo(
    () => allQuickSuggestions.find((suggestion) => suggestion.id === 'start_first_assessment' || suggestion.id === 'start_discovery_session') ?? null,
    [allQuickSuggestions],
  );
  const quickSuggestions = useMemo(
    () => allQuickSuggestions.filter((suggestion) => !COMPOSER_OWNED_SUGGESTION_IDS.has(suggestion.id)).slice(0, 3),
    [allQuickSuggestions],
  );
  const visibleQuickSuggestions = useMemo(
    () => (!isChatMode && targetVerificationState === 'verified' ? quickSuggestions : []),
    [isChatMode, quickSuggestions, targetVerificationState],
  );
  const currentOperationalRun = useMemo(
    () => isCodeReviewMode
      ? undefined
      : selectCurrentOperationalRun(
          scopedRuns ?? runs,
          activeScope?.id,
          inputMode === 'compliance' ? 'compliance' : 'pentest',
        ),
    [activeScope?.id, inputMode, isCodeReviewMode, runs, scopedRuns],
  );
  const complianceFrameworkOptions = useMemo(
    () =>
      (complianceReadiness?.frameworks ?? [])
        .filter((framework) => framework.selected && framework.supported)
        .map((framework) => ({
          key: framework.key,
          label: COMPLIANCE_FRAMEWORK_SHORT_LABELS[framework.key] ?? framework.label,
          monitoredControls: framework.controls.filter((control) => control.monitoring.state === 'monitored').length,
        })),
    [complianceReadiness?.frameworks],
  );
  const activeComplianceFramework =
    complianceFrameworkOptions.find((framework) => framework.key === selectedComplianceFramework) ??
    complianceFrameworkOptions[0] ??
    null;
  const complianceStartBlockReason = isComplianceMode
    ? !activeComplianceFramework
      ? 'Select a compliance framework in organization settings before starting a compliance run.'
      : activeComplianceFramework.monitoredControls === 0
        ? `No monitored ${activeComplianceFramework.label} controls are available for this scope.`
        : null
    : null;
  const codeReviewStartBlockReason = isCodeReviewMode
    ? !activeScope?.id
      ? 'Select a scope before starting Code Review.'
      : targetVerificationMessage
        ? targetVerificationMessage
        : !codeSource
          ? 'Add code on the scope page first.'
          : codeSource.status === 'cloning'
            ? `${codeSourceName(codeSource)} is still being cloned. Code Review can start once it is ready.`
            : codeSource.status === 'failed'
              ? codeSource.error ?? `${codeSourceName(codeSource)} could not be read. Check it on the scope page.`
              : null
    : null;

  useEffect(() => {
    if (!isComplianceMode || complianceFrameworkOptions.length === 0) return;
    if (!activeComplianceFramework) {
      setSelectedComplianceFramework(complianceFrameworkOptions[0]?.key);
    }
  }, [activeComplianceFramework, complianceFrameworkOptions, isComplianceMode]);

  const operationalInsightCards = useMemo(() => {
    const cards = [...visibleQuickSuggestions];

    if (currentOperationalRun) {
        cards.unshift({
          id: 'review_current_assessment',
        title: 'Review Active Assessment',
        description: 'Open the live workbench to review the current agent transcript, terminal output, and plan.',
        cta: 'Open Workbench',
        to: paths.runWorkbench(currentOperationalRun.id),
        priority: Number.MAX_SAFE_INTEGER,
      });
    }

    return cards.slice(0, 3);
  }, [currentOperationalRun, paths, visibleQuickSuggestions]);
  const showScopeGuidancePanel = inputMode === 'pentest' && visibleQuickSuggestions.length > 0;
  const scopeSnapshotSummary = loadingSignals
    ? 'Loading scope signals...'
    : targetVerificationState === 'missing'
      ? `No target configured | ${assetsCount} assets | ${openRisksCount} open risks`
      : targetVerificationState === 'pending'
        ? `Target pending verification | ${assetsCount} assets | ${openRisksCount} open risks`
        : `Verified target ready | ${assetsCount} assets | ${openRisksCount} open risks`;
  const recommendedLaunch = useMemo(() => {
    const suggestionPrompt = promptFromSuggestion(launchSuggestion);
    if (launchSuggestion && suggestionPrompt) {
      return {
        title: launchSuggestion.id === 'start_discovery_session' ? 'Map The Attack Surface' : 'Start The Next Assessment',
        description: launchSuggestion.description,
        goal: `Scope: ${activeScope?.name ?? activeScope?.id ?? 'Current scope'}\n${suggestionPrompt}`,
      };
    }

    return {
      title: assetsCount === 0 ? 'Map The Attack Surface' : 'Start The Next Assessment',
      description:
        assetsCount === 0
          ? 'Verified target is ready. Discover assets and services before deeper testing.'
          : 'Use current scope context to choose the next highest-value assessment path.',
      goal: [
        `Scope: ${activeScope?.name ?? activeScope?.id ?? 'Current scope'}`,
        'Determine and plan the next highest-value assessment for this scope using current inventory, risks, prior run digests, approach blockers, and coverage notes. Prefer productive untried work before asking the operator for more input.',
      ].join('\n'),
    };
  }, [activeScope?.id, activeScope?.name, assetsCount, launchSuggestion]);
  const resolveSuggestionPath = (path: string): string => {
    if (path === '/findings') return paths.risksList;
    if (path === '/assets') return paths.assetsList;
    if (path.startsWith('/assets?')) return `${paths.assetsList}${path.slice('/assets'.length)}`;
    if (path === '/runs') return paths.runsList;
    if (path === '/runners') return paths.runnersList;
    if (path === '/automations') return paths.automationsList;
    if (path.startsWith('/findings/')) return paths.findingDetail(path.slice('/findings/'.length));
    if (path.startsWith('/assets/')) return paths.assetDetail(path.slice('/assets/'.length));
    if (path.startsWith('/runs/') && path.endsWith('/workbench')) {
      return paths.runWorkbench(path.slice('/runs/'.length, -'/workbench'.length));
    }
    if (path.startsWith('/runs/')) return paths.runDetail(path.slice('/runs/'.length));
    if (path.startsWith('/?')) return `${location.pathname}${path.slice(1)}`;
    return path;
  };
  const containerRef = useRef<HTMLDivElement | null>(null);
  const waveRef = useRef<HTMLDivElement | null>(null);
  const visibleModels = availableModels;
  const defaultModelCategory = availableModels.find((model) => model.isDefault)?.id ?? availableModels[0]?.id;
  const activeModel = useMemo(
    () => visibleModels.find((model) => model.id === (selectedModelCategory ?? defaultModelCategory)),
    [visibleModels, defaultModelCategory, selectedModelCategory],
  );

  useEffect(() => {
    if (availableModels.length === 0) {
      setSelectedModelCategory(undefined);
      return;
    }

    setSelectedModelCategory((current) =>
      current && availableModels.some((model) => model.id === current) ? current : defaultModelCategory,
    );
  }, [availableModels, defaultModelCategory]);

  useEffect(() => {
    if (!activeScope?.attachedRunner && executionTarget === 'scope_runner') {
      setExecutionTarget('cloud');
    }
  }, [activeScope?.attachedRunner, executionTarget]);

  // Typing placeholder animation (runs only when input is empty)
  const agentPlaceholderBase = useMemo(() => {
    const fallback = "Help me assess my";
    const raw = (placeholder ?? "").trim();
    if (!raw) return fallback;

    // Strip trailing punctuation and clamp long sentence-like placeholders.
    const cleaned = raw.replace(/[.?!,:;\u2026]+$/g, "").trim();
    const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
    if (cleaned.length > 32 || wordCount > 6) {
      return fallback;
    }
    return cleaned;
  }, [placeholder]);

  const agentSuggestionsRef = useRef<string[]>([
    "auth flows",
    "attack surface",
    "api access controls",
    "cloud misconfigs",
    "critical risks",
    "dns risk",
    "firewall rules",
    "phishing posture",
  ]);
  const chatPlaceholderBase = 'Ask about';
  const chatSuggestionsRef = useRef<string[]>([
    "the latest run",
    "open risks",
    "scope assets",
    "techniques tried",
    "rules of engagement",
    "critical issues",
    "repo context",
    "target coverage",
  ]);
  const activePlaceholderBase = isChatMode ? chatPlaceholderBase : agentPlaceholderBase;
  const activeSuggestions = isChatMode ? chatSuggestionsRef.current : agentSuggestionsRef.current;
  const [animatedPlaceholder, setAnimatedPlaceholder] = useState<string>(activePlaceholderBase);
  const typingStateRef = useRef({
    suggestionIndex: 0,
    charIndex: 0,
    deleting: false,
    running: true,
  });
  const timersRef = useRef<number[]>([]);

  useEffect(() => {
    const search = new URLSearchParams(location.search);
    const prefilledPrompt = search.get('prompt');
    if (!prefilledPrompt) return;
    if (prompt.trim().length > 0) return;
    setPrompt(prefilledPrompt);
    if (!isChatMode) {
      setAgentStartMode('manual');
    }
  }, [isChatMode, location.search, prompt]);

  useEffect(() => {
    setInputMode(location.pathname === '/chat' ? 'chat' : 'pentest');
  }, [location.pathname]);

  useEffect(() => {
    if (prefersReducedMotion) {
      setAnimatedPlaceholder(activePlaceholderBase);
      return;
    }

    const suggestions = activeSuggestions.length > 0 ? activeSuggestions : [''];
    typingStateRef.current.running = true;
    typingStateRef.current.suggestionIndex = 0;
    typingStateRef.current.charIndex = 0;
    typingStateRef.current.deleting = false;
    const typeSpeed = 70; // ms per char
    const deleteSpeed = 40;
    const pauseAtEnd = 1200; // pause after full word
    const pauseBetween = 500; // pause after clearing

    function buildPlaceholder(suffix: string) {
      return suffix ? `${activePlaceholderBase} ${suffix}` : activePlaceholderBase;
    }

    function schedule(fn: () => void, delay: number) {
      const id = window.setTimeout(fn, delay);
      timersRef.current.push(id);
    }

    function clearTimers() {
      for (const id of timersRef.current) window.clearTimeout(id);
      timersRef.current = [];
    }

    function step() {
      if (!typingStateRef.current.running) return;
      // Only animate when empty
      if (prompt !== "") {
        setAnimatedPlaceholder(buildPlaceholder(""));
        schedule(step, 300);
        return;
      }

      const state = typingStateRef.current;
      const current = suggestions[state.suggestionIndex % suggestions.length] || "";

      if (!state.deleting) {
        // typing forward
        const nextIndex = state.charIndex + 1;
        const next = current.slice(0, nextIndex);
        setAnimatedPlaceholder(buildPlaceholder(next));
        state.charIndex = nextIndex;
        if (nextIndex >= current.length) {
          // full word typed
          schedule(() => {
            state.deleting = true;
            step();
          }, pauseAtEnd);
        } else {
          schedule(step, typeSpeed);
        }
      } else {
        // deleting back to base
        const nextIndex = Math.max(0, state.charIndex - 1);
        const next = current.slice(0, nextIndex);
        setAnimatedPlaceholder(buildPlaceholder(next));
        state.charIndex = nextIndex;
        if (nextIndex <= 0) {
          state.deleting = false;
          state.suggestionIndex = (state.suggestionIndex + 1) % suggestions.length;
          schedule(step, pauseBetween);
        } else {
          schedule(step, deleteSpeed);
        }
      }
    }

    // kick off
    setAnimatedPlaceholder(activePlaceholderBase);
    clearTimers();
    schedule(step, 400);
    const stateRef = typingStateRef;
    return () => {
      stateRef.current.running = false;
      clearTimers();
    };
  }, [activePlaceholderBase, activeSuggestions, prefersReducedMotion, prompt]);

  useEffect(() => {
    if (prefersReducedMotion) {
      return;
    }
    if (!containerRef.current || !waveRef.current) return;

    // --- Shaders ---
    const FilmGrainShader = {
      uniforms: {
        tDiffuse: { value: null as THREE.Texture | null },
        time: { value: 0 },
        intensity: { value: 1.1 },
        grainScale: { value: 0.5 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        #ifdef GL_ES
          precision highp int;
          precision mediump float;
        #else
          precision mediump float;
        #endif
        uniform sampler2D tDiffuse;
        uniform float time;
        uniform float intensity;
        uniform float grainScale;
        varying vec2 vUv;

        float sparkleNoise(vec2 p) {
          vec2 jPos = p + vec2(37.0, 17.0) * fract(time * 0.07);
          vec3 p3 = fract(vec3(jPos.xyx) * vec3(.1031, .1030, .0973) + time * 0.1);
          p3 += dot(p3, p3.yxz + 19.19);
          return fract((p3.x + p3.y) * p3.z);
        }

        void main() {
          vec4 color = texture2D(tDiffuse, vUv);
          vec2 pos = gl_FragCoord.xy * 0.5 * grainScale;
          float noise = sparkleNoise(pos);
          noise = noise * 2.0 - 1.0;
          vec3 result = color.rgb + noise * intensity * 0.1;
          gl_FragColor = vec4(result, color.a);
        }
      `,
    };

    function createFilmGrainPass(intensity = 0.9, grainScale = 0.3) {
      const pass = new ShaderPass(FilmGrainShader as any);
      (pass.uniforms as any).intensity.value = intensity;
      (pass.uniforms as any).grainScale.value = grainScale;
      return pass;
    }

    // --- Wave State & Keyframes ---
    const wave1 = { gain: 10, frequency: 0, waveLength: 0.5, currentAngle: 0 };
    const wave2 = { gain: 0, frequency: 0, waveLength: 0.5, currentAngle: 0 };

    const waveKeyframes1 = scaleWaveKeyframes(BASE_WAVE_KEYFRAMES_1, motion);
    const waveKeyframes2 = scaleWaveKeyframes(BASE_WAVE_KEYFRAMES_2, motion);

    // --- Mouse & Glow Config ---
    const mouse = { x: 0, y: 0, active: false };
    let proxyMouseX = 0,
      proxyMouseY = 0,
      proxyInitialized = false;

    const glowConfig = {
      maxGlowDistance: 690,
      speedScale: motion.speedScale,
      fadeSpeed: 4.4,
      glowFalloff: 0.6,
      mouseSmoothing: motion.mouseSmoothing,
    };

    const glowDynamics = {
      accumulation: 1.2,
      decay: 3.3,
      max: motion.glowMax,
      accumEase: motion.accumEase,
      speedEase: motion.speedEase,
    };

    // --- THREE.js Setup ---
    let DPR_CAP = 2;
    const mm = gsap.matchMedia();
    mm.add("(max-resolution: 180dpi)", () => {
      DPR_CAP = 1.5;
    });
    const EFFECT_PR = Math.min(window.devicePixelRatio, DPR_CAP) * 0.5;

    const waveContainer = waveRef.current!;
    // Guard against duplicate canvases (e.g., React StrictMode double-mount)
    while (waveContainer.firstChild) {
      waveContainer.removeChild(waveContainer.firstChild);
    }
    const waveRenderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    waveRenderer.setPixelRatio(EFFECT_PR);
    waveRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    waveRenderer.toneMappingExposure = 1.0;
    waveRenderer.autoClear = false;
    waveRenderer.setClearColor(0x000000, 0); // Transparent background
    waveContainer.appendChild(waveRenderer.domElement);

    const waveScene = new THREE.Scene();
    waveScene.fog = null as any;
    waveScene.add(new THREE.AmbientLight(0xffffff, 0.2));

    // Add background plane that renders behind everything
    // This is needed because EffectComposer doesn't preserve transparency
    const bgColor = isDark ? 0x000000 : 0xFFFFFF; // black for dark, white for light
    const bgGeometry = new THREE.PlaneGeometry(10000, 10000);
    const bgMaterial = new THREE.MeshBasicMaterial({ color: bgColor, depthWrite: false });
    const bgPlane = new THREE.Mesh(bgGeometry, bgMaterial);
    bgPlane.position.z = -100; // Behind everything
    bgPlane.renderOrder = -1;
    waveScene.add(bgPlane);

    let waveCamera: THREE.OrthographicCamera;
    let waveComposer: EffectComposer;
    let waveRenderPass: RenderPass;
    let waveBloomPass: UnrealBloomPass;
    let grainPass: ShaderPass;
    let cameraWidth = 0,
      cameraHeight = 0,
      waveCameraInitialized = false;

    let setMouseNDC: (v: number) => void,
      setSmoothSpeed: (v: number) => void,
      setPhase1: (v: number) => void,
      setPhase2: (v: number) => void;

    // --- Bar Instancing ---
    const MAX_BARS = 256;
    const FIXED_BAR_WIDTH = 14;
    const FIXED_BAR_GAP = 10;
    const EXTEND_LEFT_PX = extendLeftPx; // extend bars off the left edge so they appear to come from the right

    let instancedBars: THREE.InstancedMesh | null = null;
    let currentBarCount = 0;
    let barMaterial: THREE.ShaderMaterial;
    let barCenters: Float32Array | null = null;

    function updateGlowDistance() {
      if (!barMaterial) return;
      const totalWidth = currentBarCount * (FIXED_BAR_WIDTH + FIXED_BAR_GAP) - FIXED_BAR_GAP;
      const spanPx = totalWidth * 0.3;
      glowConfig.maxGlowDistance = spanPx;
      (barMaterial.uniforms as any).uMaxGlowDist.value = spanPx;
    }

    function createInstancedMaterial() {
      // Use theme-aware colors
      const hsl = `hsl(${colors.barHue}, ${colors.barSaturation}%, ${colors.barLightness}%)`;
      const baseCol = new THREE.Color(hsl);
      const emisCol = new THREE.Color(hsl);

      return new THREE.ShaderMaterial({
        defines: { USE_INSTANCING: "" },
        uniforms: {
          uMouseClipX: { value: 0 },
          uHalfW: { value: 0 },
          uMaxGlowDist: { value: glowConfig.maxGlowDistance },
          uGlowFalloff: { value: glowConfig.glowFalloff },
          uSmoothSpeed: { value: 0 },
          uGainMul: { value: 1 },
          uBaseY: { value: 0 },
          w1Gain: { value: wave1.gain },
          w1Len: { value: wave1.waveLength },
          w1Phase: { value: 0 },
          w2Gain: { value: wave2.gain },
          w2Len: { value: wave2.waveLength },
          w2Phase: { value: 0 },
          uFixedTipPx: { value: 10 },
          uMinBottomWidthPx: { value: 0 },
          uColor: { value: baseCol },
          uEmissive: { value: emisCol },
          uBaseEmissive: { value: motion.baseEmissive },
          uRotationAngle: { value: THREE.MathUtils.degToRad(23.4) },
          uAlpha: { value: isDark ? motion.darkAlpha : 0.95 }, // Higher opacity for light mode
        },
        vertexShader: `
          attribute float aXPos, aPosNorm, aGroup, aGlow;
          uniform float uMouseClipX, uHalfW, uMaxGlowDist, uGlowFalloff;
          uniform float uGainMul, uBaseY;
          uniform float w1Gain, w1Len, w1Phase;
          uniform float w2Gain, w2Len, w2Phase;
          uniform float uRotationAngle;
          varying float vGlow, vPulse, vHeight;
          varying vec2 vUv;

          float sineH(float g, float len, float ph, float t){
            return max(20.0, (sin(ph + t * len) * 0.5 + 0.6) * g * uGainMul);
          }

          void main(){
            vUv = uv;
            float h1 = sineH(w1Gain, w1Len, w1Phase, aPosNorm);
            float h2 = sineH(w2Gain, w2Len, w2Phase, aPosNorm);
            vHeight = mix(h1, h2, aGroup);

            vec3 pos = position;
            pos.x += aXPos;
            pos.y = 0.0;

            float height = vHeight * uv.y;
            pos.x += height * tan(uRotationAngle);
            pos.y += height;

            pos.y += uBaseY;

            vec4 clip = projectionMatrix * modelViewMatrix * vec4(pos,1.0);
            float dxPx = abs(uMouseClipX - clip.x/clip.w) * uHalfW;
            float prox = clamp(1.0 - pow(dxPx / uMaxGlowDist, uGlowFalloff), 0.0, 1.0);

            vGlow  = aGlow;
            vPulse = prox;
            gl_Position = clip;
          }
        `,
        fragmentShader: `
          #ifdef GL_ES
            precision highp int;
            precision mediump float;
          #else
            precision mediump float;
          #endif
          uniform vec3 uColor, uEmissive;
          uniform float uBaseEmissive;
          uniform float uFixedTipPx, uMinBottomWidthPx;
          uniform float uAlpha;
          varying float vGlow, vPulse, vHeight;
          varying vec2 vUv;

          void main(){
            float tipProp = clamp(uFixedTipPx / vHeight, 0.0, 0.95);
            float transitionY = 1.0 - tipProp;
            float xFromCenter = abs(vUv.x - 0.5) * 2.0;
            float px = fwidth(vUv.x);
            float allowedWidth;

            if (vUv.y >= transitionY){
              float topPos = (vUv.y - transitionY) / tipProp;
              allowedWidth = 1.0 - pow(topPos, 0.9);
            } else {
              float bottomPos = vUv.y / transitionY;
              allowedWidth = max(uMinBottomWidthPx * px * 10.0, pow(bottomPos, 0.5));
            }

            float alpha = smoothstep(-px, px, allowedWidth - xFromCenter);
            if (alpha < 0.01) discard;

            float emissiveStrength = uBaseEmissive + vGlow * 0.9 + vPulse * 0.15;
            vec3 finalColor = uColor + uEmissive * emissiveStrength;
            gl_FragColor = vec4(finalColor, uAlpha * alpha);
          }
        `,
        side: THREE.FrontSide,
        transparent: true,
        depthWrite: false,
        blending: isDark ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
    }

    function setupQuickSetters() {
      const u = (instancedBars!.material as THREE.ShaderMaterial).uniforms as any;
      setMouseNDC = gsap.quickSetter(u.uMouseClipX, "value") as any;
      setSmoothSpeed = gsap.quickSetter(u.uSmoothSpeed, "value") as any;
      setPhase1 = gsap.quickSetter(u.w1Phase, "value") as any;
      setPhase2 = gsap.quickSetter(u.w2Phase, "value") as any;
    }

    const MAX_KEYFRAME_GAIN = 500;
    const SCREEN_COVERAGE = motion.screenCoverage;
    function updateGainMultiplier() {
      if (!barMaterial) return;
      const targetPx = cameraHeight * SCREEN_COVERAGE;
      (barMaterial.uniforms as any).uGainMul.value = targetPx / MAX_KEYFRAME_GAIN;
    }

    // Pointer tracking
    function setupPointerTracking() {
      const el = waveRenderer.domElement;
      const readCoords = (e: PointerEvent | TouchEvent): { x: number; y: number } => {
        if ("clientX" in e) return { x: (e as PointerEvent).clientX, y: (e as PointerEvent).clientY };
        const t = (e as TouchEvent).touches?.[0] || (e as TouchEvent).changedTouches?.[0];
        return t ? { x: t.clientX, y: t.clientY } : { x: mouse.x, y: mouse.y };
      };
      const updatePos = (e: any, active: boolean) => {
        const { x, y } = readCoords(e);
        const r = rect;
        mouse.x = x - r.left;
        mouse.y = y - r.top;
        mouse.active = active;
        if (!proxyInitialized) {
          proxyMouseX = mouse.x;
          proxyMouseY = mouse.y;
          proxyInitialized = true;
        }
      };
      const activate = (e: any) => updatePos(e, true);
      const move = (e: any) => updatePos(e, true);
      const deactivate = () => {
        mouse.active = false;
      };

      el.addEventListener("pointerdown", activate, { passive: true });
      el.addEventListener("pointermove", move, { passive: true });
      window.addEventListener("pointerup", deactivate as any, { passive: true });
      el.addEventListener("pointerleave", deactivate as any, { passive: true });

      el.addEventListener("touchstart", activate as any, { passive: true });
      el.addEventListener("touchmove", move as any, { passive: true });
      window.addEventListener("touchend", deactivate as any, { passive: true });
      window.addEventListener("touchcancel", deactivate as any, { passive: true });

      listeners.push(() => {
        el.removeEventListener("pointerdown", activate as any);
        el.removeEventListener("pointermove", move as any);
        window.removeEventListener("pointerup", deactivate as any);
        el.removeEventListener("pointerleave", deactivate as any);
        el.removeEventListener("touchstart", activate as any);
        el.removeEventListener("touchmove", move as any);
        window.removeEventListener("touchend", deactivate as any);
        window.removeEventListener("touchcancel", deactivate as any);
      });
    }

    // Accumulate glow based on mouse movement
    function accumulateGlow(dt: number) {
      if (!instancedBars) return;
      const attr = (instancedBars.geometry.getAttribute("aGlow") as THREE.InstancedBufferAttribute);
      const arr = attr.array as Float32Array;

      const mouseWorldX = proxyMouseX - cameraWidth * 0.5;
      const mDist = glowConfig.maxGlowDistance;
      const fall = glowConfig.glowFalloff;

      const decayLerp = 1.0 - Math.exp(-glowDynamics.decay * dt);
      const addEase = 1.0 - Math.exp(-glowDynamics.accumEase * dt);
      const vmax = glowDynamics.max;

      for (let i = 0; i < currentBarCount; i++) {
        const dx = Math.abs(mouseWorldX - (barCenters as Float32Array)[i]);
        const hit = dx < mDist ? 1.0 - Math.pow(dx / mDist, fall) : 0.0;

        const targetAdd = hit * smoothSpeed;
        const add = targetAdd * addEase;

        let g = (arr as any)[i] + add - (arr as any)[i] * decayLerp;

        if (g > vmax) g = vmax;
        (arr as any)[i] = (arr as any)[i + currentBarCount] = g;
      }
      (attr as any).needsUpdate = true;
    }

    function createInstancedBars() {
      if (instancedBars) {
        waveScene.remove(instancedBars);
        instancedBars.geometry.dispose();
        (instancedBars.material as any).dispose();
        instancedBars = null;
      }

      const waveWidth = cameraWidth;
      const span = waveWidth + EXTEND_LEFT_PX;
      const barCount = Math.min(
        MAX_BARS,
        Math.max(1, Math.floor((span + FIXED_BAR_GAP) / (FIXED_BAR_WIDTH + FIXED_BAR_GAP)))
      );
      const gap = barCount > 1 ? (span - barCount * FIXED_BAR_WIDTH) / (barCount - 1) : 0;
      currentBarCount = barCount;

      const startX = -waveWidth / 2 - EXTEND_LEFT_PX;
      const instCnt = barCount * 2;
      barCenters = new Float32Array(barCount);

      const aXPos = new Float32Array(instCnt);
      const aPosNorm = new Float32Array(instCnt);
      const aGroup = new Float32Array(instCnt);
      const aGlow = new Float32Array(instCnt).fill(0);

      for (let i = 0; i < barCount; i++) {
        const x = startX + FIXED_BAR_WIDTH / 2 + i * (FIXED_BAR_WIDTH + gap);
        (barCenters as Float32Array)[i] = x;
        const t = barCount > 1 ? i / (barCount - 1) : 0;
        aXPos[i] = x;
        aXPos[i + barCount] = x;
        aPosNorm[i] = t;
        aPosNorm[i + barCount] = t;
        aGroup[i] = 0;
        aGroup[i + barCount] = 1;
      }

      const geo = new THREE.PlaneGeometry(FIXED_BAR_WIDTH, 1, 1, 1);
      geo.translate(0, 0.5, 0);
      geo.setAttribute("aXPos", new THREE.InstancedBufferAttribute(aXPos, 1));
      geo.setAttribute("aPosNorm", new THREE.InstancedBufferAttribute(aPosNorm, 1));
      geo.setAttribute("aGroup", new THREE.InstancedBufferAttribute(aGroup, 1));
      geo.setAttribute(
        "aGlow",
        new THREE.InstancedBufferAttribute(aGlow, 1).setUsage(THREE.DynamicDrawUsage)
      );

      barMaterial = createInstancedMaterial();
      instancedBars = new THREE.InstancedMesh(geo, barMaterial, instCnt);
      instancedBars.frustumCulled = false;
      waveScene.add(instancedBars);

      setupQuickSetters();
      updateGlowDistance();
    }

    // (All text logic removed)

    // --- Scene 1 Timeline ---
    function buildKeyframeTweens(target: any, keyframes: Array<any>) {
      const tl = gsap.timeline();
      for (let i = 0; i < keyframes.length - 1; i++) {
        const cur = keyframes[i];
        const nxt = keyframes[i + 1];
        const duration = nxt.time - cur.time;
        tl.to(
          target,
          {
            gain: nxt.gain,
            frequency: nxt.frequency,
            waveLength: nxt.waveLength,
            duration,
            ease: "power2.inOut",
          },
          cur.time
        );
      }
      return tl;
    }

    function showScene1() {
      if (!waveCameraInitialized) {
        initWaveThree();
        onResize(waveContainer.clientWidth, waveContainer.clientHeight);
      }
      const canvas = waveContainer.querySelector("canvas");
      if (canvas) {
        gsap.to(canvas, {
          opacity: 1,
          duration: 1,
          ease: "power2.out",
        });
      }
    }

    function buildScene1Timeline() {
      const tl = gsap.timeline({
        repeat: -1,
        onStart() {
          showScene1();
        },
      });
      tl.add(buildKeyframeTweens(wave1, waveKeyframes1), 0);
      tl.add(buildKeyframeTweens(wave2, waveKeyframes2), 0);
      return tl;
    }

    function initWaveThree() {
      cameraWidth = waveContainer.clientWidth;
      cameraHeight = waveContainer.clientHeight;
      waveCamera = new THREE.OrthographicCamera(
        -cameraWidth / 2,
        cameraWidth / 2,
        cameraHeight / 2,
        -cameraHeight / 2,
        -1000,
        1000
      );
      waveCamera.position.z = 10;
      waveCamera.lookAt(0, 0, 0);

      waveRenderer.setSize(cameraWidth, cameraHeight);
      waveComposer = new EffectComposer(waveRenderer);
      (waveComposer as any).setPixelRatio(EFFECT_PR);

      waveRenderPass = new RenderPass(waveScene, waveCamera);
      waveComposer.addPass(waveRenderPass);

      // Only add bloom in dark mode - it washes out light backgrounds
      if (isDark) {
        waveBloomPass = new UnrealBloomPass(
          new THREE.Vector2(cameraWidth, cameraHeight),
          motion.bloomStrength,
          motion.bloomRadius,
          0.0,
        );
        (waveBloomPass as any).resolution.set(cameraWidth * 0.5, cameraHeight * 0.5);
        waveComposer.addPass(waveBloomPass);
      }

      // Reduce grain intensity in light mode
      grainPass = createFilmGrainPass(
        isDark ? motion.darkGrainIntensity : motion.lightGrainIntensity,
        isDark ? motion.darkGrainScale : motion.lightGrainScale,
      );
      waveComposer.addPass(grainPass);

      createInstancedBars();
      setupPointerTracking();
      updateGainMultiplier();
      waveCameraInitialized = true;
    }

    let pendingW = 0,
      pendingH = 0,
      heavyResizeTimer: ReturnType<typeof setTimeout> | null = null;

    function onResize(newW: number, newH: number) {
      if (!waveCameraInitialized) return;
      pendingW = newW;
      pendingH = newH;

      cameraWidth = newW;
      cameraHeight = newH;
      waveCamera.left = -cameraWidth / 2;
      waveCamera.right = cameraWidth / 2;
      waveCamera.top = cameraHeight / 2;
      waveCamera.bottom = -cameraHeight / 2;
      waveCamera.updateProjectionMatrix();

      const waveWidth = cameraWidth;
      const span = waveWidth + EXTEND_LEFT_PX;
      const barCount = Math.min(
        MAX_BARS,
        Math.max(1, Math.floor((span + FIXED_BAR_GAP) / (FIXED_BAR_WIDTH + FIXED_BAR_GAP)))
      );
      const gap = barCount > 1 ? (span - barCount * FIXED_BAR_WIDTH) / (barCount - 1) : 0;

      if (barCount !== currentBarCount) {
        currentBarCount = barCount;
        createInstancedBars();
      } else {
        const startX = -waveWidth / 2 - EXTEND_LEFT_PX;
        const aX = instancedBars!.geometry.getAttribute("aXPos") as THREE.InstancedBufferAttribute;
        const aT = instancedBars!.geometry.getAttribute("aPosNorm") as THREE.InstancedBufferAttribute;

        for (let i = 0; i < barCount; i++) {
          const x = startX + FIXED_BAR_WIDTH / 2 + i * (FIXED_BAR_WIDTH + gap);
          const t = barCount > 1 ? i / (barCount - 1) : 0;
          (aX.array as any)[i] = (aX.array as any)[i + barCount] = x;
          (aT.array as any)[i] = (aT.array as any)[i + barCount] = t;
        }
        aX.needsUpdate = true;
        aT.needsUpdate = true;
      }

      (barMaterial.uniforms as any).uHalfW.value = cameraWidth * 0.5;
      updateGainMultiplier();
      updateGlowDistance();

      if (heavyResizeTimer) {
        clearTimeout(heavyResizeTimer);
      }
      heavyResizeTimer = setTimeout(applyHeavyResize, 10);
      rect = waveRenderer.domElement.getBoundingClientRect();
    }

    function applyHeavyResize() {
      heavyResizeTimer = null;
      waveRenderer.setPixelRatio(EFFECT_PR);
      waveRenderer.setSize(pendingW, pendingH);
      (waveComposer as any).setSize(pendingW, pendingH);
      (waveBloomPass as any)?.setSize(pendingW, pendingH);
      (grainPass as any)?.setSize(pendingW, pendingH);
      (grainPass.uniforms as any).grainScale.value = motion.resizeGrainScale;
    }

    function disposeWaveScene() {
      gsap.globalTimeline.clear();
      waveScene.traverse((obj: any) => {
        if (obj.isMesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m: any) => m.dispose());
          } else {
            obj.material.dispose();
          }
        }
      });
      (grainPass as any)?.dispose?.();
      (waveBloomPass as any)?.dispose?.();
      (waveComposer as any)?.dispose?.();
      (waveRenderer as any)?.dispose?.();
      instancedBars = null;
    }

    const listeners: Array<() => void> = [];

    let smoothSpeed = 0;
    let rect = waveRenderer.domElement.getBoundingClientRect();

    const ticker = () => {
      if (!waveCameraInitialized || !instancedBars) return;
      const dt = (gsap.ticker.deltaRatio() as number) * (1 / 60);

      wave1.currentAngle = (wave1.currentAngle + wave1.frequency * dt) % (Math.PI * 2);
      wave2.currentAngle = (wave2.currentAngle + wave2.frequency * dt) % (Math.PI * 2);
      setPhase1(wave1.currentAngle);
      setPhase2(wave2.currentAngle);

      const kMouse = 1.0 - Math.exp(-glowConfig.mouseSmoothing * dt);
      proxyMouseX += (mouse.x - proxyMouseX) * kMouse;
      proxyMouseY += (mouse.y - proxyMouseY) * kMouse;

      const dx = mouse.active ? mouse.x - proxyMouseX : 0;
      const dy = mouse.active ? mouse.y - proxyMouseY : 0;
      const rawSpeed = Math.hypot(dx, dy * 0.1) * glowConfig.speedScale;

      const kSpeed = 1.0 - Math.exp(-glowDynamics.speedEase * dt);
      smoothSpeed += (rawSpeed - smoothSpeed) * kSpeed;
      setSmoothSpeed(smoothSpeed);

      const u = (instancedBars.material as THREE.ShaderMaterial).uniforms as any;
      u.w1Gain.value = wave1.gain;
      u.w1Len.value = wave1.waveLength;
      u.w2Gain.value = wave2.gain;
      u.w2Len.value = wave2.waveLength;

      const mouseClipX = (proxyMouseX / cameraWidth) * 2 - 1;
      setMouseNDC(mouseClipX);
      let baseOffset = 40;
      if (window.innerWidth < 768) baseOffset = 20;
      u.uBaseY.value = -cameraHeight * 0.5 + baseOffset;

      (grainPass.uniforms as any).time.value += dt * 0.2;

      accumulateGlow(dt);
      waveRenderer.clear();
      waveComposer.render();
    };

    // Observers & event listeners
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.target === waveContainer) {
          onResize(e.contentRect.width, e.contentRect.height);
        }
      }
    });

    // Init
    const mainTimeline = buildScene1Timeline();
    mainTimeline.play(0);

    gsap.ticker.add(ticker);
    ro.observe(waveContainer);
    listeners.push(() => gsap.ticker.remove(ticker));
    listeners.push(() => ro.disconnect());

    const onVisibility = () => {
      if (document.hidden) {
        gsap.globalTimeline.pause();
      } else {
        gsap.globalTimeline.resume();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    listeners.push(() => document.removeEventListener("visibilitychange", onVisibility));

    return () => {
      listeners.forEach((fn) => fn());
      try {
        disposeWaveScene();
      } catch (error: unknown) {
        const apiError = toApiError(error);
        console.error('Failed to dispose wave scene', apiError);
      }
      // Remove renderer canvas if still present
      try {
        const canvas = waveRenderer.domElement;
        if (canvas && canvas.parentElement === waveContainer) {
          waveContainer.removeChild(canvas);
        }
      } catch (error: unknown) {
        const apiError = toApiError(error);
        console.error('Failed to remove wave canvas', apiError);
      }
    };
  }, [extendLeftPx, colors, isDark, motion, prefersReducedMotion]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = prompt.trim();


    if (!activeScope?.id) {
      toastService.error(inputMode === 'chat' ? 'Please select a scope before starting chat.' : 'Please select a scope before taking action.');
      return;
    }

    if (inputMode === 'chat') {
      if (!value) return;
      if (targetVerificationMessage) {
        toastService.error(targetVerificationMessage, {
          action: {
            label: 'Verify target',
            onClick: () => navigate(paths.scopeDetail(activeScope.id)),
          },
        });
        return;
      }
      const nextParams = new URLSearchParams();
      nextParams.set('prompt', value);
      if (selectedModelCategory ?? defaultModelCategory) {
        nextParams.set('modelCategory', selectedModelCategory ?? defaultModelCategory ?? '');
      }
      setPrompt('');
      navigate(`/chat?${nextParams.toString()}`);
      return;
    }

    if (isCodeReviewMode) {
      if (codeReviewStartBlockReason) {
        toastService.error(codeReviewStartBlockReason);
        return;
      }

      try {
        const result = await startCodeReview.mutateAsync({
          scopeId: activeScope.id,
          modelCategory: selectedModelCategory ?? defaultModelCategory,
        });
        toastService.success('Code Review assessment started.');
        if (result?.run?.id) {
          navigate(paths.runDetail(result.run.id));
        }
      } catch (error) {
        console.error('Failed to start Code Review assessment:', error);
        const apiError = toApiError(error);
        toastService.error(apiError.userMessage ?? apiError.message ?? 'Failed to start Code Review assessment.');
      }
      return;
    }

    if (isComplianceMode) {
      if (!activeComplianceFramework || complianceStartBlockReason) {
        toastService.error(complianceStartBlockReason ?? 'Select a compliance framework before starting.');
        return;
      }
      if (targetVerificationMessage) {
        toastService.error(targetVerificationMessage, {
          action: activeScope?.id
            ? {
                label: 'Verify target',
                onClick: () => navigate(paths.scopeDetail(activeScope.id)),
              }
            : undefined,
        });
        return;
      }

      try {
        const result = await startComplianceAssessment.mutateAsync({
          scopeId: activeScope.id,
          framework: activeComplianceFramework.key,
          title: `${activeComplianceFramework.label} Readiness Assessment`,
          modelCategory: selectedModelCategory ?? defaultModelCategory,
        });
        toastService.success('Compliance assessment started.');
        if (result?.run?.id) {
          navigate(paths.runDetail(result.run.id));
        }
      } catch (error) {
        console.error('Failed to start compliance assessment:', error);
        const apiError = toApiError(error);
        toastService.error(apiError.userMessage ?? apiError.message ?? 'Failed to start compliance assessment.');
      }
      return;
    }

    if (agentStartMode === 'recommended' && currentOperationalRun) {
      navigate(paths.runWorkbench(currentOperationalRun.id));
      return;
    }

    if (agentStartMode === 'manual' && !value) {
      toastService.error('Describe the assessment objective or use the recommendation.');
      return;
    }

    if (targetVerificationMessage) {
      toastService.error(targetVerificationMessage, {
        action: activeScope?.id
          ? {
              label: 'Verify target',
              onClick: () => navigate(paths.scopeDetail(activeScope.id)),
            }
          : undefined,
      });
      return;
    }

    const goal =
      agentStartMode === 'manual'
        ? value
        : recommendedLaunch.goal;

    try {
      const result = await createRunMutation.mutateAsync({
        scopeId: activeScope.id,
        goal,
        modelCategory: selectedModelCategory ?? defaultModelCategory,
        executionTarget,
        trigger: 'manual',
      });
      setPrompt('');
      setAgentStartMode('recommended');
      
      // Navigate to the newly created run
      if (result && result.run && result.run.id) {
        toastService.success('Agent started successfully.');
        navigate(paths.runDetail(result.run.id));
      } else {
        toastService.error('Failed to create run.');
      }
    } catch (error) {
       console.error('Failed to start run:', error);
       const apiError = toApiError(error);

       toastService.error(apiError.userMessage ?? apiError.message ?? 'Failed to start run.');
    }
  };

  const submitPending = isChatMode
    ? false
    : isCodeReviewMode
      ? startCodeReview.isPending
    : isComplianceMode
      ? startComplianceAssessment.isPending
      : createRunMutation.isPending;

  /* Ambient captions for the launch overlay. They name the KIND of work in
     flight, never a step number and never a completion — it is one HTTP call,
     so the browser cannot see any of this finish. */
  const preparingCaptions = isCodeReviewMode
    ? [
        'Creating an isolated container',
        'Fetching the repository',
        'Preparing the model',
        'Starting the review agent',
      ]
    : isComplianceMode
      ? [
          'Creating an isolated container',
          'Loading the framework controls',
          'Preparing the model',
          'Starting the readiness agent',
        ]
      : [
          'Creating an isolated container',
          'Fetching company data',
          'Preparing the model',
          'Starting the agent',
        ];
  const submitDisabled = isCodeReviewMode
    ? submitPending ||
      Boolean(codeReviewStartBlockReason)
    : submitPending ||
      !activeScope?.id ||
      Boolean(targetVerificationMessage) ||
      (isComplianceMode && Boolean(complianceStartBlockReason));
  const modeFrameClasses = isChatMode
    ? isDark
      ? 'border-primary/45'
      : 'border-primary/40'
    : isComplianceMode
      ? isDark
        ? 'border-success/35'
        : 'border-success/30'
    : isCodeReviewMode
      ? isDark
        ? 'border-primary/35'
        : 'border-primary/30'
    : 'border-border/60 ';
  const modeFocusRingClasses = isChatMode
    ? 'focus-within:ring-1 focus-within:ring-primary/35'
    : isComplianceMode
      ? 'focus-within:ring-1 focus-within:ring-success/35'
    : isCodeReviewMode
      ? 'focus-within:ring-1 focus-within:ring-primary/35'
    : 'focus-within:ring-1 focus-within:ring-ns-yellow/40';
  const activePlaceholder = animatedPlaceholder;
  const modeDescription = isChatMode
    ? 'Read-only assistant with scope context'
    : isComplianceMode
      ? 'Agent checks compliance controls'
    : isCodeReviewMode
      ? 'Agent reviews one immutable repository revision'
      : 'Agent starts a security run';
  const canOpenCurrentOperationalRun = inputMode === 'pentest' && Boolean(currentOperationalRun);
  const recommendedPanelTitle = isCodeReviewMode
    ? 'Review a Repository'
    : isComplianceMode
    ? activeComplianceFramework
      ? `Start ${activeComplianceFramework.label} Readiness`
      : 'Start Compliance Readiness'
    : canOpenCurrentOperationalRun
      ? 'Assessment Already Running'
      : recommendedLaunch.title;
  const recommendedPanelDescription: React.ReactNode = isCodeReviewMode
    ? needsCodeSource && activeScope?.id
      ? (
          <>
            Add code on the{' '}
            <button
              type="button"
              className="underline underline-offset-2 hover:opacity-80"
              onClick={() => navigate(paths.scopeDetail(activeScope.id))}
            >
              scope page
            </button>{' '}
            first.
          </>
        )
      : codeReviewStartBlockReason ??
        (codeSource ? `${describeCodeSource(codeSource)}. The agent reads this commit and nothing else.` : null)
    : isComplianceMode
    ? complianceStartBlockReason ?? `Launch a dedicated compliance run. The agent reviews ${activeComplianceFramework?.monitoredControls ?? 0} monitored controls, records bounded verdicts, and updates the control workspace.`
    : canOpenCurrentOperationalRun
    ? 'This scope already has a live run. Open the workbench to review progress before starting another assessment.'
    : recommendedLaunch.description;

  return (
    <>
      {/* Takes the screen while the launch is in flight. The button underneath
          used to answer the whole wait with a 7px flickering square, so a slow
          provision read as a dead page. */}
      <WorkingOverlay
        open={submitPending}
        title={
          isCodeReviewMode
            ? 'Preparing your code review'
            : isComplianceMode
              ? 'Preparing your readiness assessment'
              : 'Preparing your assessment'
        }
        captions={preparingCaptions}
      />
      <section
        ref={containerRef}
        className={`${colors.sectionBg} ${className || ''}`}
        style={{ position: "relative", width: "100%", height: "100svh", minHeight: "100svh", overflow: "hidden", ...style }}
        aria-label="Animated hero"
      >
        {/* Content overlay */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 3,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "flex-start",
            pointerEvents: "none",
            padding: "clamp(16px, 3vh, 32px) 20px",
            overflowX: "hidden",
            overflowY: "auto",
          }}
        >
          <div
            className="w-full max-w-[920px] text-center"
            style={{ pointerEvents: "auto", marginBlock: "auto" }}
          >
            <h1 className={`${colors.textPrimary} text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tight`}>
              {title}
            </h1>
            <p className={`${colors.textSecondary} mx-auto mt-3 max-w-[720px] text-sm leading-6 sm:text-base sm:leading-7`}>
              {subtitle}
            </p>
            <form
              className="mt-5 flex items-center justify-center sm:mt-6"
              onSubmit={handleSubmit}
            >
              <div className="relative w-full max-w-[840px]">
                <div
                  className={cn(
                    'relative rounded-none border bg-background/60 transition-[border-color,box-shadow] duration-300',
                    modeFrameClasses,
                  )}
                >
                  <div
                    className={cn(
                      `overflow-hidden rounded-none bg-transparent`,
                      'transition-all duration-200',
                      modeFocusRingClasses,
                    )}
                  >
                    <div className={cn('flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between', colors.inputBorder)}>
                      <div
                        className={cn(
                          'inline-flex w-fit items-center rounded-none border p-1',
                          isDark ? 'border-white/10 bg-white/[0.03]' : 'border-black/10 bg-black/[0.03]',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setInputMode('pentest');
                            setAgentStartMode('recommended');
                          }}
                          className={cn(
                            'rounded-none px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.22em] transition-all',
                            inputMode === 'pentest'
                              ? 'bg-ns-yellow text-primary-foreground '
                              : isDark
                                ? 'text-white/58 hover:text-white'
                                : 'text-[#1A1A1A]/58 hover:text-[#1A1A1A]',
                          )}
                        >
                          Pentest
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setInputMode('compliance');
                            setAgentStartMode('recommended');
                          }}
                          className={cn(
                            'rounded-none px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.22em] transition-all',
                            isComplianceMode
                              ? 'bg-success text-ns-inverse '
                              : isDark
                                ? 'text-white/58 hover:text-white'
                                : 'text-[#1A1A1A]/58 hover:text-[#1A1A1A]',
                          )}
                        >
                          Compliance
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setInputMode('code_review');
                            setAgentStartMode('recommended');
                          }}
                          className={cn(
                            'rounded-none px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.22em] transition-all',
                            isCodeReviewMode
                              ? 'bg-primary text-ns-inverse '
                              : isDark
                                ? 'text-white/58 hover:text-white'
                                : 'text-[#1A1A1A]/58 hover:text-[#1A1A1A]',
                          )}
                        >
                          Code Review
                        </button>
                      </div>

                      <div className={cn('text-[11px] font-mono uppercase tracking-[0.22em]', isChatMode ? (isDark ? 'text-primary/85' : 'text-primary') : (isDark ? 'text-white/45' : 'text-[#1A1A1A]/45'))}>
                        {modeDescription}
                      </div>
                    </div>

                    {isChatMode || (inputMode === 'pentest' && agentStartMode === 'manual') ? (
                      <Textarea
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder={activePlaceholder}
                        data-testid="chat-hero-input"
                        rows={5}
                        className={`w-full h-32 sm:h-36 resize-none rounded-none border-0 bg-transparent ${colors.inputText} ${colors.inputPlaceholder} outline-none focus:ring-0 px-5 pt-5 pb-4 text-base leading-7 sm:px-6 sm:pt-6`}
                      />
                    ) : (
                      <div className="px-5 py-7 text-center sm:px-8 sm:py-9" data-testid="agent-recommendation-launcher">
                        <div className="mx-auto max-w-[600px]">
                          <h2 className={cn('text-xl font-semibold sm:text-2xl', colors.textPrimary)}>
                            {recommendedPanelTitle}
                          </h2>
                          <p className={cn('mx-auto mt-3 max-w-[560px] text-sm leading-6', colors.textSecondary)}>
                            {recommendedPanelDescription}
                          </p>

                          <div className="mt-6 flex items-center justify-center">
                            <button
                              type={canOpenCurrentOperationalRun ? 'button' : 'submit'}
                              disabled={!canOpenCurrentOperationalRun && submitDisabled}
                              aria-label={
                                canOpenCurrentOperationalRun
                                  ? 'Open active assessment workbench'
                                  : isCodeReviewMode
                                    ? 'Start Code Review assessment'
                                    : isComplianceMode
                                      ? 'Start compliance assessment'
                                      : 'Start next assessment'
                              }
                              data-testid="chat-hero-submit"
                              title={
                                canOpenCurrentOperationalRun
                                  ? 'Open active assessment workbench'
                                  : isCodeReviewMode
                                    ? codeReviewStartBlockReason ?? 'Start Code Review assessment'
                                  : inputMode === 'pentest'
                                    ? targetVerificationMessage ?? 'Start next assessment'
                                    : complianceStartBlockReason ?? targetVerificationMessage ?? 'Start compliance assessment'
                              }
                              onClick={canOpenCurrentOperationalRun && currentOperationalRun ? () => navigate(paths.runWorkbench(currentOperationalRun.id)) : undefined}
                              className={cn(
                                'inline-flex min-h-11 min-w-[148px] items-center justify-center rounded-none px-7 text-sm font-black uppercase transition-opacity hover:opacity-90',
                                isCodeReviewMode
                                  ? 'bg-primary text-ns-inverse'
                                  : isComplianceMode
                                    ? 'bg-success text-ns-inverse'
                                    : 'bg-ns-yellow text-primary-foreground',
                                !canOpenCurrentOperationalRun && submitDisabled ? 'cursor-not-allowed opacity-50' : '',
                              )}
                            >
                              {canOpenCurrentOperationalRun
                                ? 'Open Workbench'
                                : isCodeReviewMode
                                  ? 'Start Code Review'
                                  : isComplianceMode
                                    ? 'Start Compliance'
                                    : 'Start'}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className={`flex flex-col gap-3 border-t ${colors.inputBorder} px-4 py-3 sm:flex-row sm:items-center sm:justify-between`}>
                      <div className="hidden min-w-0 flex-wrap items-center gap-x-4 gap-y-2 lg:flex">
                        <HeroModelSelect
                          availableModels={visibleModels}
                          selectedModel={activeModel}
                          value={selectedModelCategory ?? defaultModelCategory}
                          disabled={submitPending}
                          isDark={isDark}
                          isLoading={isModelsLoading}
                          onValueChange={setSelectedModelCategory}
                        />
                        {inputMode === 'compliance' && complianceFrameworkOptions.length > 0 ? (
                          <>
                            <div className={cn('hidden h-4 w-px sm:block', isDark ? 'bg-white/10' : 'bg-black/12')} />
                            <div className="flex min-w-0 items-center gap-2">
                              <span className={cn('text-[11px] font-mono uppercase tracking-[0.24em]', isDark ? 'text-white/40' : 'text-[#1A1A1A]/45')}>
                                Framework
                              </span>
                              {complianceFrameworkOptions.length === 1 ? (
                                <span className="truncate text-sm font-medium text-foreground/78">{activeComplianceFramework?.label}</span>
                              ) : (
                                <Select
                                  value={activeComplianceFramework?.key ?? ''}
                                  onValueChange={(nextValue) => setSelectedComplianceFramework(nextValue as ComplianceFrameworkKey)}
                                  disabled={submitPending}
                                >
                                  <SelectTrigger className="h-auto min-h-0 w-auto rounded-none border-0 bg-transparent px-0 py-0 text-sm font-medium text-foreground/78 shadow-none outline-none transition-colors hover:text-foreground focus:ring-0 focus:ring-offset-0 data-[state=open]:text-foreground">
                                    <span className="truncate">{activeComplianceFramework?.label ?? 'Select framework'}</span>
                                  </SelectTrigger>
                                  <SelectContent className="z-[120] rounded-none border border-border/10 bg-background p-1 text-foreground ">
                                    <SelectGroup>
                                      <SelectLabel className="px-3 pb-1 pt-2 text-sm font-normal text-foreground/55">Framework</SelectLabel>
                                      {complianceFrameworkOptions.map((framework) => (
                                        <SelectItem
                                          key={framework.key}
                                          value={framework.key}
                                          className={cn(
                                            'rounded-none py-2 pl-8 pr-3 text-left text-sm outline-none',
                                            isDark ? 'focus:bg-primary/10 focus:text-foreground' : 'focus:bg-primary/5 focus:text-foreground',
                                          )}
                                        >
                                          <span className="truncate font-medium">{framework.label}</span>
                                        </SelectItem>
                                      ))}
                                    </SelectGroup>
                                  </SelectContent>
                                </Select>
                              )}
                            </div>
                          </>
                        ) : null}
                        {inputMode === 'pentest' ? (
                          <>
                            <div
                              className={cn(
                                'hidden h-4 w-px sm:block',
                                isDark ? 'bg-white/10' : 'bg-black/12',
                              )}
                            />
                            <div className="flex min-w-0 items-center gap-2">
                              <span className={cn('text-[11px] font-mono uppercase tracking-[0.24em]', isDark ? 'text-white/40' : 'text-[#1A1A1A]/45')}>
                                Execute
                              </span>
                              <ExecutionTargetSelector
                                value={executionTarget}
                                onChange={setExecutionTarget}
                                runnerName={activeScope?.attachedRunner?.name}
                                disabled={submitPending}
                                className={cn(isDark ? 'border-white/12 bg-black/20' : 'border-black/10 bg-black/[0.04]')}
                              />
                            </div>
                          </>
                        ) : null}
                      </div>

                      {isChatMode ? (
                        <button
                          type="submit"
                          disabled={submitDisabled}
                          aria-label={buttonText}
                          data-testid="chat-hero-submit"
                          title={!activeScope?.id ? 'Select a scope first' : targetVerificationMessage ?? buttonText}
                          className={cn(
                            'inline-flex h-11 w-11 items-center justify-center self-end rounded-none bg-primary text-ns-inverse transition-opacity hover:opacity-90 sm:self-auto',
                            submitDisabled ? 'cursor-not-allowed opacity-50' : '',
                          )}
                        >
                          <ArrowUpRight className="h-5 w-5" />
                        </button>
                      ) : inputMode === 'pentest' && agentStartMode === 'manual' ? (
                        <div className="flex items-center gap-3 self-end sm:self-auto">
                          <button
                            type="button"
                            className={cn('text-[11px] font-mono uppercase transition-colors', isDark ? 'text-white/35 hover:text-white/70' : 'text-[#1A1A1A]/45 hover:text-[#1A1A1A]/70')}
                            onClick={() => {
                              setPrompt('');
                              setAgentStartMode('recommended');
                            }}
                          >
                            Use next assessment
                          </button>
                          <button
                            type="submit"
                            disabled={submitDisabled}
                            aria-label="Start manual assessment"
                            data-testid="chat-hero-submit"
                            title={!activeScope?.id ? 'Select a scope first' : 'Start manual assessment'}
                            className={cn(
                              'inline-flex h-11 w-11 items-center justify-center rounded-none transition-opacity hover:opacity-90',
                              `${colors.buttonBg} ${colors.buttonText}`,
                              submitDisabled ? 'cursor-not-allowed opacity-50' : '',
                            )}
                          >
                            {submitPending ? <span className="ns-live-mark" aria-hidden /> : <ArrowUpRight className="h-5 w-5" />}
                          </button>
                        </div>
                      ) : (
                        inputMode === 'pentest' ? (
                          <button
                            type="button"
                            className={cn('text-[11px] font-mono uppercase transition-colors', isDark ? 'text-white/35 hover:text-white/70' : 'text-[#1A1A1A]/45 hover:text-[#1A1A1A]/70')}
                            onClick={() => {
                              setPrompt('');
                              setAgentStartMode('manual');
                            }}
                          >
                            Write your own objective
                          </button>
                        ) : (
                          <div className={cn('text-[11px] font-mono uppercase', isDark ? 'text-white/35' : 'text-[#1A1A1A]/45')}>
                            {isCodeReviewMode ? 'Code Review assessment' : 'Compliance assessment'}
                          </div>
                        )
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </form>
            <div className="mx-auto mt-4 w-full max-w-[840px]">
              {targetVerificationMessage && activeScope?.id && !canOpenCurrentOperationalRun ? (
                <div className={cn('flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs', colors.textSecondary)}>
                  <span>
                    {targetVerificationState === 'missing'
                      ? `Add and verify a target before ${isChatMode ? 'chatting' : 'starting'}.`
                      : `Verify the target before ${isChatMode ? 'chatting' : 'starting'}.`}
                  </span>
                  <button
                    type="button"
                    className={cn('font-semibold transition-colors', isDark ? 'text-white/72 hover:text-white' : 'text-[#1A1A1A]/72 hover:text-[#1A1A1A]')}
                    onClick={() => navigate(paths.scopeDetail(activeScope.id))}
                  >
                    Verify target
                  </button>
                </div>
              ) : null}
            </div>

            {inputMode === 'pentest' ? (
              <div className="mx-auto mt-5 hidden w-full max-w-[840px] sm:mt-6 lg:block">
                {hasActiveScope ? (
                  <>
                    {showScopeGuidancePanel || currentOperationalRun ? (
                      <div data-tour="agent-insights" className={`rounded-none border border-border/60 bg-background/50 px-5 py-4 text-left mb-6`}>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <p className={`font-semibold uppercase tracking-wide text-sm ${colors.textPrimary}`}>
                              Operational Insights
                            </p>
                            <p className={`mt-1 text-xs ${colors.textSecondary}`}>
                              Scope: <span className={colors.textPrimary}>{activeScope?.name ?? 'Selected Scope'}</span>
                            </p>
                          </div>
                          <div className={`text-[10px] sm:text-xs ${colors.textSecondary}`}>{scopeSnapshotSummary}</div>
                        </div>

                        {operationalInsightCards.length > 0 ? (
                          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                            {operationalInsightCards.map((suggestion) => (
                              <button
                                key={suggestion.id}
                                type="button"
                                className="rounded-none border border-border/40 px-4 py-3 text-left transition-colors hover:border-ns-yellow/50 hover:bg-ns-yellow/5"
                                onClick={() => navigate(resolveSuggestionPath(suggestion.to))}
                              >
                                <p className={`text-sm font-semibold ${colors.textPrimary}`}>{suggestion.title}</p>
                                <p className={`mt-1 text-xs ${colors.textSecondary}`}>
                                  {suggestion.description}
                                </p>
                                <p className="mt-2 text-[11px] text-ns-yellow">{suggestion.cta}</p>
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className={`rounded-none border border-border/60 bg-background/50 px-5 py-4 text-left`}>
                    <p className={`font-semibold uppercase tracking-wide text-sm ${colors.textPrimary}`}>
                      Scope Required
                    </p>
                    <p className={`mt-2 text-xs ${colors.textSecondary}`}>
                      Create or select a scope to start agent-driven runs.
                    </p>
                    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {quickSuggestions.map((suggestion) => (
                        <button
                          key={suggestion.id}
                          type="button"
                          className="rounded-none border border-border/40 px-4 py-3 text-left transition-colors hover:border-ns-yellow/50 hover:bg-ns-yellow/5"
                          onClick={() => navigate(resolveSuggestionPath(suggestion.to))}
                        >
                          <p className={`text-sm font-semibold ${colors.textPrimary}`}>{suggestion.title}</p>
                          <p className={`mt-1 text-xs ${colors.textSecondary}`}>{suggestion.description}</p>
                          <p className="mt-2 text-[11px] text-ns-yellow">{suggestion.cta}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
        {/* Theme-aware background layer */}
        <div
          className={colors.sectionBg}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 0,
          }}
        />
        <div
          ref={waveRef}
          id="waveCanvas"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 1,
            opacity: isDark ? 0.8 : 1, // Full opacity in light mode
          }}
        />
      </section>
    </>
  );
};
