import type { PlanItem, PlanItemStatus } from '@/types/chat';
import { useAIChat } from '@modules/chat/model/AIChatContext';
import { cn } from '@shared/lib/utils';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Clock, Cpu, XCircle } from 'lucide-react';
import React, { useEffect, useState } from 'react';

const statusConfig: Record<PlanItemStatus, { icon: React.ReactNode; color: string; label: string }> = {
  pending: {
    icon: <Clock className="h-3.5 w-3.5" />,
    color: 'text-muted-foreground',
    label: 'Pending',
  },
  running: {
    icon: <span className="ns-live-mark" aria-hidden />,
    color: 'text-primary',
    label: 'Running',
  },
  completed: {
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    color: 'text-foreground',
    label: 'Complete',
  },
  blocked: {
    icon: <AlertCircle className="h-3.5 w-3.5" />,
    color: 'text-muted-foreground',
    label: 'Blocked',
  },
  error: {
    icon: <XCircle className="h-3.5 w-3.5" />,
    color: 'text-destructive',
    label: 'Error',
  },
};

const formatElapsed = (milliseconds: number): string => {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '00:00';
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

export const CollapsiblePlanPanel: React.FC = () => {
  const { plan } = useAIChat();
  const [now, setNow] = useState(() => Date.now());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const hasRunningStep = plan.some(
      (item) => item.status === 'running' && typeof item.startedAt === 'number'
    );
    if (!hasRunningStep) return;
    
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [plan]);

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const getDurationLabel = (item: PlanItem): string | null => {
    if (item.status === 'running' && typeof item.startedAt === 'number') {
      return formatElapsed(now - item.startedAt);
    }
    if (
      item.status === 'completed' &&
      typeof item.startedAt === 'number' &&
      typeof item.completedAt === 'number'
    ) {
      return formatElapsed(item.completedAt - item.startedAt);
    }
    return null;
  };

  if (!plan.length) return null;

  const completedCount = plan.filter(item => item.status === 'completed').length;
  const totalCount = plan.length;
  const progressPercent = (completedCount / totalCount) * 100;

  return (
    <div className="flex flex-col h-full bg-background/20">
      {/* Header & Overall Progress */}
      <div className="px-5 py-4 border-b border-border/40">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Cpu className="h-3.5 w-3.5 text-primary" />
            <span className="text-[10px] font-mono font-bold uppercase tracking-[0.2em] text-foreground">
              Execution Plan
            </span>
          </div>
          <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider">
            {completedCount} / {totalCount} Steps
          </span>
        </div>

        {/* Slim Progress Bar */}
        <div className="h-1 w-full bg-muted/40 rounded-none overflow-hidden">
          <motion.div
            className="h-full bg-primary"
            initial={{ width: 0 }}
            animate={{ width: `${progressPercent}%` }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          />
        </div>
      </div>

      {/* Plan Steps Timeline */}
      <div className="flex-1 overflow-y-auto px-5 py-6 no-scrollbar">
        <div className="relative space-y-6">
          {/* Timeline Connector Line */}
          <div className="absolute left-[7px] top-2 bottom-2 w-[1px] bg-border/30" />

          {plan.map((item) => {
            const config = statusConfig[item.status];
            const duration = getDurationLabel(item);
            const isRunning = item.status === 'running';
            const isExpanded = expandedIds.has(item.id);

            return (
              <div key={item.id} className="relative pl-6">
                {/* Timeline Node */}
                <div className={cn(
                  "absolute left-0 top-[3px] h-3.5 w-3.5 rounded-none border-[1.5px] bg-background z-10 transition-colors",
                  isRunning ? "border-primary" :
                  item.status === 'completed' ? "border-success bg-success/10" : "border-border"
                )}>
                  {item.status === 'completed' && <CheckCircle2 className="h-full w-full p-0.5 text-foreground" />}
                </div>

                <div
                  className={cn(
                    "group transition-all rounded-none p-2 -m-2",
                    isRunning ? "bg-primary/5" : "hover:bg-muted/30"
                  )}
                  onClick={() => toggleExpand(item.id)}
                >
                  <div className="flex items-start justify-between gap-3 cursor-pointer">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={cn(
                          "text-[10px] font-mono font-bold uppercase tracking-wide",
                          isRunning ? "text-primary" : "text-foreground/80"
                        )}>
                          {item.title}
                        </span>
                        {duration && (
                          <span className="text-[9px] font-mono text-muted-foreground/60 tabular-nums">
                            [{duration}]
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <span className={cn("text-[9px] font-mono uppercase tracking-widest", config.color)}>
                          {config.label}
                        </span>
                        {item.notes && (
                          <span className="text-[9px] text-muted-foreground opacity-40">
                            • {isExpanded ? <ChevronDown className="h-2 w-2 inline" /> : <ChevronRight className="h-2 w-2 inline" />} details
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <AnimatePresence>
                    {isExpanded && item.notes && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="mt-3 pl-0 text-[10px] font-mono text-muted-foreground leading-relaxed border-l border-border/20 ml-1 pl-3 py-1">
                          {item.notes}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default CollapsiblePlanPanel;
