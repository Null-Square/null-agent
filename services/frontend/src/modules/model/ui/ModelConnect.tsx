import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Input, Label, NativeSelect, cn } from '@null-ai/design-tokens/ui';
import { toApiError } from '@shared/lib/apiError';
import {
  isKeyProvider,
  useChatGptModelsQuery,
  useConnectModelMutation,
  useKeyModelsMutation,
  useModelConnectionQuery,
  useStartChatGptMutation,
  type KeyProvider,
  type ModelChoice,
  type ModelProviderOption,
} from '../api';

type Choice = 'chatgpt' | 'claude' | 'other';

/* Where ChatGPT sends the browser back: `?chatgpt=<outcome>&reason=<why>`. */
type ChatGptReturn = { outcome: string; reason: string | null };

const CHATGPT_ERRORS: Record<string, string> = {
  expired: 'This sign-in expired or was already used. Start it again.',
  denied: 'Sign-in with ChatGPT was cancelled.',
  incomplete: 'ChatGPT did not finish the sign-in. Start it again.',
  refused: 'ChatGPT could not complete the sign-in. Start it again.',
  other_account: 'That is a different ChatGPT account from the one Null AI signed in with before.',
  invalid: 'The sign-in answered for another registration. Start it again.',
};

const chatGptReturnText = (result: ChatGptReturn): string | null => {
  switch (result.outcome) {
    case 'connected':
      return null;
    case 'no_plan':
      return 'You signed in, but ChatGPT did not allow plan usage, so nothing was connected.';
    case 'no_models':
      return 'You signed in, but your plan’s models could not be listed yet. Try again in a moment.';
    default:
      return (result.reason ? CHATGPT_ERRORS[result.reason] : undefined) ?? 'Sign-in with ChatGPT did not finish. Start it again.';
  }
};

const errorText = (error: unknown, fallback: string): string => {
  const apiError = toApiError(error);
  return apiError.userMessage || apiError.message || fallback;
};

