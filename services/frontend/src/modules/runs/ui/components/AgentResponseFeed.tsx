import { useQuery } from '@tanstack/react-query';
import { fetchSessionMessages } from '@modules/sessions/api/sessions';
import { ScrollArea, cn } from "@null-ai/design-tokens/ui";
import { 
  Bot, Activity, AlertTriangle, 
  Brain, Waypoints, Globe, Terminal, Code,
  FileText, CheckCircle2, Clock, Search, Send,
  ChevronDown, Wrench, BookOpen
} from "lucide-react";
import { useState } from 'react';

export interface AgentResponseFeedProps {
  sessionId?: string;
  className?: string;
  isTerminal?: boolean;
}

interface FeedMessage {
  id?: string;
  role: string;
  content?: string;
  timestamp?: number | string;
  createdAt?: number | string;
  toolName?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

// ─── Action Types ────────────────────────────────────────────────────────────

type ActionType = 
  | 'thinking' | 'spawning' | 'note' | 'task' | 'waiting' | 'completed'
  | 'browser' | 'terminal' | 'python' | 'http' | 'search' | 'skill'
  | 'tool' | 'broadcast';

interface TimelineAction {
  id: string;
  type: ActionType;
  label: string;       // Short badge label
  title: string;       // One-line title
  body?: string;       // Expandable body (code, output, reasoning)
  timestamp: number;
  collapsible: boolean; // True = start collapsed (very large output only)
}

const ACTION_ICONS: Record<ActionType, typeof Brain> = {
  thinking: Brain, spawning: Waypoints, note: FileText, task: CheckCircle2,
  waiting: Clock, completed: CheckCircle2, browser: Globe, terminal: Terminal,
  python: Code, http: Send, search: Search, skill: BookOpen,
  tool: Wrench, broadcast: Bot,
};

// Action type is a category the icon already identifies, so colour stays
// neutral (flatten to mono + label/icon). Only genuine state keeps a token:
// completed/spawning = success, broadcast = the live accent.
const ACTION_COLORS: Record<ActionType, string> = {
  thinking: 'text-muted-foreground', spawning: 'text-success', note: 'text-muted-foreground',
  task: 'text-muted-foreground', waiting: 'text-muted-foreground', completed: 'text-success',
  browser: 'text-muted-foreground', terminal: 'text-muted-foreground', python: 'text-muted-foreground',
  http: 'text-muted-foreground', search: 'text-muted-foreground', skill: 'text-muted-foreground',
  tool: 'text-muted-foreground', broadcast: 'text-primary',
};

// ─── JSON helpers ────────────────────────────────────────────────────────────

function tryParseJson(s: string): unknown | null {
  try {
    const trimmed = s.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 5) {
      return JSON.parse(trimmed);
    }
  } catch { /* not JSON */ }
  return null;
}

/** Extract a clean one-liner from a JSON tool response, or null to skip */
function summarizeJsonResponse(data: unknown, toolName: string): TimelineAction | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;

  // spawn_worker → Spawning event
  if (obj.task && typeof obj.task === 'object') {
    const task = obj.task as Record<string, unknown>;
    if (task.workerType || task.taskId) {
      if (toolName.includes('wait_for_worker')) {
        return {
          id: '', type: 'waiting', label: 'Waiting',
          title: `Waiting for ${String(task.workerType ?? 'worker').replace(/_worker$/u, '').replace(/_/gu, ' ')} worker`,
          body: task.lastStatusReason ? String(task.lastStatusReason) : undefined,
          timestamp: 0, collapsible: false,
        };
      }
      const wt = String(task.workerType ?? 'worker');
      const label = wt.replace(/_worker$/u, '').replace(/_/gu, ' ').replace(/\b\w/gu, (c: string) => c.toUpperCase());
      return {
        id: '', type: 'spawning', label: 'Spawning',
        title: `${label} Worker`,
        body: task.reason ? String(task.reason) : undefined,
        timestamp: 0, collapsible: false,
      };
    }
  }

  // Note/finding creation
  if (obj.noteId || obj.findingId) {
    return {
      id: '', type: 'note', label: 'Note',
      title: String(obj.title ?? obj.message ?? 'Note recorded'),
      body: obj.summary ? String(obj.summary) : undefined,
      timestamp: 0, collapsible: false,
    };
  }

  // Task/plan
  if (obj.success && (toolName.includes('task') || toolName.includes('plan') || toolName.includes('todo'))) {
    return {
      id: '', type: 'task', label: 'Task',
      title: String(obj.message ?? 'Task updated'),
      timestamp: 0, collapsible: false,
    };
  }

  // Generic silent success — skip entirely
  if (obj.success === true && Object.keys(obj).length <= 2) return null;
  
  // Unknown JSON — skip (internal plumbing)
  return null;
}

// ─── Main Classifier ─────────────────────────────────────────────────────────

