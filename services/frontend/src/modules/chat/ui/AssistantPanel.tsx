import {
  useDismissSetupRecommendationMutation,
  useAssistantChatSessionsQuery,
  useSetupReadinessQuery,
  type SetupReadinessAction,
} from '@modules/chat/api';
import {
  SCOPE_ASSISTANT_TASKS,
  SCOPE_TASK_GLYPHS,
} from '@modules/chat/lib/scopeAssistantTasks';
import type { AssistantChatSessionMeta } from '@/types/chat';
import { CellIcon, PromptRail, StackList } from '@null-ai/design-tokens/ui';
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { useScope } from '@shared/contexts/ScopeContext';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';


/**
 * Target ownership is a prerequisite for the assistant itself, so these two
 * actions must navigate to setup — sending them as chat prompts would land on
 * the ownership gate instead of doing anything.
 */
const NAVIGATION_ONLY_ACTIONS = new Set<SetupReadinessAction['id']>(['add_target', 'verify_target']);

const isNavigationOnlyAction = (action: SetupReadinessAction) => NAVIGATION_ONLY_ACTIONS.has(action.id);



function PanelStartSurface({
  history,
  historyLoading,
  onResume,
  recommendations,
  scopeName,
  error,
  dismissPending,
  dismissVariables,
  onStartPrompt,
  onStartRecommendation,
  onDismissRecommendation,
}: {
  history: AssistantChatSessionMeta[];
  historyLoading: boolean;
  onResume: (sessionId: string) => void;
  recommendations: SetupReadinessAction[];
  scopeName: string | null;
  error: string | null;
  dismissPending: boolean;
  dismissVariables?: { actionId: SetupReadinessAction['id']; stateSignature: string } | null;
  onStartPrompt: (prompt: string) => void;
  onStartRecommendation: (action: SetupReadinessAction) => void;
  onDismissRecommendation: (action: SetupReadinessAction) => void;
}) {
  const [draft, setDraft] = useState('');

  const startDraft = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onStartPrompt(trimmed);
    setDraft('');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="custom-scrollbar flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto p-5">
        {error ? (
          <div className="border-l-2 border-destructive py-2 pl-4 text-[13px] leading-relaxed text-destructive">
            {error}
          </div>
        ) : null}

        {history.length > 0 || historyLoading ? (
          <StackList
            label="Recent"
            isLoading={historyLoading}
            loadingLabel="Loading conversations"
            rows={history.slice(0, 5).map((session) => ({
              key: session.id,
              title: session.title ?? 'Untitled conversation',
              onSelect: () => onResume(session.id),
            }))}
          />
        ) : null}

        {/* Two labelled groups, both the shared narrow list. These were two
            hand-rolled row components in this file alone, and two more of the
            same shape on the chat page. */}
        {recommendations.length > 0 ? (
          <StackList
            label={`Set up${scopeName ? ` · ${scopeName}` : ''}`}
            rows={recommendations.map((action) => ({
              key: `${action.id}:${action.stateSignature ?? 'current'}`,
              title: action.title,
              subtitle: action.reason ?? action.description,
              signal: action.status === 'required' ? ('destructive' as const) : ('none' as const),
              onSelect: () => onStartRecommendation(action),
              actions:
                action.status !== 'required'
                && action.dismissible !== false
                && Boolean(action.stateSignature) ? (
                  <button
                    type="button"
                    onClick={() => onDismissRecommendation(action)}
                    disabled={
                      dismissPending
                      && dismissVariables?.actionId === action.id
                      && dismissVariables?.stateSignature === action.stateSignature
                    }
                    className="p-1 text-muted-foreground/50 transition-colors hover:text-foreground disabled:opacity-30"
                    aria-label={`Dismiss ${action.title}`}
                    title="Not now"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null,
            }))}
          />
        ) : null}
      </div>

      {/* Suggested asks sit above the input, where this pattern belongs.
          Setup actions stay in the scroll area above: those are records with
          state, these are things to ask. */}
      <PromptRail
        className="shrink-0 px-4 pb-3"
        label="Ask about this scope"
        items={SCOPE_ASSISTANT_TASKS.map((task) => ({
          key: task.id,
          icon: SCOPE_TASK_GLYPHS[task.id],
          label: task.title,
          onSelect: () => onStartPrompt(task.prompt),
        }))}
      />

      <form
        className="flex shrink-0 flex-col gap-3 border-t border-border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          startDraft();
        }}
      >
        <div className="border border-border p-2.5 transition-colors focus-within:border-foreground/40">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            placeholder="Ask Null…"
            className="min-h-[60px] w-full resize-none bg-transparent px-1 py-1 text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/50"
          />
          <div className="mt-2.5 flex justify-end border-t border-border/60 pt-2.5">
            <button
              type="submit"
              disabled={!draft.trim()}
              className="inline-flex h-8 items-center gap-2 rounded-none bg-foreground px-3 text-[10px] font-bold uppercase tracking-widest text-background transition-all hover:bg-foreground/90 active:scale-[0.98] disabled:bg-muted disabled:text-muted-foreground"
            >
              <Send className="h-3 w-3" />
              Send
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

