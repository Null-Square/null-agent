import { Children, isValidElement, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import {
  Activity,
  AlertCircle,
  Terminal,
  User,
  AlertTriangle,
  XCircle,
  ShieldCheck,
} from 'lucide-react';
import { CellIcon } from '@null-ai/design-tokens/ui';
import { cn } from '@shared/lib/utils';
import { useAIChat } from '@modules/chat/model/AIChatContext';
import { metrics } from '@shared/lib/metrics';
import { MermaidDiagram } from '@shared/ui/MermaidDiagram';

type ChatStreamVariant = 'terminal' | 'clean';
const markdownPlugins = [remarkGfm, remarkBreaks];

const isMermaidBlock = (className?: string): boolean => /\blanguage-mermaid\b/.test(className ?? '');

const isMermaidElement = (value: unknown): boolean =>
  isValidElement<{ 'data-chat-mermaid-block'?: string }>(value) &&
  value.props['data-chat-mermaid-block'] === 'true';

const terminalMarkdownComponents: Components = {
  p: ({ node: _node, ...props }) => <p className="mb-2 break-words leading-relaxed text-foreground/90 font-mono text-[12px]" {...props} />,
  h1: ({ node: _node, ...props }) => (
    <h1 className="mt-4 mb-2 border-b border-border/40 pb-1 text-xs font-bold uppercase tracking-wider text-foreground font-mono" {...props} />
  ),
  h2: ({ node: _node, ...props }) => (
    <h2 className="mt-3 mb-2 text-[11px] font-bold uppercase tracking-wider text-foreground font-mono" {...props} />
  ),
  h3: ({ node: _node, ...props }) => (
    <h3 className="mt-2 mb-1 text-[10px] font-bold uppercase tracking-wider text-foreground font-mono" {...props} />
  ),
  ul: ({ node: _node, ...props }) => <ul className="mb-2 ml-4 list-disc space-y-1 text-foreground/80 font-mono text-[12px]" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="mb-2 ml-4 list-decimal space-y-1 text-foreground/80 font-mono text-[12px]" {...props} />,
  li: ({ node: _node, ...props }) => <li className="break-words" {...props} />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-foreground/70 italic font-mono text-[12px]" {...props} />
  ),
  code: ({ node: _node, className, children, ...props }) => {
    if (isMermaidBlock(className)) {
      return (
        <div data-chat-mermaid-block="true" className="not-prose my-2">
          <MermaidDiagram chart={String(children).replace(/\n$/, '')} />
        </div>
      );
    }
    return (
      <code
        className="rounded-none border border-border/60 bg-muted/65 px-1.5 py-0.5 text-[11px] text-foreground font-mono"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ node: _node, children, ...props }) => {
    const firstChild = Children.toArray(children)[0];
    if (isMermaidElement(firstChild)) {
      return <>{children}</>;
    }
    return (
      <pre
        className="my-3 overflow-x-auto rounded-none border-l-2 border-border py-3 pl-4.5 text-[11px] leading-relaxed text-foreground font-mono"
        {...props}
      >
        {children}
      </pre>
    );
  },
  strong: ({ node: _node, ...props }) => <strong className="font-bold text-foreground font-mono" {...props} />,
  em: ({ node: _node, ...props }) => <em className="text-foreground/90 italic font-mono" {...props} />,
  a: ({ node: _node, ...props }) => (
    <a className="text-foreground underline transition-colors hover:text-foreground/70 font-mono" {...props} />
  ),
};

