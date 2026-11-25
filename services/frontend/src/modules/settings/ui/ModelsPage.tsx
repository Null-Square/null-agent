import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight } from 'lucide-react';
import { Button, Input, Label, ListPageShell, NativeSelect, SectionPanel, StatusPill } from '@null-ai/design-tokens/ui';
// Provider artwork from OpenAI's sign-in guide and Claude's official site.
import chatgptMark from './chatgpt-mark.svg?url&no-inline';
import claudeMark from './claude-mark.svg?url&no-inline';

type APIProvider = 'openai' | 'anthropic' | 'ollama';
type Connection = {
  provider: APIProvider | 'chatgpt';
  models: { id: string; label: string }[];
  model: string | null;
  email?: string;
};
type ModelState = { connection: Connection | null };

const names = { openai: 'OpenAI API', anthropic: 'Claude API', ollama: 'Ollama', chatgpt: 'ChatGPT subscription' };
const queryKey = ['local-model-connection'];
const providerButton = 'h-12 w-full justify-center gap-3 rounded-lg px-4 font-semibold transition-colors focus-visible:ring-offset-2 focus-visible:ring-offset-background';

async function request<T>(action: string, data?: Record<string, string>) {
  const response = await fetch('/api/local-models/' + action, data ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  } : undefined);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'The request failed. Try again.');
  return result as T;
}

