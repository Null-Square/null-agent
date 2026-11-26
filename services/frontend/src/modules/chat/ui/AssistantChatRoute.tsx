import type { AIChatConfig, ApprovalRequest } from '@/types/chat';
import {
  AgentComposerTerminal,
  ChatStreamTerminal,
} from '@modules/chat';
import {
  useCreateScopedChatSessionMutation,
  useSetupReadinessQuery,
} from '@modules/chat/api';
import { Activity, Check, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import AIChatProvider, { useAIChat } from '@modules/chat/model/AIChatContext';
import { useSessionDetailsQuery } from '@modules/sessions';
import { useScope } from '@shared/contexts/ScopeContext';
import { toApiError } from '@shared/lib/apiError';
import { cn } from '@shared/lib/utils';
import ErrorBoundary from '@shared/ui/ErrorBoundary';
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';

const assistantBootstrapRequests = new Map<string, Promise<{ sessionId: string }>>();



const getAssistantBootstrapRequest = (
  key: string,
  createRequest: () => Promise<{ sessionId: string }>,
) => {
  const existing = assistantBootstrapRequests.get(key);
  if (existing) {
    return existing;
  }

  const request = createRequest().finally(() => {
    if (assistantBootstrapRequests.get(key) === request) {
      assistantBootstrapRequests.delete(key);
    }
  });

  assistantBootstrapRequests.set(key, request);
  return request;
};


const APPROVAL_TOOL_LABELS: Record<string, string> = {
  update_organization_context: 'Update organization context',
  update_scope_brief: 'Update scope brief',
  add_scope_target: 'Add scope target',
  create_scope_automation: 'Create automation',
};

const formatApprovalPayload = (approval: ApprovalRequest): string => {
  const payload = {
    ...(approval.args && Object.keys(approval.args).length > 0 ? { args: approval.args } : {}),
    ...(approval.preview && Object.keys(approval.preview).length > 0 ? { preview: approval.preview } : {}),
  };
  if (!payload || Object.keys(payload).length === 0) {
    return 'No argument preview provided.';
  }
  return JSON.stringify(payload, null, 2);
};

const AssistantApprovalPanel = ({
  approval,
  onApprove,
  onDeny,
}: {
  approval: ApprovalRequest;
  onApprove: (actionId: string) => Promise<void>;
  onDeny: (actionId: string, reason?: string) => Promise<void>;
}) => {
  const [pendingDecision, setPendingDecision] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toolLabel = APPROVAL_TOOL_LABELS[approval.tool] ?? approval.tool;
  const disabled = pendingDecision !== null;

  const decide = async (decision: 'approve' | 'deny') => {
    if (disabled) {
      return;
    }
    setPendingDecision(decision);
    setError(null);
    try {
      if (decision === 'approve') {
        await onApprove(approval.actionId);
      } else {
        await onDeny(approval.actionId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval decision failed');
      setPendingDecision(null);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 rounded-none border border-border/40 bg-background/80 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[10px] font-mono font-bold uppercase tracking-[0.2em] text-primary">
          <ShieldCheck className="h-3.5 w-3.5" />
          <span>Approval Required</span>
        </div>
        <div className="mt-1 text-sm font-semibold text-foreground">{toolLabel}</div>
        {approval.reason ? (
          <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{approval.reason}</div>
        ) : null}
        <pre className="mt-3 max-h-32 overflow-auto rounded-none border-l-2 border-border py-3 pl-4 text-[11px] leading-relaxed text-muted-foreground">
          {formatApprovalPayload(approval)}
        </pre>
        {error ? (
          <div className="mt-2 text-xs text-destructive">{error}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:pt-7">
        <button
          type="button"
          onClick={() => void decide('deny')}
          disabled={disabled}
          className="inline-flex h-8 items-center gap-1.5 rounded-none border border-border/40 bg-background/70 px-3 text-[10px] font-mono font-bold uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:bg-muted/20 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pendingDecision === 'deny' ? <span className="ns-live-mark" aria-hidden /> : <X className="h-3.5 w-3.5" />}
          Deny
        </button>
        <button
          type="button"
          onClick={() => void decide('approve')}
          disabled={disabled}
          className="inline-flex h-8 items-center gap-1.5 rounded-none border border-primary/30 bg-primary/10 px-3 text-[10px] font-mono font-bold uppercase tracking-[0.16em] text-primary transition-colors hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pendingDecision === 'approve' ? <span className="ns-live-mark" aria-hidden /> : <Check className="h-3.5 w-3.5" />}
          Approve
        </button>
      </div>
    </div>
  );
};

type TargetOwnershipBlockReason = 'no_target' | 'unverified';

/**
 * Shown instead of the composer when the selected scope has no verified target.
 * Ownership is an authorization boundary: the assistant answers using this
 * scope's targets, findings, assets, and RoE, so it stays closed until the
 * domain is proven. Verification itself is deterministic and lives in /setup —
 * no assistant turn is needed to complete it.
 */
const AssistantVerificationGate = ({
  scopeLabel,
  reason,
}: {
  scopeLabel: string | null;
  reason: TargetOwnershipBlockReason;
}) => (
  <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex min-h-0 w-full flex-1 items-center justify-center px-8 py-12">
      <div className="flex w-full max-w-xl flex-col items-center text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-none border border-warning bg-warning/10 text-warning dark:text-warning">
          <ShieldAlert className="h-5 w-5" />
        </div>
        <div className="mt-5 flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.24em] text-muted-foreground/50">
          <Activity className="h-3.5 w-3.5" />
          <span>Operational Context: {scopeLabel ?? 'All Scopes'}</span>
        </div>
        <h1 className="mt-4 font-sans text-2xl font-bold tracking-tight text-foreground">
          {reason === 'no_target' ? 'Add a target to this scope' : 'Verify target ownership'}
        </h1>
        <p className="mt-3 font-sans text-[13px] leading-relaxed text-muted-foreground/75">
          {reason === 'no_target'
            ? 'The assistant answers using this scope’s targets, risks, and rules of engagement. Add the domain you are authorized to test and prove ownership before starting a conversation.'
            : 'The assistant answers using this scope’s targets, risks, and rules of engagement, so ownership has to be proven first. Setup detects your website platform and shows the fastest method — usually a provider connection, otherwise a DNS record or a file upload.'}
        </p>
        <Link
          to="/setup"
          className="mt-7 inline-flex h-9 items-center gap-2 rounded-none border border-primary/30 bg-primary/10 px-4 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-primary transition-colors hover:bg-primary/15"
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          {reason === 'no_target' ? 'Add target' : 'Verify target'}
        </Link>
      </div>
    </div>
  </div>
);

const AssistantChatWorkspace = () => {
  const {
    pendingApproval,
    approvePendingAction,
    denyPendingAction,
  } = useAIChat();
  const { scopes, activeScopeId } = useScope();
  const activeScope = scopes.find((scope) => scope.id === activeScopeId) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 w-full flex-1 flex-col h-full max-h-full">
        <div className="min-h-0 flex-1 overflow-hidden relative">
          <ChatStreamTerminal
            showUserMessages
            variant="clean"
            scopeLabel={activeScope?.name ?? null}
          />
        </div>
        {pendingApproval ? (
          <div className="shrink-0 border-t border-border/20 px-4 py-3">
            <AssistantApprovalPanel
              approval={pendingApproval}
              onApprove={approvePendingAction}
              onDeny={denyPendingAction}
            />
          </div>
        ) : null}
        <AgentComposerTerminal variant="clean" className="shrink-0" />
      </div>
    </div>
  );
};

export default function AssistantChatRoute() {
  const { activeScopeId, scopes, isLoading: scopesLoading } = useScope();
  const paths = useAppPaths();
  const activeScope = scopes.find((scope) => scope.id === activeScopeId) ?? null;
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessionId, setSessionId] = useState('');
  const [sessionScopeId, setSessionScopeId] = useState<string | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const requestedSessionId = searchParams.get('session')?.trim() || '';
  const bootstrapPrompt = searchParams.get('prompt')?.trim() || undefined;
  const bootstrapModelCategory = searchParams.get('modelCategory') || searchParams.get('model') || undefined;
  const shouldAutoBootstrap = Boolean(bootstrapPrompt);
  const bootstrapKey = `${activeScopeId ?? ''}|${bootstrapPrompt ?? ''}|${bootstrapModelCategory ?? ''}`;
  const attemptedBootstrapKeyRef = useRef<string | null>(null);
  const bootstrapNonceRef = useRef(0);
  const mountedRef = useRef(true);
  const createChatSessionMutation = useCreateScopedChatSessionMutation({ syncSessionList: false });
  const { mutateAsync: createChatSession, reset: resetCreateChatSession } =
    createChatSessionMutation;
  // Kept enabled while a session is open: it also feeds the ownership gate, so
  // a target removed mid-conversation closes the composer on the next refetch.
  const { data: setupReadiness } = useSetupReadinessQuery(activeScopeId, {
    enabled: Boolean(activeScopeId),
  });
  const { data: sessionDetails } = useSessionDetailsQuery(sessionId || undefined);

  /**
   * Mirrors the server rule in `scopeVerificationGate`. `known: false` means
   * readiness has not loaded yet — treated as "not allowed to start" so a
   * queued prompt cannot race ahead of the check.
   */
  const targetOwnership = useMemo(() => {
    const counts = activeScopeId ? setupReadiness?.counts : undefined;
    if (!counts) {
      return { known: false, verified: false, reason: null as TargetOwnershipBlockReason | null };
    }
    const { targetCount, verifiedTargetCount } = counts;
    if (verifiedTargetCount > 0) {
      return { known: true, verified: true, reason: null as TargetOwnershipBlockReason | null };
    }
    return {
      known: true,
      verified: false,
      reason: (targetCount > 0 ? 'unverified' : 'no_target') as TargetOwnershipBlockReason,
    };
  }, [activeScopeId, setupReadiness]);

  const ownershipBlocked = targetOwnership.known && !targetOwnership.verified;

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      bootstrapNonceRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!requestedSessionId) {
      return;
    }
    if (sessionId === requestedSessionId) {
      return;
    }
    bootstrapNonceRef.current += 1;
    setSessionId(requestedSessionId);
    setSessionScopeId(activeScopeId ?? null);
    setBootstrapError(null);
    attemptedBootstrapKeyRef.current = null;
    resetCreateChatSession();
  }, [activeScopeId, requestedSessionId, resetCreateChatSession, sessionId]);

  useEffect(() => {
    if (!requestedSessionId || !activeScopeId) {
      return;
    }
    if (sessionId !== requestedSessionId || sessionScopeId !== null) {
      return;
    }
    setSessionScopeId(activeScopeId);
  }, [activeScopeId, requestedSessionId, sessionId, sessionScopeId]);

  useEffect(() => {
    if (requestedSessionId || shouldAutoBootstrap) {
      return;
    }
    if (!sessionId && !sessionScopeId) {
      return;
    }
    bootstrapNonceRef.current += 1;
    setSessionId('');
    setSessionScopeId(null);
    attemptedBootstrapKeyRef.current = null;
    resetCreateChatSession();
  }, [requestedSessionId, resetCreateChatSession, sessionId, sessionScopeId, shouldAutoBootstrap]);

  useEffect(() => {
    if (!sessionScopeId || !activeScopeId) {
      return;
    }
    if (activeScopeId === sessionScopeId) {
      return;
    }
    bootstrapNonceRef.current += 1;
    setSessionId('');
    setSessionScopeId(null);
    setBootstrapError(null);
    attemptedBootstrapKeyRef.current = null;
    resetCreateChatSession();
    setSearchParams((currentParams) => {
      const nextParams = new URLSearchParams(currentParams);
      nextParams.delete('session');
      nextParams.delete('prompt');
      nextParams.delete('model');
      nextParams.delete('modelCategory');
      return nextParams;
    }, { replace: true });
  }, [activeScopeId, resetCreateChatSession, sessionScopeId, setSearchParams]);

  useEffect(() => {
    if (sessionId || requestedSessionId || !activeScopeId || scopesLoading || bootstrapError || !shouldAutoBootstrap) {
      return;
    }

    // Hold the queued hero prompt until ownership is known and proven.
    if (!targetOwnership.verified) {
      return;
    }

    if (attemptedBootstrapKeyRef.current === bootstrapKey) {
      return;
    }

    attemptedBootstrapKeyRef.current = bootstrapKey;
    const requestNonce = ++bootstrapNonceRef.current;

    void getAssistantBootstrapRequest(bootstrapKey, () =>
      createChatSession({
        scopeId: activeScopeId,
        modelCategory: bootstrapModelCategory,
        initialPrompt: bootstrapPrompt,
      }),
    )
      .then((result) => {
        if (!mountedRef.current || bootstrapNonceRef.current !== requestNonce) {
          return;
        }
        setSessionId(result.sessionId);
        setSessionScopeId(activeScopeId);
        setBootstrapError(null);

        setSearchParams((currentParams) => {
          const nextParams = new URLSearchParams(currentParams);
          nextParams.delete('prompt');
          nextParams.delete('model');
          nextParams.delete('modelCategory');
          nextParams.set('session', result.sessionId);
          return nextParams;
        }, { replace: true });
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || bootstrapNonceRef.current !== requestNonce) {
          return;
        }
        const apiError = toApiError(error);
        setBootstrapError(apiError.userMessage ?? apiError.message ?? 'Failed to prepare assistant chat.');
      });
  }, [
    activeScopeId,
    bootstrapError,
    bootstrapKey,
    bootstrapModelCategory,
    bootstrapPrompt,
    createChatSession,
    requestedSessionId,
    scopesLoading,
    sessionId,
    setSearchParams,
    shouldAutoBootstrap,
    targetOwnership.verified,
  ]);

  const configOverride = useMemo<Partial<AIChatConfig>>(
    () => ({
      title: 'Null',
      subtitle: 'Scoped chat with approved changes',
      placeholder: 'Ask about this scope',
      conversationPlaceholder:
        'Ask about risks, assets, prior runs, ROE, repository context, or techniques already tried...',
      usage: {
        tokensUsed: sessionDetails?.usage?.lastTurnInputTokens ?? 0,
        contextWindow: sessionDetails?.usage?.contextWindow ?? undefined,
        contextRemaining:
          sessionDetails?.usage?.contextWindow && typeof sessionDetails.usage.lastTurnInputTokens === 'number'
            ? Math.max(sessionDetails.usage.contextWindow - sessionDetails.usage.lastTurnInputTokens, 0)
            : undefined,
      },
    }),
    [sessionDetails?.usage],
  );

  const content = !activeScope && !scopesLoading ? (
    <div className="flex min-h-[70vh] items-center justify-center px-6">
      <div className="max-w-xl text-center">
        <div className="text-[11px] uppercase tracking-[0.24em] text-muted-foreground">Null</div>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight">Select a scope first</h2>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">
          This chat assistant is scope-aware. Pick an active scope from the sidebar before starting a conversation.
        </p>
      </div>
    </div>
  ) : ownershipBlocked ? (
    <AssistantVerificationGate
      scopeLabel={activeScope?.name ?? null}
      reason={targetOwnership.reason ?? 'unverified'}
    />
  ) : sessionId ? (
    <AssistantChatWorkspace />
  ) : requestedSessionId || shouldAutoBootstrap ? (
    // A session is being opened or created — the panel always arrives with one
    // of these, so this is the normal path in.
    <div className="flex min-h-[60vh] items-center justify-center text-sm text-muted-foreground">
      <span className="ns-live-mark mr-3" aria-hidden />
      Opening conversation
    </div>
  ) : (
    // Nothing to show: conversations start in the assistant panel, so a bare
    // /chat is a stale link.
    <Navigate to={paths.assetsList} replace />
  );

  return (
    <ErrorBoundary>
      <AIChatProvider
        key={`assistant-chat-root:${sessionId || activeScopeId || 'none'}`}
        sessionId={sessionId || undefined}
        configOverride={configOverride}
        syncSessionList={false}
      >
        <div className={cn('relative', !sessionId && 'min-h-screen')}>
          {content}
        </div>
      </AIChatProvider>
    </ErrorBoundary>
  );
}