export default function AssistantPanel() {
  const { activeScopeId, scopes } = useScope();
  const activeScope = scopes.find((scope) => scope.id === activeScopeId) ?? null;
  const navigate = useNavigate();
  const paths = useAppPaths();
  const { data: readiness } = useSetupReadinessQuery(activeScopeId, {
    enabled: Boolean(activeScopeId),
  });
  const dismissMutation = useDismissSetupRecommendationMutation();
  const [open, setOpen] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const launchTimerRef = useRef<number | null>(null);

  const clearLaunchTimer = useCallback(() => {
    if (launchTimerRef.current !== null) {
      window.clearTimeout(launchTimerRef.current);
      launchTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    setError(null);
  }, [activeScopeId]);

  useEffect(() => () => clearLaunchTimer(), [clearLaunchTimer]);

  const recommendations = useMemo(() => {
    const byId = new Map<SetupReadinessAction['id'], SetupReadinessAction>();
    const addActions = (actions?: SetupReadinessAction[]) => {
      for (const action of actions ?? []) {
        if (action.id === 'review_scope' || action.status === 'complete' || byId.has(action.id)) continue;
        byId.set(action.id, action);
      }
    };

    addActions(readiness?.recommendations);
    addActions(readiness?.nextBestActions);

    const sorted = [...byId.values()].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
    const visible = sorted.slice(0, 3);
    const automation = sorted.find((action) => action.id === 'create_automation');

    if (automation && !visible.some((action) => action.id === automation.id)) {
      visible.push(automation);
    }

    return visible.slice(0, 4);
  }, [readiness]);
  const badgeCount = recommendations.length;

  const openChat = useCallback((prompt?: string) => {
    const trimmed = prompt?.trim() ?? '';
    if (launching) {
      return;
    }
    if (!activeScopeId && trimmed) {
      setError('Select a scope before starting the assistant.');
      return;
    }

    setError(null);
    const params = new URLSearchParams();
    if (trimmed) {
      params.set('prompt', trimmed);
    }
    const target = `${paths.chat}${params.toString() ? `?${params.toString()}` : ''}`;
    clearLaunchTimer();
    setLaunching(true);
    launchTimerRef.current = window.setTimeout(() => {
      launchTimerRef.current = null;
      navigate(target);
      setOpen(false);
      setLaunching(false);
    }, 260);
  }, [activeScopeId, clearLaunchTimer, launching, navigate, paths.chat]);

  const startRecommendation = useCallback((action: SetupReadinessAction) => {
    if (isNavigationOnlyAction(action)) {
      clearLaunchTimer();
      setLaunching(false);
      setOpen(false);
      navigate(action.href ?? '/setup');
      return;
    }
    openChat(action.prompt);
  }, [clearLaunchTimer, navigate, openChat]);

  const resumeConversation = useCallback((sessionId: string) => {
    clearLaunchTimer();
    setLaunching(false);
    setOpen(false);
    navigate(`${paths.chat}?session=${sessionId}`);
  }, [clearLaunchTimer, navigate, paths]);

  const { data: assistantHistory = [], isLoading: assistantHistoryLoading } =
    useAssistantChatSessionsQuery(activeScopeId, {
      enabled: Boolean(activeScopeId) && open,
      limit: 10,
    });

  const closePanel = useCallback(() => {
    clearLaunchTimer();
    setLaunching(false);
    setOpen(false);
  }, [clearLaunchTimer]);

  const dismissRecommendation = (action: SetupReadinessAction) => {
    if (!activeScopeId || !action.stateSignature) return;
    dismissMutation.mutate({
      scopeId: activeScopeId,
      actionId: action.id,
      stateSignature: action.stateSignature,
      surface: 'assistant',
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed right-0 top-1/2 z-[155] hidden h-14 w-8 -translate-y-1/2 items-center justify-center overflow-hidden rounded-none border border-r-0 border-border bg-background text-muted-foreground transition-all duration-300 hover:border-foreground/20 hover:bg-muted/40 hover:text-foreground active:scale-95 lg:flex"
        aria-label="Open security assistant"
        title="Null"
      >
        <span className="flex">
          <CellIcon name="chat" size={20} className="text-foreground/75" />
        </span>
        {badgeCount > 0 ? (
          <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-none bg-foreground px-1 text-[8px] font-mono font-black leading-none text-background">
            {badgeCount > 9 ? '9+' : badgeCount}
          </span>
        ) : null}
      </button>

      <AnimatePresence>
        {open ? (
          <div className="fixed inset-0 z-[190] hidden lg:block">
            <motion.button
              type="button"
              aria-label="Close assistant"
              className="absolute inset-0 bg-background/20"
              onClick={closePanel}
              initial={{ opacity: 0 }}
              animate={{ opacity: launching ? 0.9 : 1 }}
              exit={{ opacity: 0 }}
            />
            <motion.aside
              initial={{ x: 32, opacity: 0 }}
              animate={
                launching
                  ? { x: 0, opacity: 0, scale: 1.04, filter: 'blur(6px)' }
                  : { x: 0, opacity: 1, scale: 1, filter: 'blur(0px)' }
              }
              exit={{ x: 28, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 350, damping: 30, mass: 0.8 }}
              style={{ transformOrigin: 'right center' }}
              className="absolute inset-y-0 right-0 flex h-full w-[400px] max-w-[calc(100vw-96px)] flex-col overflow-hidden border-l border-border bg-background"
            >
              <header className="flex h-16 shrink-0 items-center justify-between border-b border-border px-5">
                <div className="flex min-w-0 items-center gap-3">
                  {/* The glyph, not a glyph in a box: the header is already a
                      surface. */}
                  <CellIcon name="chat" size={18} className="shrink-0 text-foreground" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-foreground">Null</div>
                    <div className="truncate text-[12px] text-muted-foreground">
                      {activeScope?.name ?? 'Select scope'}
                    </div>
                  </div>
                </div>
                {/* One verb in a header. The Chat button opened the page this
                    panel is a shortcut to, which is the panel undoing itself. */}
                <button
                  type="button"
                  onClick={closePanel}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-none text-muted-foreground transition-colors hover:text-foreground"
                  aria-label="Close assistant"
                >
                  <X className="h-4 w-4" />
                </button>
              </header>

              <PanelStartSurface
                history={assistantHistory}
                historyLoading={assistantHistoryLoading}
                onResume={resumeConversation}
                recommendations={recommendations}
                scopeName={activeScope?.name ?? null}
                error={error}
                dismissPending={dismissMutation.isPending}
                dismissVariables={dismissMutation.variables}
                onStartPrompt={openChat}
                onStartRecommendation={startRecommendation}
                onDismissRecommendation={dismissRecommendation}
              />
            </motion.aside>
            <AnimatePresence>
              {launching ? (
                <motion.div
                  key="assistant-chat-launch"
                  className="fixed inset-0 z-[220] hidden items-center justify-center bg-background lg:flex"
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 1.02 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                  aria-hidden="true"
                >
                  <div className="flex h-14 w-14 items-center justify-center rounded-none border border-border/45 bg-muted/30 text-foreground">
                    <Sparkles className="h-6 w-6" />
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