const cleanMarkdownComponents: Components = {
  p: ({ node: _node, ...props }) => (
    <p className="mb-4 break-words text-[14.5px] leading-[1.7] text-foreground/90 last:mb-0" {...props} />
  ),
  // One step down per level, all on the sans face — an assistant answer is
  // prose, so its headings are the same ladder the detail pages use.
  h1: ({ node: _node, ...props }) => (
    <h1 className="mb-3 mt-8 border-t border-border pt-6 text-[15px] font-extrabold uppercase tracking-[0.04em] text-foreground first:mt-0 first:border-t-0 first:pt-0" {...props} />
  ),
  h2: ({ node: _node, ...props }) => (
    <h2 className="mb-3 mt-7 text-[14px] font-bold text-foreground" {...props} />
  ),
  h3: ({ node: _node, ...props }) => (
    <h3 className="mb-2 mt-6 text-[13.5px] font-semibold text-foreground" {...props} />
  ),
  ul: ({ node: _node, ...props }) => (
    <ul className="mb-4 ml-5 list-disc space-y-2 text-[14.5px] text-foreground/90 marker:text-muted-foreground" {...props} />
  ),
  ol: ({ node: _node, ...props }) => (
    <ol className="mb-4 ml-5 list-decimal space-y-2 text-[14.5px] text-foreground/90 marker:font-mono marker:text-muted-foreground" {...props} />
  ),
  li: ({ node: _node, ...props }) => <li className="break-words pl-1 leading-[1.7]" {...props} />,
  // A quote is a seam, and it keeps the reader's own type size rather than
  // shrinking and italicising into a footnote.
  blockquote: ({ node: _node, ...props }) => (
    <blockquote className="my-4 border-l-2 border-border py-1 pl-4 text-[14px] leading-[1.7] text-muted-foreground" {...props} />
  ),
  hr: () => <hr className="my-6 border-t border-border" />,
  // GFM is on, so tables arrive. They had no styling at all and rendered as
  // run-together text; this is the same treatment as the one data table.
  table: ({ node: _node, ...props }) => (
    <div className="scrollbar-slim my-5 overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13.5px]" {...props} />
    </div>
  ),
  thead: ({ node: _node, ...props }) => <thead className="border-b border-border" {...props} />,
  th: ({ node: _node, ...props }) => (
    <th className="px-3 py-2 text-[13px] font-medium text-muted-foreground first:pl-0" {...props} />
  ),
  td: ({ node: _node, ...props }) => (
    <td className="border-b border-border/60 px-3 py-2.5 align-top text-foreground/90 first:pl-0" {...props} />
  ),
  code: ({ node: _node, className, children, ...props }) => {
    if (isMermaidBlock(className)) {
      return (
        <div data-chat-mermaid-block="true" className="not-prose my-5">
          <MermaidDiagram chart={String(children).replace(/\n$/, '')} />
        </div>
      );
    }
    return (
      <code className="bg-elevated px-1.5 py-0.5 font-mono text-[13px] text-foreground" {...props}>
        {children}
      </code>
    );
  },
  pre: ({ node: _node, children, ...props }) => {
    const firstChild = Children.toArray(children)[0];
    if (isMermaidElement(firstChild)) {
      return <>{children}</>;
    }
    return (
      <pre
        className="scrollbar-slim my-5 overflow-x-auto border border-border bg-surface-inset p-4 font-mono text-[12.5px] leading-[1.9] text-foreground"
        {...props}
      >
        {children}
      </pre>
    );
  },
  strong: ({ node: _node, ...props }) => <strong className="font-semibold text-foreground" {...props} />,
  em: ({ node: _node, ...props }) => <em className="italic text-foreground/90" {...props} />,
  a: ({ node: _node, ...props }) => (
    <a
      className="text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground/60"
      target="_blank"
      rel="noreferrer noopener"
      {...props}
    />
  ),
};

const WORKING_STATUSES = [
  'Aggregating security telemetry...',
  'Correlating vulnerability data...',
  'Evaluating attack surface...',
  'Formulating remediation strategy...',
  'Analyzing network footprint...',
  'Reviewing prior risks...',
  'Synthesizing mission plan...',
];