function classifyMessage(msg: FeedMessage): TimelineAction | null {
  const content = (msg.content ?? '').trim();
  if (!content) return null;

  const ts = Number(msg.timestamp || msg.createdAt || Date.now());
  const id = msg.id || `msg-${ts}-${Math.random().toString(36).slice(2, 6)}`;
  const toolName = (msg.toolName ?? '').toLowerCase();

  // ── TOOL MESSAGES ──────────────────────────────────────────────────────
  if (msg.role === 'tool') {
    // Try JSON parse first
    const json = tryParseJson(content);
    if (json) {
      const summary = summarizeJsonResponse(json, toolName);
      if (!summary) return null; // Unknown JSON → skip
      return { ...summary, id, timestamp: ts };
    }

    // Non-JSON tool output — classify by tool name and show cleanly
    // Browser tools
    if (toolName.includes('browser') || toolName.includes('navigate') || toolName.includes('page') || toolName.includes('screenshot')) {
      return { id, type: 'browser', label: 'Browser', title: content.split('\n')[0], body: content.length > 120 ? content : undefined, timestamp: ts, collapsible: content.length > 600 };
    }
    // Terminal / command
    if (toolName.includes('terminal') || toolName.includes('command') || toolName.includes('bash') || toolName.includes('shell') || toolName.includes('exec')) {
      return { id, type: 'terminal', label: 'Terminal', title: content.split('\n')[0], body: content, timestamp: ts, collapsible: content.length > 600 };
    }
    // Python / code execution
    if (toolName.includes('python') || toolName.includes('code') || toolName.includes('script')) {
      return { id, type: 'python', label: 'Python', title: content.split('\n')[0], body: content, timestamp: ts, collapsible: content.length > 600 };
    }
    // HTTP requests
    if (toolName.includes('http') || toolName.includes('request') || toolName.includes('fetch') || toolName.includes('curl') || toolName.includes('send_request')) {
      return { id, type: 'http', label: 'Request', title: content.split('\n')[0], body: content.length > 120 ? content : undefined, timestamp: ts, collapsible: content.length > 600 };
    }
    // Search (web or proxy listing)
    if (toolName.includes('search') || toolName.includes('grep') || toolName.includes('list_requests') || toolName.includes('sitemap')) {
      return { id, type: 'search', label: 'Search', title: content.split('\n')[0], body: content.length > 120 ? content : undefined, timestamp: ts, collapsible: content.length > 600 };
    }
    // Skill loading
    if (toolName.includes('skill') || toolName.includes('load')) {
      return { id, type: 'skill', label: 'Loading Skill', title: content, timestamp: ts, collapsible: false };
    }

    // Unknown non-JSON tool output — only show if it looks like useful text
    if (content.length > 20 && !content.startsWith('{') && !content.startsWith('[')) {
      return { id, type: 'tool', label: toolName || 'Tool', title: content.split('\n')[0], body: content.length > 120 ? content : undefined, timestamp: ts, collapsible: content.length > 600 };
    }

    return null; // Skip noise
  }

  // ── SYSTEM / USER MESSAGES — skip ──────────────────────────────────────
  if (msg.role === 'user' || msg.role === 'system') return null;

  // ── ASSISTANT MESSAGES — agent's thinking/decisions ─────────────────────
  if (msg.role !== 'assistant') return null;

  const lower = content.toLowerCase();
  const firstLine = content.split('\n')[0].trim();

  let type: ActionType = 'broadcast';
  let label = 'Agent';
  let title = firstLine.length > 140 ? firstLine.slice(0, 137) + '...' : firstLine;

  if (lower.includes('spawning') || lower.includes('spawn_worker') || lower.includes('delegat')) {
    type = 'spawning'; label = 'Spawning';
    const m = content.match(/spawn(?:ing|_worker)?\s+(?:a\s+)?(.+?)(?:\s+to\s+|\s+for\s+|\.\s*|\s*\n|$)/i);
    title = m ? m[1].trim() : title;
  } else if (
    lower.startsWith('waiting') ||
    lower.includes('wait_for_worker') ||
    lower.includes('waiting on dependency') ||
    (lower.includes('waiting for') && content.length < 400)
  ) {
    type = 'waiting'; label = 'Waiting';
  } else if (lower.includes('completed') && (lower.includes('task') || lower.includes('assessment') || lower.includes('test') || lower.includes('pentest'))) {
    type = 'completed'; label = 'Completed';
  } else if (lower.includes('recording note') || lower.includes('creating note') || lower.includes('document')) {
    type = 'note'; label = 'Note';
  } else if (lower.includes('task') && (lower.includes('added') || lower.includes('updated') || lower.includes('created'))) {
    type = 'task'; label = 'Task';
  } else if (content.length > 300) {
    type = 'thinking'; label = 'Reasoning';
  }

  return {
    id, type, label, title,
    body: content.length > 140 ? content : undefined,
    timestamp: ts,
    collapsible: content.length > 800,
  };
}

