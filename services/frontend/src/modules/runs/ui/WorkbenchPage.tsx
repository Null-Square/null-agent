import { useEffect, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { AgentWorkbenchPhaseRail } from '@null-ai/design-tokens/ui';
import { ChatPage } from '@modules/chat';
import { useRunActivityQuery, useRunDetailQuery, useRunPhasesQuery } from '@/modules/security-ops/api';
import type {
  RunPhaseSessionEntry,
  RunPhaseTimelineEntry,
} from '@/modules/security-ops/types';
import { useSessionDetailsQuery } from '@modules/sessions';
import { logWorkbenchDebug, summarizeSessionSnapshot } from '@shared/lib/workbenchDebug';
import { resolveRunSessionId } from '../lib/runState';
import { isTerminalRunStatus } from '../lib/runStatus';

const phaseTimelineToSessionEntry = (phase: RunPhaseTimelineEntry): RunPhaseSessionEntry => ({
  id: `activity-phase-${phase.ordinal}-${phase.phase}`,
  phase: phase.phase,
  label: phase.label,
  ordinal: phase.ordinal,
  status: phase.status,
  rawStatus: phase.status,
  sessionId: null,
  startedAt: phase.startedAt,
  completedAt: phase.completedAt,
  durationMs: phase.durationMs,
  reason: phase.reason ?? null,
});

function WorkbenchPhaseNavigator({
  phases,
  activeSessionId,
  selectedSessionId,
  onSelectPhase,
  hasSessionLinks,
}: {
  phases: RunPhaseSessionEntry[];
  activeSessionId: string | null | undefined;
  selectedSessionId: string | null | undefined;
  onSelectPhase: (phase: RunPhaseSessionEntry) => void;
  hasSessionLinks: boolean;
}) {
  if (phases.length === 0) return null;

  return (
    <AgentWorkbenchPhaseRail
      phases={phases.map((phase) => ({
        id: phase.id,
        label: phase.label,
        status: phase.status,
        selectable: Boolean(phase.sessionId),
        selected: phase.sessionId === selectedSessionId,
        active: phase.sessionId === activeSessionId,
      }))}
      onSelect={(phaseId) => {
        const phase = phases.find((entry) => entry.id === phaseId);
        if (phase) onSelectPhase(phase);
      }}
      trailing={!hasSessionLinks ? 'Read-only snapshot' : undefined}
    />
  );
}

/**
 * WorkbenchPage - run-scoped live chat + terminal.
 * Binds the chat module to the run session ID.
 */
export default function WorkbenchPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: run, isLoading } = useRunDetailQuery(id ?? '');
  const activeSessionId = resolveRunSessionId(run);
  const isTerminalRun = isTerminalRunStatus(run?.status);
  const { data: phaseSessions = [], isLoading: isLoadingPhases } = useRunPhasesQuery(id ?? '', {
    enabled: Boolean(id),
    refetchInterval: isTerminalRun ? false : 5000,
  });
  const shouldLoadActivityPhaseFallback =
    Boolean(id) && !isLoadingPhases && phaseSessions.length === 0;
  const { data: activityFallback } = useRunActivityQuery(id ?? '', {
    enabled: shouldLoadActivityPhaseFallback,
    refetchInterval: isTerminalRun ? false : 5000,
  });
  const activityPhases = useMemo(
    () => (activityFallback?.phases ?? []).map(phaseTimelineToSessionEntry),
    [activityFallback?.phases],
  );
  const phases = phaseSessions.length > 0 ? phaseSessions : activityPhases;
  const hasPhaseSessionLinks = phaseSessions.some((phase) => Boolean(phase.sessionId));
  const querySessionId = searchParams.get('session');
  const phaseSessionIds = useMemo(
    () => new Set(phases.map((phase) => phase.sessionId).filter((sessionId): sessionId is string => Boolean(sessionId))),
    [phases],
  );
  const selectedSessionId =
    querySessionId && (isLoadingPhases || phaseSessionIds.has(querySessionId))
      ? querySessionId
      : activeSessionId;
  const isReviewingHistoricalPhase = Boolean(
    selectedSessionId && activeSessionId && selectedSessionId !== activeSessionId,
  );
  const selectedPhase = useMemo(
    () => phases.find((phase) => phase.sessionId === selectedSessionId) ?? null,
    [phases, selectedSessionId],
  );
  const activeReplacementPhase = useMemo(
    () =>
      selectedPhase
        ? phases.find(
            (phase) =>
              phase.phase === selectedPhase.phase &&
              phase.rawStatus === 'active' &&
              Boolean(phase.sessionId) &&
              phase.sessionId !== selectedSessionId,
          ) ?? null
        : null,
    [phases, selectedPhase, selectedSessionId],
  );

  const { data: sessionSnapshot } = useSessionDetailsQuery(selectedSessionId ?? undefined, {
    staleTime: 0,
    refetchOnMount: 'always',
  });

  useEffect(() => {
    if (!activeSessionId) return;
    const currentSession = searchParams.get('session');
    if (currentSession) {
      if (isLoadingPhases) return;
      if (currentSession === activeSessionId || phaseSessionIds.has(currentSession)) return;
    }

    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set('session', activeSessionId);
    nextParams.delete('new');
    setSearchParams(nextParams, { replace: true });
  }, [activeSessionId, isLoadingPhases, phaseSessionIds, searchParams, setSearchParams]);

  useEffect(() => {
    logWorkbenchDebug('workbench.route', {
      runId: id ?? null,
      activeSessionId: activeSessionId ?? null,
      selectedSessionId: selectedSessionId ?? null,
      runStatus: run?.status ?? null,
      snapshot: summarizeSessionSnapshot(sessionSnapshot),
    });
  }, [activeSessionId, id, run?.status, selectedSessionId, sessionSnapshot]);

  const handleSelectPhase = (phase: RunPhaseSessionEntry) => {
    if (!phase.sessionId) return;
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set('session', phase.sessionId);
    nextParams.delete('new');
    setSearchParams(nextParams);
  };

  const handleOpenActiveReplacement = () => {
    if (!activeReplacementPhase?.sessionId) return;
    handleSelectPhase(activeReplacementPhase);
  };

  const phaseNavigator =
    id ? (
      <div className="flex min-w-0 flex-col gap-2">
        <WorkbenchPhaseNavigator
          phases={phases}
          activeSessionId={activeSessionId}
          selectedSessionId={selectedSessionId}
          onSelectPhase={handleSelectPhase}
          hasSessionLinks={hasPhaseSessionLinks}
        />
        {activeReplacementPhase?.sessionId ? (
          <div className="flex min-w-0 items-center gap-2 text-xs text-warning">
            <span className="truncate">
              This phase session is stale. Active {activeReplacementPhase.label} session is available.
            </span>
            <button
              type="button"
              onClick={handleOpenActiveReplacement}
              className="inline-flex shrink-0 items-center gap-1 border border-warning/30 px-2 py-1 text-xs font-bold text-warning hover:bg-warning/10"
            >
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              Open active
            </button>
          </div>
        ) : null}
      </div>
    ) : undefined;

  if (isLoading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center font-sans text-sm text-muted-foreground ">
        Loading workbench...
      </div>
    );
  }

  if (!run) {
    return (
      <div className="flex min-h-[400px] items-center justify-center font-sans text-sm text-muted-foreground ">
        Run not found
      </div>
    );
  }

  if (!selectedSessionId) {
    return (
      <div className="flex min-h-[400px] items-center justify-center font-sans text-sm text-muted-foreground ">
        Session not available for this run
      </div>
    );
  }

  return (
    <ChatPage
      sessionId={selectedSessionId}
      runStatus={run.status}
      workbenchHeaderSlot={phaseNavigator}
      readOnlySession={isReviewingHistoricalPhase}
      syncSessionList={false}
    />
  );
}


