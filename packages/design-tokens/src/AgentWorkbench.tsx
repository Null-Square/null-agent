import * as React from 'react';
import {
  PanelRight,
  PanelRightClose,
} from 'lucide-react';

import { cn } from './cn';

export type AgentWorkbenchTone = 'active' | 'paused' | 'error' | 'idle' | 'stopping';

export interface AgentWorkbenchShellProps {
  modeLabel: string;
  statusLabel: string;
  statusTone: AgentWorkbenchTone;
  readOnly?: boolean;
  counterLabel?: string;
  counterValue?: React.ReactNode;
  contextUsage?: {
    used: number;
    total: number;
  };
  headerMeta?: React.ReactNode;
  headerActions?: React.ReactNode;
  taskTitle: string;
  sessionId?: string;
  phaseRail?: React.ReactNode;
  transcript: React.ReactNode;
  opsConsole: React.ReactNode;
  plan: React.ReactNode;
  opsActivityToken?: string | number;
  defaultOpsOpen?: boolean;
  className?: string;
}

const toneClass: Record<AgentWorkbenchTone, string> = {
  active: 'ns-agent-workbench__status--active',
  paused: 'ns-agent-workbench__status--paused',
  error: 'ns-agent-workbench__status--error',
  idle: 'ns-agent-workbench__status--idle',
  stopping: 'ns-agent-workbench__status--stopping',
};

export const AgentWorkbenchShell: React.FC<AgentWorkbenchShellProps> = ({
  modeLabel,
  statusLabel,
  statusTone,
  readOnly = false,
  counterLabel = 'prompts',
  counterValue,
  contextUsage,
  headerMeta,
  headerActions,
  taskTitle,
  sessionId,
  phaseRail,
  transcript,
  opsConsole,
  plan,
  opsActivityToken,
  defaultOpsOpen = true,
  className,
}) => {
  const [isOpsOpen, setIsOpsOpen] = React.useState(() =>
    typeof window === 'undefined' || window.innerWidth >= 1024
      ? defaultOpsOpen
      : false);

  React.useEffect(() => {
    if (!opsActivityToken || typeof window === 'undefined' || window.innerWidth < 1024) return;
    setIsOpsOpen(true);
  }, [opsActivityToken]);

  const contextPercent = contextUsage && contextUsage.total > 0
    ? Math.min(100, Math.round((contextUsage.used / contextUsage.total) * 100))
    : undefined;

  return (
    <section className={cn('ns-agent-workbench', className)}>
      <div className="ns-agent-workbench__backdrop" aria-hidden="true" />
      <header className="ns-agent-workbench__toolbar">
        <div className="ns-agent-workbench__toolbar-group">
          <span
            className={cn('ns-agent-workbench__status', toneClass[statusTone])}
            title={statusLabel}
          >
            <i aria-hidden="true" />
            <b>{modeLabel}</b>
          </span>
          {readOnly ? <span className="ns-agent-workbench__readonly">Read-only</span> : null}
          {counterValue !== undefined ? (
            <span className="ns-agent-workbench__counter">
              {counterValue} {counterLabel}
            </span>
          ) : null}
          {contextPercent !== undefined ? (
            <span
              className="ns-agent-workbench__context"
              title={`Context: ${contextUsage!.used.toLocaleString()} / ${contextUsage!.total.toLocaleString()} tokens`}
            >
              <b>CTX</b>
              <i><span style={{ width: `${contextPercent}%` }} /></i>
            </span>
          ) : null}
        </div>

        <div className="ns-agent-workbench__toolbar-group ns-agent-workbench__toolbar-group--right">
          {headerMeta ? <div className="ns-agent-workbench__meta">{headerMeta}</div> : null}
          {headerActions ? <div className="ns-agent-workbench__actions">{headerActions}</div> : null}
          <button
            type="button"
            className={cn('ns-agent-workbench__ops-toggle', isOpsOpen && 'is-open')}
            onClick={() => setIsOpsOpen((current) => !current)}
            aria-pressed={isOpsOpen}
          >
            {isOpsOpen
              ? <PanelRightClose size={13} aria-hidden="true" />
              : <PanelRight size={13} aria-hidden="true" />}
            Ops
          </button>
        </div>
      </header>

      <div className={cn(
        'ns-agent-workbench__grid',
        isOpsOpen && 'ns-agent-workbench__grid--with-ops',
      )}>
        <section className="ns-agent-workbench__transcript-frame">
          {phaseRail ? <div className="ns-agent-workbench__phase-bar">{phaseRail}</div> : null}
          <div className="ns-agent-workbench__transcript">{transcript}</div>
        </section>

        {isOpsOpen ? (
          <aside className="ns-agent-workbench__ops-frame">
            <header className="ns-agent-workbench__ops-heading">
              <span>{taskTitle}</span>
              <small title={sessionId}>{sessionId ? `#${sessionId.slice(0, 8)}` : '—'}</small>
            </header>
            <div className="ns-agent-workbench__ops-console">{opsConsole}</div>
            <div className="ns-agent-workbench__plan">{plan}</div>
          </aside>
        ) : null}
      </div>
    </section>
  );
};

export type AgentWorkbenchPhaseStatus =
  | 'completed'
  | 'running'
  | 'failed'
  | 'skipped'
  | 'pending';

export interface AgentWorkbenchPhaseItem {
  id: string;
  label: string;
  status: AgentWorkbenchPhaseStatus;
  selectable?: boolean;
  selected?: boolean;
  active?: boolean;
}

export interface AgentWorkbenchPhaseRailProps {
  phases: AgentWorkbenchPhaseItem[];
  onSelect?: (phaseId: string) => void;
  trailing?: React.ReactNode;
  className?: string;
}

export const AgentWorkbenchPhaseRail: React.FC<AgentWorkbenchPhaseRailProps> = ({
  phases,
  onSelect,
  trailing,
  className,
}) => (
  <div className={cn('ns-agent-phase-rail', className)}>
    <div className="ns-agent-phase-rail__steps">
      {phases.map((phase, index) => (
        <React.Fragment key={phase.id}>
          {index > 0 ? <span className="ns-agent-phase-rail__separator">/</span> : null}
          <button
            type="button"
            disabled={phase.selectable === false}
            className={cn(
              'ns-agent-phase-rail__step',
              `is-${phase.status}`,
              phase.selected && 'is-selected',
            )}
            onClick={() => onSelect?.(phase.id)}
            aria-label={phase.selectable === false
              ? `${phase.label} phase unavailable`
              : `Open ${phase.label} phase`}
          >
            {phase.status === 'running' ? <i aria-label="Live phase" /> : null}
            <span>{phase.label}</span>
          </button>
        </React.Fragment>
      ))}
    </div>
    {trailing ? <div className="ns-agent-phase-rail__trailing">{trailing}</div> : null}
  </div>
);