// ─── Timeline Entry ──────────────────────────────────────────────────────────

function TimelineEntry({ action }: { action: TimelineAction }) {
  const [collapsed, setCollapsed] = useState(action.collapsible);
  const Icon = ACTION_ICONS[action.type];
  const color = ACTION_COLORS[action.type];
  const isCodeBlock = action.type === 'terminal' || action.type === 'python' || action.type === 'http';

  return (
    <div className="group relative pl-8 pb-5 last:pb-0">
      {/* Connector */}
      <div className="absolute left-[11px] top-[22px] bottom-0 w-px bg-border/15 group-last:hidden" />
      
      {/* Dot */}
      <div className={cn(
        "absolute left-0 top-[6px] h-[22px] w-[22px] border border-border/20 bg-background flex items-center justify-center",
        "group-hover:border-primary/20 transition-colors"
      )}>
        <Icon className={cn("h-3 w-3", color)} />
      </div>
      
      <div className="space-y-1.5">
        {/* Badge + time */}
        <div className="flex items-center gap-2">
          <span className={cn("font-sans text-xs font-bold  ", color)}>
            {action.label}
          </span>
          <span className="text-[8px] font-sans text-muted-foreground/30">
            {new Date(action.timestamp).toLocaleTimeString()}
          </span>
        </div>

        {/* Title (always visible) */}
        <p className="text-[12.5px] text-foreground/80 leading-relaxed font-sans">
          {action.title}
        </p>

        {/* Body — shown by default unless collapsible */}
        {action.body && !collapsed && (
          <div className={cn(
            "mt-1 whitespace-pre-wrap max-h-[500px] overflow-y-auto custom-scrollbar",
            isCodeBlock 
              ? "font-sans text-sm bg-muted/5 border border-border/10 p-3 text-foreground/70"
              : "text-[12.5px] text-foreground/70 leading-relaxed font-sans"
          )}>
            {action.body}
          </div>
        )}

        {/* Collapse toggle — only for very large output */}
        {action.collapsible && action.body && (
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="flex items-center gap-1 text-sm font-sans   text-muted-foreground/40 hover:text-primary transition-colors"
          >
            <ChevronDown className={cn("h-3 w-3 transition-transform", !collapsed && "rotate-180")} />
            {collapsed ? 'Show more' : 'Collapse'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function AgentResponseFeed({
  sessionId,
  className,
  isTerminal = false,
}: AgentResponseFeedProps) {
  const {
    data: rawMessages = [],
    isLoading,
    isError,
    error,
  } = useQuery<FeedMessage[]>({
    queryKey: ['agent-response-feed', sessionId],
    enabled: !!sessionId,
    refetchInterval: isTerminal ? false : 5_000,
    staleTime: 0,
    queryFn: async () => {
      const result = await fetchSessionMessages(sessionId!);
      return result.messages ?? [];
    },
  });

  const actions: TimelineAction[] = rawMessages
    .map(classifyMessage)
    .filter((a): a is TimelineAction => a !== null)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (!sessionId) {
    return (
      <div className="flex h-full items-center justify-center p-12 text-center text-muted-foreground/60">
        <div className="space-y-4">
          <Bot className="mx-auto h-8 w-8 opacity-20" />
          <p className="font-sans text-sm  ">
            Select an agent node to inspect telemetry
          </p>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-full items-center justify-center p-12 text-center text-destructive">
        <div className="space-y-4">
          <AlertTriangle className="mx-auto h-8 w-8 opacity-50" />
          <div className="space-y-1">
            <p className="font-sans text-sm   font-bold">Telemetry Sync Failed</p>
            <p className="text-xs font-sans opacity-60 break-all max-w-[200px] mx-auto">
              {error instanceof Error ? error.message : 'Forbidden or invalid session ID'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading && actions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center space-y-4 flex-col">
        <Activity className="h-6 w-6 text-primary " />
        <p className="font-sans text-sm   text-primary ">
          Establishing technical link...
        </p>
      </div>
    );
  }

  return (
    <div className={cn("relative flex h-full flex-col overflow-hidden", className)}>
      <ScrollArea className="flex-1 w-full">
        <div className="p-6 pt-4">
          {actions.length === 0 ? (
            <div className="border border-border/40 border-dashed p-12 text-center bg-muted/5">
              <p className="text-sm font-sans text-muted-foreground  ">
                Waiting for agent broadcast signals...
              </p>
            </div>
          ) : (
            <div className="relative">
              {actions.map((action) => (
                <TimelineEntry key={action.id} action={action} />
              ))}
            </div>
          )}
          <div className="h-8" />
        </div>
      </ScrollArea>
    </div>
  );
}


