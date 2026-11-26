export type QuickSuggestion = {
  id: string;
  title: string;
  description: string;
  cta: string;
  to: string;
  priority: number;
};

export type QuickSuggestionContext = {
  scopeId: string | null;
  hasScope: boolean;
  targetCount: number;
  verifiedTargetCount: number;
  assetsCount: number;
  openRisksCount: number;
  resolvedRisksCount: number;
  criticalCount: number;
  highCount: number;
  activeAutomationsCount: number;
  runnersTotal: number;
  runnersOnline: number;
  activeRunsCount: number;
  canAccessPrivateRunners?: boolean;
  canAccessAutomations?: boolean;
};

type SuggestionRule = {
  id: string;
  when: (ctx: QuickSuggestionContext) => boolean;
  build: (ctx: QuickSuggestionContext) => Omit<QuickSuggestion, 'id'>;
};

const suggestionRules: SuggestionRule[] = [
  {
    id: 'complete_setup',
    when: (ctx) => !ctx.hasScope,
    build: () => ({
      title: 'Complete Setup',
      description: 'Create your first scope and set its target before starting automated runs.',
      cta: 'Open Setup',
      to: '/setup',
      priority: 100,
    }),
  },
  {
    id: 'verify_target',
    when: (ctx) => ctx.hasScope && (ctx.targetCount === 0 || ctx.verifiedTargetCount === 0),
    build: (ctx) => ({
      title: ctx.targetCount === 0 ? 'Set Scope Target' : 'Verify Target Ownership',
      description:
        ctx.targetCount === 0
          ? 'Add a target to this scope before launching scoped runs.'
          : 'DNS verification is required before the agent can start scoped runs.',
      cta: 'Open Scope Verification',
      to: ctx.scopeId ? `/scopes/${ctx.scopeId}` : '/scopes',
      priority: 90,
    }),
  },
  {
    id: 'configure_runner',
    when: (ctx) => ctx.canAccessPrivateRunners !== false && ctx.runnersTotal === 0,
    build: () => ({
      title: 'Connect a Runner',
      description: 'No runner is connected yet, so private execution cannot start.',
      cta: 'Open Runner Settings',
      to: '/runners',
      priority: 85,
    }),
  },
  {
    id: 'runner_offline',
    when: (ctx) => ctx.canAccessPrivateRunners !== false && ctx.runnersTotal > 0 && ctx.runnersOnline === 0,
    build: () => ({
      title: 'Runner Offline',
      description: 'A runner exists but is offline. Bring one online before launching runs.',
      cta: 'Check Runners',
      to: '/runners',
      priority: 84,
    }),
  },
  {
    id: 'review_high_risk_findings',
    when: (ctx) => ctx.openRisksCount > 0 && (ctx.criticalCount > 0 || ctx.highCount > 0),
    build: () => ({
      title: 'Review High Risks',
      description: 'Critical or high risks are open and need triage/remediation tracking.',
      cta: 'Open Risks',
      to: '/risks',
      priority: 80,
    }),
  },
  {
    id: 'start_first_assessment',
    when: (ctx) =>
      ctx.hasScope &&
      ctx.verifiedTargetCount > 0 &&
      ctx.assetsCount > 0 &&
      ctx.openRisksCount === 0 &&
      ctx.resolvedRisksCount === 0,
    build: () => ({
      title: 'Run Vulnerability Assessment',
      description: 'Assets are present but no risks are linked yet. Start an assessment now.',
      cta: 'Generate Strategy',
      to:
        '/?prompt=' +
        encodeURIComponent(
          'Run a vulnerability assessment for discovered assets in this scope. Focus on highest-risk services first and report risks with evidence.',
        ),
      priority: 70,
    }),
  },
  {
    id: 'start_discovery_session',
    when: (ctx) => ctx.hasScope && ctx.verifiedTargetCount > 0 && ctx.assetsCount === 0,
    build: () => ({
      title: 'Start Discovery Session',
      description: 'Verified target is ready. Discover assets and services before deeper testing.',
      cta: 'Generate Strategy',
      to:
        '/?prompt=' +
        encodeURIComponent(
          'Discover and map the attack surface for this scope, starting from the verified target and expanding into related subdomains, services, endpoints, and technology fingerprints.',
        ),
      priority: 69,
    }),
  },
  {
    id: 'review_open_findings',
    when: (ctx) => ctx.openRisksCount > 0,
    build: () => ({
      title: 'Review Open Risks',
      description: 'There are unresolved risks that may need follow-up assessments.',
      cta: 'Open Risks',
      to: '/risks',
      priority: 60,
    }),
  },
  {
    id: 'default_next_step',
    when: (ctx) => ctx.activeRunsCount > 0,
    build: () => ({
      title: 'Review Active Assessments',
      description: 'Check the latest agent progress and approvals.',
      cta: 'Open Assessments',
      to: '/runs',
      priority: 10,
    }),
  },
];

export function buildQuickSuggestions(ctx: QuickSuggestionContext, limit = 3): QuickSuggestion[] {
  const deduped: QuickSuggestion[] = [];
  const usedIds = new Set<string>();

  suggestionRules
    .filter((rule) => rule.when(ctx))
    .map((rule) => ({
      id: rule.id,
      ...rule.build(ctx),
    }))
    .sort((a, b) => b.priority - a.priority)
    .forEach((suggestion) => {
      if (usedIds.has(suggestion.id)) return;
      usedIds.add(suggestion.id);
      deduped.push(suggestion);
    });

  return deduped.slice(0, limit);
}