const WorkingIndicator: React.FC<{ variant?: ChatStreamVariant }> = ({ variant = 'terminal' }) => {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setIndex((prev) => (prev + 1) % WORKING_STATUSES.length);
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  if (variant === 'clean') {
    return (
      <div className="mb-10 flex w-full justify-start animate-in fade-in duration-300">
        <div className="w-full max-w-4xl px-4 flex gap-3">
          <div className="h-8 w-8 border border-border bg-muted/20 flex items-center justify-center shrink-0 mt-1 select-none">
            <span className="h-2.5 w-2.5 bg-primary ns-live-mark" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="mb-1.5 flex items-center gap-2 text-[9px] uppercase tracking-widest text-foreground/70 font-mono font-bold">
              <span>Security Assistant</span>
              <span>•</span>
              <span className="text-muted-foreground/60 font-normal">Processing</span>
            </div>
            <div className="text-[12px] font-mono tracking-wider text-muted-foreground/65 select-none">
              &gt;&gt; {WORKING_STATUSES[index]}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group mb-8 w-full max-w-3xl mx-auto animate-in fade-in duration-500">
      <div className="mb-3 flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest">
        <span className="h-2 w-2 shrink-0 bg-primary ns-live-mark" />
        <span className="font-bold text-primary">System Active</span>
      </div>
      <div className="relative overflow-hidden border-l-2 border-border bg-muted/10 p-4 transition-all">
        <div className="flex items-center gap-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center border border-border bg-muted/20">
             <span className="h-2.5 w-2.5 bg-primary ns-live-mark" />
          </div>
          <div className="flex-1 min-w-0">
             <div className="font-mono text-[11px] text-foreground font-bold uppercase tracking-widest mb-1 truncate">
                Agent Processing
             </div>
             <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest truncate">
               {WORKING_STATUSES[index]}
             </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const TerminalStateIndicator: React.FC<{
  variant?: ChatStreamVariant;
  sessionStatus?: string | null;
  runStatus?: string | null;
}> = ({ variant, sessionStatus, runStatus }) => {
  if (variant === 'clean') return null;

  const isFailed = sessionStatus === 'failed' || runStatus === 'failed' || sessionStatus === 'error';
  const isCompleted = sessionStatus === 'completed' || runStatus === 'completed';
  const isPaused = sessionStatus === 'paused' || runStatus === 'paused';
  const isCancelled = sessionStatus === 'cancelled' || runStatus === 'cancelled' || sessionStatus === 'aborted' || runStatus === 'aborted';

  if (!isFailed && !isCompleted && !isPaused && !isCancelled) return null;

  let colorClass = '';
  let title = '';
  let description = '';
  let Icon = AlertCircle;

  if (isFailed) {
    colorClass = 'border-destructive/20 bg-destructive/5 text-destructive';
    title = 'Execution Failed';
    description = 'The agent encountered an unrecoverable error.';
    Icon = AlertCircle;
  } else if (isCancelled) {
    colorClass = 'border-border bg-muted/20 text-muted-foreground';
    title = 'Execution Cancelled';
    description = 'The operation was aborted by the operator.';
    Icon = XCircle;
  } else if (isCompleted) {
    colorClass = 'border-success/20 bg-success/5 text-success';
    title = 'Mission Completed';
    description = 'All objectives have been successfully executed.';
    Icon = ShieldCheck;
  } else if (isPaused) {
    colorClass = 'border-warning/20 bg-warning/5 text-warning';
    title = 'System Paused';
    description = 'Execution suspended. Awaiting manual resume.';
    Icon = AlertTriangle;
  }

  return (
    <div className="group mb-8 w-full max-w-3xl mx-auto animate-in fade-in zoom-in-95 duration-500">
      <div className={`relative overflow-hidden border-l-2 ${colorClass} p-4`}>
        <div className="flex items-center gap-4">
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center bg-current/10`}>
             <Icon className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
             <div className="font-mono text-[11px] font-bold uppercase tracking-widest mb-1 truncate">
                {title}
             </div>
             <div className="font-mono text-[10px] opacity-80 uppercase tracking-widest truncate">
               {description}
             </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const formatTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

const compactText = (value: string | undefined, maxLength = 220): string => {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
};

interface ChatStreamTerminalProps {
  showUserMessages?: boolean;
  emptyStateTitle?: string;
  emptyStateDescription?: string;
  variant?: ChatStreamVariant;
  scopeLabel?: string | null;
}

const ChatStreamTerminal: React.FC<ChatStreamTerminalProps> = ({
  showUserMessages = true,
  emptyStateTitle = 'Live Agent Monitor',
  emptyStateDescription = 'Waiting for the first agent message.',
  variant = 'terminal',
  scopeLabel = null,
}) => {
  const renderStart = performance.now();
  const {
    messages,
    isLoading,
    sessionStatus,
    toolStreams,
    runStatus,
    activity,
    readOnlySession,
  } = useAIChat();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const markdownComponents = variant === 'clean' ? cleanMarkdownComponents : terminalMarkdownComponents;
  const hasRunningToolStream = useMemo(
    () => Object.values(toolStreams ?? {}).some((stream) => stream.status === 'running'),
    [toolStreams],
  );
  const sessionStatusIsAuthoritative = Boolean(sessionStatus && sessionStatus !== 'idle');
  const terminalRunStatus = sessionStatusIsAuthoritative ? null : runStatus;
  const canShowPausedTerminalState = !readOnlySession;
  const isTerminalState =
    sessionStatus === 'completed' ||
    sessionStatus === 'failed' ||
    (canShowPausedTerminalState && sessionStatus === 'paused') ||
    terminalRunStatus === 'completed' ||
    terminalRunStatus === 'failed' ||
    terminalRunStatus === 'cancelled' ||
    (canShowPausedTerminalState && terminalRunStatus === 'paused');
  const showWorkingIndicator = !isTerminalState && (isLoading || sessionStatus === 'running' || hasRunningToolStream);

  const displayMessages = useMemo(() => {
    const result: typeof messages = [];
    for (const msg of messages) {
      if (msg.metadata?.visibility === 'internal') continue;
      if (!showUserMessages && msg.role === 'user') continue;
      if (msg.role === 'tool') continue;
      const content = (msg.content || '').trim();
      if (msg.role === 'assistant' && !content) continue;
      if (msg.role !== 'assistant' && msg.role !== 'user' && msg.role !== 'system') continue;

      const nextMessage = { ...msg, content };
      const previous = result[result.length - 1];
      if (previous && previous.role === nextMessage.role && previous.content === nextMessage.content) {
        result[result.length - 1] = nextMessage;
        continue;
      }
      result.push(nextMessage);
    }
    return result;
  }, [messages, showUserMessages]);
  const hasContent = displayMessages.length > 0;
  const historicalEntries = useMemo(
    () => (readOnlySession ? (activity ?? []).slice(-24) : []),
    [activity, readOnlySession],
  );
  const hasHistoricalData = !hasContent && historicalEntries.length > 0;

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    anchor.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [displayMessages.length, isLoading]);

  useEffect(() => {
    metrics.trackRender('ChatStreamTerminal', performance.now() - renderStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderMessage = (message: (typeof messages)[number]) => {
    const timestamp =
      message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp);
    const timeLabel = formatTime(timestamp.getTime());

    if (message.role === 'user') {
      if (variant === 'clean') {
        return (
          <div className="mb-10 flex w-full justify-end animate-in fade-in duration-300">
            <div className="w-full max-w-3xl px-4 flex justify-end gap-3">
              <div className="flex-1 min-w-0 text-right">
                <div className="mb-1.5 flex items-center justify-end gap-2.5 text-[12px] text-muted-foreground">
                  <span className="font-semibold text-foreground">You</span>
                  <span aria-hidden className="text-muted-foreground/40">·</span>
                  <span className="font-mono tabular-nums">{timeLabel}</span>
                </div>
                <div className="inline-block max-w-[85%] whitespace-pre-wrap border-r-2 border-border py-1 pr-4 text-left text-[14.5px] leading-relaxed text-foreground">
                  {message.content}
                </div>
              </div>
              {/* The glyph, not a glyph in a box — the message is the surface. */}
              <CellIcon name="members" size={24} className="mt-0.5 shrink-0 select-none text-muted-foreground" />
            </div>
          </div>
        );
      }

      return (
        <div className="group mb-8 w-full max-w-3xl mx-auto">
          <div className="mb-2 flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            <User className="h-3.5 w-3.5" />
            <span className="font-bold text-foreground">OPERATOR OVERRIDE</span>
            <span>[{timeLabel}]</span>
          </div>
          <div className="transition-all">
            <div className="flex items-start gap-4">
              <span className="flex-shrink-0 text-lg font-black text-muted-foreground">&gt;&gt;&gt;</span>
              <div className="flex-1 break-words whitespace-pre-wrap pt-1 leading-relaxed text-foreground/90 font-mono text-sm">
                {message.content}
              </div>
            </div>
          </div>
          {message.status && message.status !== 'sent' ? (
            <div className="mt-2 text-right text-[10px] uppercase font-bold tracking-widest">
              <span className={message.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}>
                {message.status === 'error' ? '! TRANSMISSION ERROR' : '~ TRANSMITTING SYSTEM OVERRIDE'}
              </span>
            </div>
          ) : null}
        </div>
      );
    }

    if (message.role === 'assistant') {
      if (variant === 'clean') {
        return (
          <div className="mb-10 flex w-full justify-start animate-in fade-in slide-in-from-bottom-2 duration-500">
            <div className="w-full max-w-4xl px-4 flex gap-3">
              <CellIcon name="chat" size={24} className="mt-0.5 shrink-0 select-none text-foreground" />
              <div className="flex-1 min-w-0">
                <div className="mb-1.5 flex items-center gap-2.5 text-[12px] text-muted-foreground">
                  <span className="font-semibold text-foreground">Null</span>
                  <span aria-hidden className="text-muted-foreground/40">·</span>
                  <span className="font-mono tabular-nums">{timeLabel}</span>
                </div>
                <div className="max-w-none break-words text-[13.5px] leading-[1.75] text-foreground selection:bg-primary/20">
                  <ReactMarkdown remarkPlugins={markdownPlugins} components={markdownComponents}>
                    {message.content}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          </div>
        );
      }

      return (
        <div className="group mb-8 w-full max-w-3xl mx-auto">
          <div className="mb-2 flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-muted-foreground transition-colors group-hover:text-foreground">
            <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-bold text-foreground">NULL AI AGENT</span>
            <span>[{timeLabel}]</span>
          </div>
          <div className="transition-all">
            <div className="flex items-start gap-4">
              <span className="flex-shrink-0 text-lg font-black text-muted-foreground">$</span>
              <div className="min-w-0 flex-1 break-words leading-relaxed text-muted-foreground text-sm max-w-none">
                <ReactMarkdown remarkPlugins={markdownPlugins} components={markdownComponents}>
                  {message.content}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (message.role === 'system' || message.metadata?.isError) {
      if (variant === 'clean') {
        return (
          <div className="mb-6 w-full max-w-3xl">
            <div className="rounded-none border-l-2 border-destructive/50 bg-destructive/5 px-5 py-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
                <div>
                  <div className="text-sm font-medium text-destructive">System notice</div>
                  <div className="mt-1 text-sm leading-6 text-destructive/90">{message.content}</div>
                </div>
              </div>
            </div>
          </div>
        );
      }

      return (
        <div className="mb-8 w-full max-w-3xl mx-auto">
          <div className="relative border-l-2 border-destructive/50 bg-destructive/5 p-4 transition-all">
            <div className="flex items-start gap-4">
              <AlertCircle className="mt-1 h-5 w-5 flex-shrink-0 text-destructive" />
              <div className="flex-1">
                <div className="mb-1 flex items-center gap-2 text-[10px] font-mono font-black uppercase tracking-[0.2em] text-destructive">
                  <span>! PROTOCOL BREACH / SYSTEM ALERT</span>
                </div>
                <div className="break-words font-mono text-sm leading-relaxed text-destructive font-medium">
                    {message.content}
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }


    return null;
  };

  function ChatEmptyState({ scopeId }: { scopeId: string | null }) {
    if (variant === 'clean') {
      return (
        <div className="flex flex-1 flex-col items-center justify-center px-8 py-32 text-center animate-in fade-in slide-in-from-bottom-4 duration-1000">
          <div className="h-px w-16 bg-border/30 mb-10" />
          <h3 className="text-3xl sm:text-4xl font-semibold tracking-tight text-foreground">
             Ask Your Assistant
          </h3>
          <p className="mt-5 max-w-md text-[15px] leading-7 text-muted-foreground/60">
            Query risks, assets, prior runs, techniques tried, and rules of engagement. The assistant reads from your platform context.
          </p>
        </div>
      );
    }

    return (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="p-4 bg-muted/30 border border-border/40 mb-6">
                 <Activity className="h-6 w-6 text-muted-foreground" />
            </div>
            
            <h3 className="text-sm font-bold uppercase tracking-widest text-foreground mb-2">
                {emptyStateTitle}
            </h3>
            
            <p className="max-w-md text-xs text-muted-foreground font-mono leading-relaxed space-y-2">
                {emptyStateDescription}<br/>
                Scope target: <span className="text-foreground">{scopeId || 'Global'}</span>
            </p>
        </div>
    );
  }

  function HistoricalPhaseHistory() {
    return (
      <div className="mx-auto flex h-full max-w-5xl flex-col justify-center gap-5 px-2 py-4">
        <div>
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.24em] text-foreground">
            Phase History
          </div>
          <p className="max-w-3xl font-mono text-xs leading-relaxed text-muted-foreground">
            No visible chat transcript was recorded for this phase. Showing persisted timeline records instead.
          </p>
        </div>

        {historicalEntries.length > 0 ? (
          <div className="rounded-none border border-border/60 bg-background/45">
            <div className="border-b border-border/50 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Timeline
            </div>
            <div className="max-h-[360px] overflow-y-auto p-3">
              <div className="space-y-2">
                {historicalEntries.map((entry) => (
                  <div key={entry.id} className="grid gap-1 border-l border-border/70 pl-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground/60">
                        {formatTime(entry.ts)}
                      </span>
                      <span className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
                        {entry.kind}
                      </span>
                      <span className={cn(
                        'shrink-0 font-mono text-[9px] uppercase tracking-[0.12em]',
                        entry.status === 'error' ? 'text-destructive' : entry.status === 'success' ? 'text-success' : 'text-muted-foreground',
                      )}>
                        {entry.status}
                      </span>
                    </div>
                    <div className="break-words text-sm font-medium text-foreground">
                      {entry.title}
                    </div>
                    {entry.detail ? (
                      <div className="break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
                        {compactText(entry.detail)}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn('relative h-full min-h-[280px] w-full', variant === 'clean' ? 'bg-transparent' : 'bg-background')}>
      <div
        className={cn(
          'custom-scrollbar relative z-30 h-full overflow-y-auto overflow-x-hidden',
          variant === 'clean' ? 'px-6 py-10 sm:px-10 md:px-12' : 'px-4 py-8 font-mono text-sm',
        )}
      >
        {hasContent ? (
          <div className={cn('mx-auto w-full', variant === 'clean' ? 'max-w-6xl' : 'max-w-7xl')}>
            {displayMessages.map((message) => (
              <div key={`message:${message.id}`}>
                {renderMessage(message)}
              </div>
            ))}
            {showWorkingIndicator && <WorkingIndicator variant={variant} />}
            {isTerminalState && <TerminalStateIndicator variant={variant} sessionStatus={sessionStatus} runStatus={terminalRunStatus} />}
          </div>
        ) : hasHistoricalData ? (
          <HistoricalPhaseHistory />
        ) : (
          <div className="flex flex-col h-full">
            <ChatEmptyState scopeId={scopeLabel} />
            {showWorkingIndicator && (
              <div className="px-4">
                <WorkingIndicator variant={variant} />
              </div>
            )}
            {isTerminalState && (
              <div className="px-4">
                <TerminalStateIndicator variant={variant} sessionStatus={sessionStatus} runStatus={terminalRunStatus} />
              </div>
            )}
          </div>
        )}
        <div ref={anchorRef} />
      </div>
    </div>
  );
};

export default ChatStreamTerminal;
