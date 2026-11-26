import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Code, ListSkeleton, SectionPanel, cn } from '@null-ai/design-tokens/ui';
import { toApiError } from '@shared/lib/apiError';
import {
  useDisconnectModelMutation,
  useModelConnectionQuery,
  useTestModelMutation,
  type ModelConnection,
  type ModelProviderOption,
} from '../api';
import ModelConnect from './ModelConnect';

type TestOutcome = { ok: boolean; text: string };

/** "Claude · API key", "ChatGPT plan · me@example.com", or "Your server · 127.0.0.1:11434". */
const describeModelConnection = (
  connection: ModelConnection,
  providers: ModelProviderOption[],
): string => {
  const provider = providers.find((option) => option.id === connection.provider)?.label ?? connection.provider;
  const method =
    connection.method === 'chatgpt'
      ? ['ChatGPT plan', connection.account].filter(Boolean).join(' · ')
      : connection.server
        ? `Your server · ${connection.server}`
        : `${provider} · API key`;
  return [method, 'every effort tier uses it'].join(' · ');
};

/** Under a second in milliseconds, otherwise in seconds. */
const formatLatency = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * Settings → Model: the one model the agent uses, a test of it, and the three
 * ways to change it. Whatever is connected here is what every effort tier runs.
 */
export default function ModelSettingsPanel({ returnTo }: { returnTo: string }) {
  const [searchParams] = useSearchParams();
  const { data: overview, isLoading } = useModelConnectionQuery();
  const testModel = useTestModelMutation();
  const disconnect = useDisconnectModelMutation();
  // Coming back from ChatGPT lands on the choices, where the outcome is read.
  const [changing, setChanging] = useState(() => searchParams.has('chatgpt'));
  const [test, setTest] = useState<TestOutcome | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (isLoading || !overview) {
    return <ListSkeleton label="Reading the model" rows={2} />;
  }

  const connection = overview.connection;

  const runTest = async () => {
    setTest(null);
    try {
      const result = await testModel.mutateAsync();
      setTest(
        result.ok
          ? { ok: true, text: `Works · answered in ${formatLatency(result.latencyMs)}` }
          : { ok: false, text: result.message },
      );
    } catch (error) {
      const apiError = toApiError(error);
      setTest({ ok: false, text: apiError.userMessage || apiError.message || 'The model did not answer.' });
    }
  };

  const runDisconnect = async () => {
    setActionError(null);
    setTest(null);
    try {
      await disconnect.mutateAsync();
      setChanging(false);
    } catch (error) {
      const apiError = toApiError(error);
      setActionError(apiError.userMessage || apiError.message || 'The model could not be disconnected.');
    }
  };

  return (
    <SectionPanel
      title="Model"
      actions={
        test ? (
          <span
            role="status"
            className={cn('flex items-center gap-2 font-mono text-sm', test.ok ? 'text-success' : 'text-destructive')}
          >
            <span className="h-[7px] w-[7px] flex-none bg-current" aria-hidden />
            {test.text}
          </span>
        ) : undefined
      }
    >
      <div className="flex max-w-2xl flex-col gap-6">
        {connection ? (
          <div className="flex flex-col gap-4 border-b border-border pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="truncate font-mono text-sm font-bold text-foreground">{connection.model}</span>
              <span className="text-sm text-muted-foreground">
                {describeModelConnection(connection, overview.providers)}
              </span>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" size="sm" onClick={() => void runTest()} loading={testModel.isPending}>
                Test
              </Button>
              <Button variant="outline" size="sm" onClick={() => setChanging((value) => !value)} aria-expanded={changing}>
                Change
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:border-destructive/50"
                onClick={() => void runDisconnect()}
                loading={disconnect.isPending}
              >
                Disconnect
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No model is connected. Null needs one to think.</p>
        )}

        {actionError ? (
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
        ) : null}

        {!connection || changing ? <ModelConnect returnTo={returnTo} /> : null}

        <p className="text-sm text-muted-foreground">
          Another provider, or a server you run such as Ollama? Add it to <Code>config/seeds/models.seed.json</Code>{' '}
          (see <Code>config/seeds/README.md</Code>). Keys in <Code>.env</Code> still work.
        </p>
      </div>
    </SectionPanel>
  );
}
