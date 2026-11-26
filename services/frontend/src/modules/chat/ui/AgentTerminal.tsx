import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAIChat } from '@modules/chat/model/AIChatContext';
import { Terminal } from 'lucide-react';
import { cn } from '@shared/lib/utils';
import './AgentTerminal.css';

interface AgentTerminalProps {
  toolName?: string;
  className?: string;
}

const formatTimelineTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

const PULSE_FRAMES = ['Receiving stream', 'Receiving stream.', 'Receiving stream..', 'Receiving stream...'];

const compactTimelineText = (value: string | undefined, maxLength = 180): string => {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
};

// Simplified, more professional prompt
const ShellPrompt: React.FC<{ command?: string; cursor?: boolean }> = ({ command, cursor = false }) => (
  <div className="font-mono text-[11px] leading-relaxed select-none">
    <div className="flex items-center gap-2 mb-0.5">
      <span className="text-foreground/80 font-bold tracking-wider">root@null-ai</span>
      <span className="text-muted-foreground/40">:</span>
      <span className="text-foreground/60 font-medium">~/workspace</span>
    </div>
    <div className="flex items-start">
      <span className="text-foreground/40 font-bold flex-shrink-0">$ </span>
      <div className="flex-1 min-w-0 flex items-center flex-wrap gap-1">
        {command && (
          <span className="text-foreground/90 break-all leading-relaxed ml-1">{command}</span>
        )}
        {cursor && (
          <span className="inline-block w-1.5 h-3 bg-primary ns-live-mark ml-0.5" />
        )}
      </div>
    </div>
  </div>
);

const AgentTerminal: React.FC<AgentTerminalProps> = ({
  toolName,
  className = '',
}) => {
  const { toolStreams, sessionId, condition, activity, readOnlySession } = useAIChat();
  const [pulseIndex, setPulseIndex] = useState(0);

  const selectedToolName = useMemo(() => {
    if (toolName && toolStreams[toolName]) {
      return toolName;
    }
    const streams = Object.values(toolStreams);
    if (streams.length === 0) return toolName;
    const running = streams.find((s) => s.status === 'running');
    if (running) return running.name;
    return streams.slice().sort((a, b) => b.lastUpdated - a.lastUpdated)[0]?.name;
  }, [toolName, toolStreams]);

  const streamState = selectedToolName ? toolStreams[selectedToolName] : undefined;
  const outputRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!outputRef.current) return;
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [streamState?.chunks]);

  const streamLines = useMemo(() => {
    if (!streamState?.chunks.length) return [];
    return streamState.chunks.join('').split(/\r?\n/);
  }, [streamState?.chunks]);

  const historicalLines = useMemo(() => {
    if (!readOnlySession) return [];
    return (activity ?? []).slice(-80).flatMap((entry) => {
      const header = `[timeline] ${formatTimelineTime(entry.ts)} ${entry.kind}/${entry.status}: ${entry.title}`;
      const detail = compactTimelineText(entry.detail);
      return detail ? [header, `  ${detail}`] : [header];
    });
  }, [activity, readOnlySession]);
  const lines = streamLines.length > 0 ? streamLines : historicalLines;

  const isExecutionActive = condition === 'executing' || condition === 'recovering' || streamState?.status === 'running';
  const command =
    streamState?.command ??
    (selectedToolName ? selectedToolName : undefined) ??
    (readOnlySession && historicalLines.length > 0 ? 'phase_history' : undefined);


  useEffect(() => {
    if (!isExecutionActive) {
      setPulseIndex(0);
      return;
    }
    const intervalId = window.setInterval(() => {
      setPulseIndex((current) => (current + 1) % PULSE_FRAMES.length);
    }, 400);
    return () => window.clearInterval(intervalId);
  }, [isExecutionActive]);

  return (
    <div
      className={cn(
        "flex h-full w-full min-w-0 flex-1 flex-col overflow-hidden border border-border/60 bg-card",
        className,
      )}
      data-testid="terminal"
      data-status={condition.toUpperCase()}
    >
      {/* Terminal Header */}
      <div className="flex items-center justify-between px-5 py-2 border-b border-border/60 bg-muted/30">
        <div className="flex items-center gap-2">
          <Terminal className="h-3 w-3 text-muted-foreground" />
          <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
            Ops Console
          </span>
        </div>
        <div className="flex items-center gap-4">
           {sessionId && (
             <span className="text-[9px] font-mono text-muted-foreground/40 tabular-nums uppercase tracking-widest">
               #{sessionId.slice(0, 8)}
             </span>
           )}
           <div className="flex items-center gap-2">
              <div className={cn(
                "h-2 w-2",
                isExecutionActive ? "bg-primary ns-live-mark" : "bg-muted-foreground/20"
              )} />
              <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                {isExecutionActive ? 'Active' : 'Idle'}
              </span>
           </div>
        </div>
      </div>

      {/* Terminal Body */}
      <div
        ref={outputRef}
        className="flex-1 overflow-y-auto overflow-x-hidden p-5 no-scrollbar bg-surface-1/70"
      >
        <div className="space-y-0.5">
          {/* Prompt + command */}
          {(command || sessionId) && (
            <div className="mb-4">
              <ShellPrompt command={command} cursor={isExecutionActive && lines.length === 0} />
            </div>
          )}

          {/* Output lines */}
          {lines.map((line, index) => {
            const trimmed = line.replace(/\r$/, '');

            if (!trimmed) {
              return <div key={`line-${index}`} className="h-2" />;
            }

            if (trimmed.startsWith('[stderr]')) {
              const text = trimmed.slice('[stderr]'.length).trimStart();
              return (
                <div key={`line-${index}`} className="font-mono text-[11px] leading-[1.6] text-muted-foreground/70">
                  <span className="text-muted-foreground/40 mr-2 text-[10px] font-bold">stderr</span>
                  {text}
                </div>
              );
            }

            if (trimmed.startsWith('[error]')) {
              const text = trimmed.slice('[error]'.length).trimStart();
              return (
                <div key={`line-${index}`} className="font-mono text-[11px] leading-[1.6] text-destructive/80">
                  <span className="text-destructive/40 mr-2 text-[10px] font-bold">error</span>
                  {renderAnsiSegments(text)}
                </div>
              );
            }

            return (
              <div key={`line-${index}`} className="font-mono text-[11px] leading-[1.6] text-foreground/70 whitespace-pre-wrap break-all">
                {renderAnsiSegments(trimmed)}
              </div>
            );
          })}

          {/* Idle prompt with cursor after output completes */}
          {!isExecutionActive && sessionId && lines.length > 0 && (
            <div className="mt-4 opacity-50">
              <ShellPrompt cursor />
            </div>
          )}

          {readOnlySession && sessionId && lines.length === 0 && !isExecutionActive && (
            <div className="font-mono text-[10px] text-muted-foreground/30 mt-8 tracking-widest uppercase text-center">
              No historical terminal logs
            </div>
          )}

          {isExecutionActive && (
            <div className="mt-6 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.2em] text-primary/60">
              <span className="h-2 w-2 shrink-0 bg-primary ns-live-mark" />
              <span>{PULSE_FRAMES[pulseIndex]}</span>
            </div>
          )}

          {!sessionId && (
            <div className="font-mono text-[10px] text-muted-foreground/20 mt-8 tracking-widest uppercase text-center">
              No active session
            </div>
          )}

          <div className="h-4" />
        </div>
      </div>
    </div>
  );
};

