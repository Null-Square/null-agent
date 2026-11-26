import { Handle, Position } from '@xyflow/react';
import { cn } from '@null-ai/design-tokens/ui';
import { Activity, ShieldAlert, CheckCircle, AlertCircle, Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AgentDisplayTone } from '@/modules/runs/lib/agentHierarchy';

export interface AgentNodeData {
  label: string;
  eyebrow: string;
  statusKey: string;
  statusLabel: string;
  metaLabel?: string;
  tone: AgentDisplayTone;
  isParent?: boolean;
}

// Every tone maps to a brand token — no raw red/amber/orange. Waiting and
// blocked share the warning hue (their icons carry the distinction).
const TONE_CLASSES: Record<AgentDisplayTone, string> = {
  running: "border-primary/60 bg-primary/10 text-primary",
  success: "border-success/40 bg-success/10 text-success",
  danger: "border-destructive/40 bg-destructive/10 text-destructive",
  waiting: "border-warning/40 bg-warning/10 text-warning",
  blocked: "border-warning/40 bg-warning/10 text-warning",
  terminal: "border-border/60 bg-background/80 text-muted-foreground",
  neutral: "border-border/60 bg-background text-foreground",
};

const STATUS_ICONS: Record<string, ReactNode> = {
  running: <Activity className="h-3 w-3 " />,
  blocked: <Clock className="h-3 w-3" />,
  completed: <CheckCircle className="h-3 w-3" />,
  failed: <AlertCircle className="h-3 w-3" />,
  cancelled: <ShieldAlert className="h-3 w-3" />,
  awaiting_input: <Clock className="h-3 w-3" />,
  awaiting_approval: <ShieldAlert className="h-3 w-3" />,
};

export default function AgentTopologyNode({ data }: { data: AgentNodeData }) {
  const Icon = STATUS_ICONS[data.statusKey.toLowerCase()] || <Activity className="h-3 w-3" />;

  return (
    <div
      className={cn(
        "group relative flex min-w-[200px] max-w-[250px] flex-col rounded-none border p-3 transition-colors hover:brightness-110",
        TONE_CLASSES[data.tone]
      )}
    >
      <Handle type="target" position={Position.Top} className="opacity-0! w-0! h-0!" />

      <div className="flex items-center justify-between mb-2">
        <span className="font-sans text-[8px] font-bold   opacity-60">
          {data.eyebrow}
        </span>
        <div className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-none bg-black/20 border border-current/20">
           {data.tone === 'running' ? <span className="ns-live-mark h-1.5 w-1.5 bg-current" /> : Icon}
           <span className="font-sans text-[8px] font-bold  tracking-tight leading-none">
             {data.statusLabel}
           </span>
        </div>
      </div>

      <h4 className="line-clamp-2 font-bold text-sm  tracking-tight leading-snug">
        {data.label}
      </h4>

      {data.metaLabel ? (
        <p className="mt-2 font-sans text-[8px] font-bold   opacity-55">
          {data.metaLabel}
        </p>
      ) : null}

      <Handle type="source" position={Position.Bottom} className="opacity-0! w-0! h-0!" />
    </div>
  );
}