export default function ModelsPage() {
  const cache = useQueryClient();
  const status = useQuery({ queryKey, queryFn: () => request<ModelState>('state'), retry: false });
  const connection = status.data?.connection;
  const [provider, setProvider] = useState<APIProvider>('openai');
  const [apiKey, setAPIKey] = useState('');
  const [notice, setNotice] = useState('');
  const action = useMutation({
    mutationFn: async ({ name, data = {} }: { name: string; data?: Record<string, string> }) => {
      const payload = name === 'connect' && data.provider !== 'ollama' && apiKey.trim()
        ? { ...data, apiKey: apiKey.trim() }
        : data;
      return request<ModelState & { url?: string; ok?: boolean; revoked?: boolean }>(name, payload);
    },
    onSuccess: async (result, { name }) => {
      if (name === 'chatgpt/start' && result.url) {
        window.location.assign(result.url);
        return;
      }
      if (name === 'test') {
        setNotice('Connection test passed. The selected model returned a response.');
        return;
      }
      await cache.cancelQueries({ queryKey });
      cache.setQueryData(queryKey, { connection: result.connection });
      void cache.invalidateQueries({ queryKey: ['model-settings'] });
      if (name === 'connect') {
        setNotice(result.connection?.models.length ? 'Provider connected.' : 'Provider reached. No compatible models were returned.');
      }
      if (name === 'disconnect') setNotice(result.revoked === false
        ? 'Disconnected locally. OpenAI did not confirm remote revocation.'
        : 'Model disconnected.');
    },
    onSettled: (_, __, { name }) => {
      if (name === 'connect') setAPIKey('');
    },
  });

  const run = (name: string, data?: Record<string, string>) => {
    setNotice('');
    action.mutate({ name, data });
  };
  const chooseProvider = (next: APIProvider) => {
    if (next === provider) return;
    setProvider(next);
    setAPIKey('');
    setNotice('');
    if (!action.isPending) action.reset();
  };

  return (
    <ListPageShell title="Models" subtitle="Connect and test a model in your local workspace." className="lg:pl-48">
      <div className="max-w-4xl space-y-6">
        {connection ? (
          <SectionPanel title="Active connection" actions={<StatusPill tone="success">Connected</StatusPill>}>
            <div className="space-y-4">
              <p className="text-sm font-semibold text-foreground">{names[connection.provider]}{connection.email ? ' · ' + connection.email : ''}</p>
              <div className="max-w-md space-y-2">
                <Label htmlFor="local-model">Model</Label>
                <NativeSelect id="local-model" value={connection.model ?? ''} disabled={action.isPending || !connection.models.length}
                  onChange={event => run('select', { model: event.target.value })}>
                  {!connection.models.length ? <option value="">No compatible models available</option> : null}
                  {connection.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
                </NativeSelect>
              </div>
              <p className="text-sm text-muted-foreground">The test sends a small sample request and may use provider quota. The connection lasts until you disconnect, sign out, or restart NullSquare.</p>
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => run('test')} disabled={action.isPending || !connection.model}>
                  {action.isPending && action.variables?.name === 'test' ? 'Testing…' : 'Test connection'}
                </Button>
                <Button variant="outline" onClick={() => run('disconnect')} disabled={action.isPending}>Disconnect</Button>
              </div>
            </div>
          </SectionPanel>
        ) : null}

        {status.isPending || status.error || action.error || notice ? (
          <p role={status.error || action.error ? 'alert' : 'status'} className="text-sm text-muted-foreground">
            {status.error?.message || action.error?.message || notice || 'Checking model connection…'}
          </p>
        ) : null}

        <SectionPanel title="Connect an account">
          <div className="grid max-w-2xl gap-5 md:grid-cols-2">
            <div className="space-y-2">
              <Button
                type="button"
                variant="outline"
                data-oai-siwc-button=""
                aria-describedby="chatgpt-connection-description"
                className={providerButton + ' border-[#d9d9d9] bg-white text-[#0d0d0d] hover:border-[#b7b7b7] hover:bg-[#f2f2f2] hover:text-[#0d0d0d]'}
                onClick={() => run('chatgpt/start')}
                disabled={!status.data || action.isPending || connection?.provider === 'chatgpt'}
              >
                <img src={chatgptMark} alt="" width="21" height="21" className="shrink-0" />
                Continue with ChatGPT
              </Button>
              <p id="chatgpt-connection-description" className="text-sm text-muted-foreground">
                Use an eligible ChatGPT plan.
              </p>
            </div>
            <div className="space-y-2">
              <Button
                asChild
                variant="outline"
                className={providerButton + ' border-[#e2d5c9] bg-[#faf4eb] text-[#26211d] hover:border-[#cbb7a8] hover:bg-[#f1e7da] hover:text-[#26211d]'}
              >
                <a
                  href="https://platform.claude.com/settings/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-describedby="claude-connection-description"
                  onClick={() => chooseProvider('anthropic')}
                >
                  <img src={claudeMark} alt="" width="20" height="20" className="shrink-0" />
                  Continue with Claude
                  <ArrowUpRight aria-hidden="true" className="h-4 w-4 shrink-0 text-[#695347]" />
                </a>
              </Button>
              <p id="claude-connection-description" className="text-sm text-muted-foreground">
                Opens Claude Console in a new tab to get an API key.
              </p>
            </div>
          </div>
        </SectionPanel>

        <SectionPanel title="API key or local model">
          <form className="max-w-md space-y-4" onSubmit={event => {
            event.preventDefault();
            run('connect', { provider });
          }}>
            <div className="space-y-2">
              <Label htmlFor="local-provider">Provider</Label>
              <NativeSelect id="local-provider" value={provider} onChange={event => chooseProvider(event.target.value as APIProvider)}
                disabled={action.isPending}>
                <option value="openai">OpenAI API</option>
                <option value="anthropic">Claude API</option>
                <option value="ollama">Ollama on this computer</option>
              </NativeSelect>
            </div>
            {provider === 'ollama' ? (
              <p className="text-sm text-muted-foreground">Start Ollama and install a local model before connecting.</p>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="local-model-key">API key</Label>
                <Input id="local-model-key" type="password" autoComplete="off" value={apiKey}
                  onChange={event => setAPIKey(event.target.value)} maxLength={768} disabled={action.isPending} />
                <p className="text-sm text-muted-foreground">
                  {provider === 'anthropic'
                    ? 'Paste your Claude Console API key to connect.'
                    : <>Paste an OpenAI project API key. Eligible ChatGPT plans can also fund API use through <a className="underline" href="https://developers.openai.com/api/docs/guides/chatgpt-api-credits" target="_blank" rel="noreferrer">linked API credits</a>.</>}
                </p>
              </div>
            )}
            <Button type="submit" disabled={!status.data || action.isPending}>Connect provider</Button>
          </form>
        </SectionPanel>
      </div>
    </ListPageShell>
  );
}