const renderAnsiSegments = (input: string): React.ReactNode[] => {
  // eslint-disable-next-line no-control-regex
  const ANSI_PATTERN = new RegExp('\\x1B\\[([0-9;]*)m', 'g');
  const segments: React.ReactNode[] = [];
  let lastIndex = 0;
  let currentClasses: string[] = [];
  let match: RegExpExecArray | null;

  const pushText = (text: string) => {
    if (!text) return;
    segments.push(
      <span key={`${segments.length}-${currentClasses.join('-')}`} className={currentClasses.join(' ')}>
        {text}
      </span>
    );
  };

  while ((match = ANSI_PATTERN.exec(input)) !== null) {
    pushText(input.slice(lastIndex, match.index));
    lastIndex = ANSI_PATTERN.lastIndex;
    const codes = match[1]?.split(';').filter(Boolean) ?? [];
    for (const code of codes) {
      if (code === '0') { currentClasses = []; continue; }
      if (code === '1') { if (!currentClasses.includes('ansi-bold')) currentClasses.push('ansi-bold'); continue; }
      const colorClass = ansiCodeToClass(code);
      if (colorClass) {
        currentClasses = currentClasses.filter((c) => c === 'ansi-bold');
        currentClasses.push(colorClass);
      }
    }
  }

  pushText(input.slice(lastIndex));
  return segments;
};

const ansiCodeToClass = (code: string): string | undefined => {
  const map: Record<string, string> = {
    '30': 'ansi-black',   '31': 'ansi-red',          '32': 'ansi-green',
    '33': 'ansi-yellow',  '34': 'ansi-blue',          '35': 'ansi-magenta',
    '36': 'ansi-cyan',    '37': 'ansi-white',          '90': 'ansi-bright-black',
    '91': 'ansi-bright-red', '92': 'ansi-bright-green', '93': 'ansi-bright-yellow',
    '94': 'ansi-bright-blue', '95': 'ansi-bright-magenta', '96': 'ansi-bright-cyan',
    '97': 'ansi-bright-white',
  };
  return map[code];
};

export default AgentTerminal;
