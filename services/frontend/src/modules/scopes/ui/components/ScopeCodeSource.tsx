import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, DisclosurePanel, Input, SegmentedControl, StatusPill } from '@null-ai/design-tokens/ui';
import {
  invalidateScopeCodeSource,
  useRefreshScopeCodeSourceMutation,
  useRemoveScopeCodeSourceMutation,
  useScopeCodeSourceQuery,
  useSetScopeCodeSourceMutation,
} from '@/modules/security-ops/api';
import { describeCodeSource, shortCommit } from '@/modules/security-ops/lib/codeSource';
import type { CodeSource } from '@/modules/security-ops/types';
import { toApiError } from '@shared/lib/apiError';

type CodeSourceKind = CodeSource['kind'];

const KIND_OPTIONS = [
  { value: 'folder', label: 'Folder' },
  { value: 'git', label: 'Git URL' },
] as const satisfies ReadonlyArray<{ value: CodeSourceKind; label: string }>;

const KIND_COPY: Record<CodeSourceKind, { label: string; placeholder: string; hint: string }> = {
  folder: {
    label: 'Folder path',
    placeholder: '/absolute/path/to/your/code',
    hint: 'A folder on this computer, read where it is and never written. In Docker, put it under ./code.',
  },
  git: {
    label: 'Git URL',
    placeholder: 'https://github.com/owner/repository',
    hint: 'Public repositories only. For a private one, clone it yourself and add the folder.',
  },
};

const errorText = (error: unknown): string => {
  const apiError = toApiError(error);
  return apiError.userMessage || apiError.message || 'Could not use this code.';
};

/**
 * The scope's code, for Code Review: one folder on this computer or one public
 * git URL. The source is the server's; this panel shows it, and a clone in
 * progress is followed until it is ready or failed.
 */
export default function ScopeCodeSourcePanel({ scopeId, canManage }: { scopeId: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const { data: codeSource } = useScopeCodeSourceQuery(scopeId);
  const setSource = useSetScopeCodeSourceMutation();
  const refreshSource = useRefreshScopeCodeSourceMutation();
  const removeSource = useRemoveScopeCodeSourceMutation();

  const [kind, setKind] = useState<CodeSourceKind>(codeSource?.kind ?? 'git');
  const [location, setLocation] = useState(codeSource?.location ?? '');
  const [actionError, setActionError] = useState<string | null>(null);

  // The form starts from the saved source and follows it when another one is
  // saved; a poll of the same source leaves what is being typed alone.
  const savedKey = codeSource ? `${codeSource.kind}:${codeSource.location}` : '';
  const [formFor, setFormFor] = useState(savedKey);
  if (formFor !== savedKey) {
    setFormFor(savedKey);
    if (codeSource) {
      setKind(codeSource.kind);
      setLocation(codeSource.location);
    }
  }

  // A clone that finishes changes what the scopes say, so the home sees it.
  const lastStatus = useRef(codeSource?.status);
  useEffect(() => {
    if (lastStatus.current === 'cloning' && codeSource?.status !== 'cloning') {
      invalidateScopeCodeSource(queryClient, scopeId);
    }
    lastStatus.current = codeSource?.status;
  }, [codeSource?.status, queryClient, scopeId]);

  const busy = setSource.isPending || refreshSource.isPending || removeSource.isPending;
  const copy = KIND_COPY[kind];
  const trimmedLocation = location.trim();

  const run = (action: Promise<unknown>) => {
    setActionError(null);
    action.catch((error: unknown) => setActionError(errorText(error)));
  };

  const applyCode = () => {
    if (!trimmedLocation) return;
    run(setSource.mutateAsync({ scopeId, kind, location: trimmedLocation }));
  };

  const failure = actionError ?? (codeSource?.status === 'failed' ? codeSource.error ?? 'The code could not be read.' : null);
  const commit = shortCommit(codeSource?.headCommit ?? null);

  const state = !codeSource ? (
    <StatusPill tone="neutral" showDot={false}>None</StatusPill>
  ) : codeSource.status === 'cloning' ? (
    <StatusPill tone="signal">Cloning</StatusPill>
  ) : codeSource.status === 'failed' ? (
    <StatusPill tone="destructive">Failed</StatusPill>
  ) : (
    <StatusPill tone="success">{describeCodeSource(codeSource)}</StatusPill>
  );

  return (
    <DisclosurePanel
      title="Code"
      description="A folder on this computer, or a public git URL, for Code Review."
      state={state}
    >
      <div className="flex flex-col gap-4">
        <SegmentedControl
          label="Where the code is"
          tone="label"
          options={KIND_OPTIONS}
          value={kind}
          onChange={(next) => {
            setKind(next);
            setActionError(null);
          }}
          disabled={!canManage || busy}
          className="self-start"
        />

        <Input
          aria-label={copy.label}
          value={location}
          onChange={(event) => setLocation(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') applyCode();
          }}
          placeholder={copy.placeholder}
          disabled={!canManage || busy}
          className="font-mono"
          spellCheck={false}
          autoComplete="off"
        />
        <p className="text-sm text-muted-foreground">{copy.hint}</p>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={applyCode}
            disabled={!canManage || !trimmedLocation}
            loading={setSource.isPending}
          >
            Use this code
          </Button>
          {codeSource ? (
            <>
              <Button
                variant="outline"
                onClick={() => run(refreshSource.mutateAsync(scopeId))}
                disabled={!canManage || busy || codeSource.status === 'cloning'}
                loading={refreshSource.isPending}
              >
                Refresh
              </Button>
              <Button
                variant="outline"
                className="text-destructive hover:border-destructive/50"
                onClick={() => run(removeSource.mutateAsync(scopeId))}
                disabled={!canManage || busy}
                loading={removeSource.isPending}
              >
                Remove
              </Button>
            </>
          ) : null}

          {codeSource?.status === 'cloning' ? (
            <span className="flex items-center gap-2 font-mono text-sm text-primary">
              <span className="ns-live-mark h-[7px] w-[7px] flex-none bg-current" aria-hidden />
              Cloning…
            </span>
          ) : codeSource?.status === 'ready' ? (
            <span className="flex items-center gap-2 font-mono text-sm text-success">
              <span className="h-[7px] w-[7px] flex-none bg-current" aria-hidden />
              {commit ? `Ready · ${commit}` : 'Ready'}
            </span>
          ) : null}
        </div>

        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
      </div>
    </DisclosurePanel>
  );
}