function StatusLine({ tone, children }: { tone: 'busy' | 'ok' | 'bad'; children: ReactNode }) {
  return (
    <p
      role={tone === 'bad' ? 'alert' : 'status'}
      className={cn(
        'flex items-center gap-2 font-mono text-sm',
        tone === 'busy' && 'text-primary',
        tone === 'ok' && 'text-success',
        tone === 'bad' && 'text-destructive',
      )}
    >
      <span className={cn('h-[7px] w-[7px] flex-none bg-current', tone === 'busy' && 'ns-live-mark')} aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function ModelPicker({
  models,
  value,
  onChange,
  markNewest,
  disabled,
}: {
  models: ModelChoice[];
  value: string;
  onChange: (model: string) => void;
  markNewest: boolean;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="model-picker">Model</Label>
      <NativeSelect
        id="model-picker"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="font-mono"
      >
        {models.map((model, index) => (
          <option key={model.id} value={model.id}>
            {markNewest && index === 0 ? `${model.label} (newest)` : model.label}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

/**
 * A key, its model list and the pick. The list is the check: the provider is
 * asked for its models with the key, which costs nothing, and the newest one is
 * connected straight away. Picking another connects that one instead.
 */
function KeyConnect({ provider, providerLabel, keyUrl }: { provider: KeyProvider; providerLabel: string; keyUrl: string | null }) {
  const keyModels = useKeyModelsMutation();
  const connect = useConnectModelMutation();
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ModelChoice[] | null>(null);
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const connectModel = async (nextModel: string, key: string) => {
    setModel(nextModel);
    setError(null);
    try {
      await connect.mutateAsync({ method: 'api_key', provider, model: nextModel, apiKey: key });
    } catch (connectError) {
      setError(errorText(connectError, 'This model could not be connected.'));
    }
  };

  const checkKey = async () => {
    const key = apiKey.trim();
    if (!key) return;
    setError(null);
    setModels(null);
    try {
      const listed = await keyModels.mutateAsync({ provider, apiKey: key });
      if (listed.length === 0) {
        setError(`This key works, but ${providerLabel} lists no chat models for it.`);
        return;
      }
      setModels(listed);
      await connectModel(listed[0].id, key);
    } catch (keyError) {
      setError(errorText(keyError, 'This key was refused.'));
    }
  };

  const checking = keyModels.isPending || connect.isPending;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Input
          type="password"
          aria-label={`${providerLabel} API key`}
          placeholder={`${providerLabel} API key`}
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value);
            setModels(null);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void checkKey();
          }}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
        <Button variant="outline" onClick={() => void checkKey()} disabled={!apiKey.trim() || checking}>
          Check key
        </Button>
      </div>
      {keyUrl ? (
        <p className="text-sm text-muted-foreground">
          No key yet?{' '}
          <a href={keyUrl} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">
            Get one {provider === 'ANTHROPIC' ? 'in Claude Console' : `from ${providerLabel}`} ↗
          </a>
        </p>
      ) : null}

      {keyModels.isPending ? <StatusLine tone="busy">Checking…</StatusLine> : null}
      {models && !error ? (
        <StatusLine tone={connect.isPending ? 'busy' : 'ok'}>
          Key works. {providerLabel} has {models.length} {models.length === 1 ? 'model' : 'models'} for you.
        </StatusLine>
      ) : null}
      {error ? <StatusLine tone="bad">{error}</StatusLine> : null}

      {models ? (
        <ModelPicker
          models={models}
          value={model}
          onChange={(next) => void connectModel(next, apiKey.trim())}
          markNewest
          disabled={checking}
        />
      ) : null}
    </div>
  );
}

/** After the sign-in: the plan's models, the first connected unless one already is. */
function ChatGptModels() {
  const { data: overview } = useModelConnectionQuery();
  const { mutateAsync: connectAsync, isPending: connecting } = useConnectModelMutation();
  const { data: models, isLoading, error: listError } = useChatGptModelsQuery();
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connection = overview?.connection ?? null;
  const connectedModel = connection?.method === 'chatgpt' ? connection.model : null;
  const firstModel = models?.[0]?.id ?? null;

  const autoConnected = useRef(false);
  useEffect(() => {
    if (!firstModel || connectedModel || autoConnected.current) return;
    autoConnected.current = true;
    connectAsync({ method: 'chatgpt', model: firstModel }).catch((connectError: unknown) =>
      setError(errorText(connectError, 'This model could not be connected.')),
    );
  }, [connectAsync, connectedModel, firstModel]);

  const pick = (next: string) => {
    setPicked(next);
    setError(null);
    connectAsync({ method: 'chatgpt', model: next }).catch((connectError: unknown) =>
      setError(errorText(connectError, 'This model could not be connected.')),
    );
  };

  if (isLoading) return <StatusLine tone="busy">Listing your plan’s models…</StatusLine>;
  if (listError) return <StatusLine tone="bad">{errorText(listError, 'Your plan’s models could not be listed.')}</StatusLine>;
  if (!models || models.length === 0) {
    return <StatusLine tone="bad">You signed in, but your plan lists no models yet.</StatusLine>;
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <StatusLine tone="bad">{error}</StatusLine>
      ) : (
        <StatusLine tone={connecting ? 'busy' : 'ok'}>
          Signed in with ChatGPT{connection?.account ? ` as ${connection.account}` : ''}.
        </StatusLine>
      )}
      <ModelPicker
        models={models}
        value={picked ?? connectedModel ?? firstModel ?? ''}
        onChange={pick}
        markNewest={false}
        disabled={connecting}
      />
    </div>
  );
}

function ChoiceCard({
  title,
  subtitle,
  open,
  light = false,
  signInWithChatGpt = false,
  onSelect,
  disabled = false,
  children,
}: {
  title: string;
  subtitle: string;
  open: boolean;
  light?: boolean;
  /** Marks OpenAI's "Sign in with ChatGPT" button, as its button guidance asks. */
  signInWithChatGpt?: boolean;
  onSelect: () => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'border text-left transition-colors',
        light ? 'border-foreground bg-foreground text-background' : 'border-border',
        !light && open && 'border-primary',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        aria-expanded={children ? open : undefined}
        {...(signInWithChatGpt ? { 'data-oai-siwc-button': '' } : {})}
        className={cn(
          'flex w-full flex-col gap-0.5 px-4 py-3 text-left disabled:cursor-wait',
          !light && 'hover:bg-muted/30',
        )}
      >
        <span className="text-sm font-bold">{title}</span>
        <span className={cn('text-sm', light ? 'text-background/60' : 'text-muted-foreground')}>{subtitle}</span>
      </button>
      {open && children ? (
        <div className={cn('flex flex-col gap-3 px-4 pb-4', light && 'bg-background pt-4 text-foreground')}>{children}</div>
      ) : null}
    </div>
  );
}

/**
 * The three ways to give Null a model: a ChatGPT plan, a Claude API key, or a
 * key for another provider. The connection itself is the server's; this only
 * asks for it.
 */
export default function ModelConnect({ returnTo }: { returnTo: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: overview } = useModelConnectionQuery();
  const startChatGpt = useStartChatGptMutation();

  // Read once: the address is cleaned straight after.
  const [chatGptReturn] = useState<ChatGptReturn | null>(() => {
    const outcome = searchParams.get('chatgpt');
    return outcome ? { outcome, reason: searchParams.get('reason') } : null;
  });
  useEffect(() => {
    if (!searchParams.has('chatgpt')) return;
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete('chatgpt');
        next.delete('reason');
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams]);

  const [open, setOpen] = useState<Choice | null>(chatGptReturn ? 'chatgpt' : null);
  const [startError, setStartError] = useState<string | null>(null);

  const providers: ModelProviderOption[] = overview?.providers ?? [];
  const claude = providers.find((provider) => provider.id === 'ANTHROPIC') ?? null;
  const others = providers.filter(
    (provider): provider is ModelProviderOption & { id: KeyProvider } =>
      provider.id !== 'ANTHROPIC' && isKeyProvider(provider.id),
  );
  const [otherId, setOtherId] = useState<string>('');
  const other = others.find((provider) => provider.id === otherId) ?? others[0] ?? null;

  const signInWithChatGpt = async () => {
    setOpen('chatgpt');
    setStartError(null);
    try {
      const url = await startChatGpt.mutateAsync(returnTo);
      window.location.assign(url);
    } catch (error) {
      setStartError(errorText(error, 'Sign-in with ChatGPT could not start.'));
    }
  };

  const returnText = chatGptReturn ? chatGptReturnText(chatGptReturn) : null;
  const chatGptBody =
    startError || returnText || chatGptReturn?.outcome === 'connected' || startChatGpt.isPending ? (
      <>
        {startChatGpt.isPending ? <StatusLine tone="busy">Opening ChatGPT…</StatusLine> : null}
        {startError ? <StatusLine tone="bad">{startError}</StatusLine> : null}
        {!startError && returnText ? <StatusLine tone="bad">{returnText}</StatusLine> : null}
        {!startError && chatGptReturn?.outcome === 'connected' ? <ChatGptModels /> : null}
      </>
    ) : null;

  return (
    <div className="flex w-full flex-col gap-2 text-left">
      <ChoiceCard
        title="Continue with ChatGPT"
        subtitle="Use your ChatGPT plan"
        light
        signInWithChatGpt
        open={open === 'chatgpt'}
        onSelect={() => void signInWithChatGpt()}
        disabled={startChatGpt.isPending}
      >
        {chatGptBody}
      </ChoiceCard>

      <ChoiceCard
        title="Claude"
        subtitle="With a Claude API key"
        open={open === 'claude'}
        onSelect={() => setOpen(open === 'claude' ? null : 'claude')}
      >
        <KeyConnect provider="ANTHROPIC" providerLabel={claude?.label ?? 'Claude'} keyUrl={claude?.keyUrl ?? null} />
      </ChoiceCard>

      <ChoiceCard
        title="Another provider"
        subtitle="OpenAI, DeepSeek, Qwen or Moonshot, with an API key"
        open={open === 'other'}
        onSelect={() => setOpen(open === 'other' ? null : 'other')}
      >
        {other ? (
          <>
            <div className="flex flex-col gap-2">
              <Label htmlFor="model-provider">Provider</Label>
              <NativeSelect
                id="model-provider"
                value={other.id}
                onChange={(event) => setOtherId(event.target.value)}
              >
                {others.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <KeyConnect key={other.id} provider={other.id} providerLabel={other.label} keyUrl={other.keyUrl || null} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No other provider is offered.</p>
        )}
      </ChoiceCard>
    </div>
  );
}
