import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ModelConnect from './ModelConnect';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@shared/api', () => ({ fetchApi: api }));

const PROVIDERS = [
  { id: 'ANTHROPIC', label: 'Claude', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'OPENAI', label: 'OpenAI', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'DEEPSEEK', label: 'DeepSeek', keyUrl: 'https://platform.deepseek.com/api_keys' },
];

const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'claude-opus-5-5' },
  { id: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5' },
  { id: 'claude-haiku-5-5', label: 'claude-haiku-5-5' },
];

const ok = <T,>(data: T) => Promise.resolve({ data, status: 200, statusText: 'OK' });

const refused = (userMessage: string) => ({
  response: {
    status: 400,
    data: { code: 'validation.constraint_violated', message: userMessage, httpStatus: 400, userMessage },
  },
});

let overview: { connection: Record<string, unknown> | null; providers: typeof PROVIDERS };

function Address() {
  const location = useLocation();
  return <output data-testid="address">{`${location.pathname}${location.search}`}</output>;
}

const renderConnect = (entry = '/setup') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[entry]}>
        <ModelConnect returnTo="/setup" />
        <Address />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('ModelConnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    overview = { connection: null, providers: PROVIDERS };
    api.get.mockImplementation((url: string) => {
      if (url === '/app/model') return ok(overview);
      if (url === '/app/model/chatgpt/models') return ok({ models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }] });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    api.post.mockImplementation((url: string, body: Record<string, unknown>) => {
      if (url === '/app/model/key') return ok({ models: CLAUDE_MODELS });
      if (url === '/app/model/connect') {
        return ok({
          connection: {
            method: body.method,
            provider: body.provider ?? 'OPENAI',
            model: body.model,
            label: String(body.model),
            account: null,
            server: null,
          },
        });
      }
      if (url === '/app/model/chatgpt/start') return ok({ url: 'https://auth.openai.com/authorize?x=1' });
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers the three ways to connect', () => {
    renderConnect();

    expect(screen.getByRole('button', { name: /continue with chatgpt/i })).toHaveTextContent('Use your ChatGPT plan');
    expect(screen.getByRole('button', { name: /continue with chatgpt/i })).toHaveAttribute('data-oai-siwc-button');
    expect(screen.getByRole('button', { name: /^claude/i })).toHaveTextContent('With a Claude API key');
    expect(screen.getByRole('button', { name: /another provider/i })).toHaveTextContent(
      'OpenAI, DeepSeek, Qwen or Moonshot, with an API key',
    );
  });

  it('checks a Claude key, connects the newest model, and connects another when picked', async () => {
    renderConnect();
    fireEvent.click(screen.getByRole('button', { name: /^claude/i }));

    expect(await screen.findByRole('link', { name: /get one in claude console/i })).toHaveAttribute(
      'href',
      'https://console.anthropic.com/settings/keys',
    );

    fireEvent.change(screen.getByLabelText('Claude API key'), { target: { value: ' sk-ant-test ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check key' }));

    expect(await screen.findByText('Key works. Claude has 3 models for you.')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/app/model/key', { provider: 'ANTHROPIC', apiKey: 'sk-ant-test' });
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/app/model/connect', {
        method: 'api_key',
        provider: 'ANTHROPIC',
        model: 'claude-opus-5-5',
        apiKey: 'sk-ant-test',
      }),
    );

    const picker = screen.getByLabelText('Model');
    expect(picker).toHaveValue('claude-opus-5-5');
    expect(screen.getByRole('option', { name: 'claude-opus-5-5 (newest)' })).toBeInTheDocument();

    fireEvent.change(picker, { target: { value: 'claude-sonnet-5-5' } });
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/app/model/connect', {
        method: 'api_key',
        provider: 'ANTHROPIC',
        model: 'claude-sonnet-5-5',
        apiKey: 'sk-ant-test',
      }),
    );
  });

  it('shows a refused key in the words the server used', async () => {
    api.post.mockImplementation((url: string) =>
      url === '/app/model/key'
        ? Promise.reject(refused('Anthropic refused this key. Check it in the Claude Console.'))
        : Promise.reject(new Error(`unexpected POST ${url}`)),
    );
    renderConnect();
    fireEvent.click(screen.getByRole('button', { name: /^claude/i }));
    fireEvent.change(screen.getByLabelText('Claude API key'), { target: { value: 'sk-ant-wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check key' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Anthropic refused this key. Check it in the Claude Console.',
    );
    expect(api.post).not.toHaveBeenCalledWith('/app/model/connect', expect.anything());
    expect(screen.queryByLabelText('Model')).toBeNull();
  });

  it('lists the other providers, without Claude, and checks a key for the one chosen', async () => {
    renderConnect();
    fireEvent.click(screen.getByRole('button', { name: /another provider/i }));

    const provider = await screen.findByLabelText('Provider');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['OpenAI', 'DeepSeek']);

    fireEvent.change(provider, { target: { value: 'DEEPSEEK' } });
    expect(screen.getByRole('link', { name: /get one from deepseek/i })).toHaveAttribute(
      'href',
      'https://platform.deepseek.com/api_keys',
    );
    fireEvent.change(screen.getByLabelText('DeepSeek API key'), { target: { value: 'sk-deep' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check key' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/app/model/key', { provider: 'DEEPSEEK', apiKey: 'sk-deep' }),
    );
  });

  it('sends the browser to ChatGPT to sign in, coming back to the given path', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as Location);
    renderConnect();

    fireEvent.click(screen.getByRole('button', { name: /continue with chatgpt/i }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://auth.openai.com/authorize?x=1'));
    expect(api.post).toHaveBeenCalledWith('/app/model/chatgpt/start', { returnTo: '/setup' });
  });

  it('after a ChatGPT sign-in, connects the plan model and cleans the address', async () => {
    renderConnect('/setup?chatgpt=connected');

    expect(await screen.findByText('Signed in with ChatGPT.')).toBeInTheDocument();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/app/model/connect', { method: 'chatgpt', model: 'gpt-5.5' }),
    );
    expect(screen.getByLabelText('Model')).toHaveValue('gpt-5.5');
    expect(screen.getByTestId('address')).toHaveTextContent(/^\/setup$/);
  });

  it('does not connect again a plan model that is already connected', async () => {
    overview = {
      connection: { method: 'chatgpt', provider: 'OPENAI', model: 'gpt-5.5', label: 'GPT-5.5', account: 'me@example.com', server: null },
      providers: PROVIDERS,
    };
    renderConnect('/setup?chatgpt=connected');

    expect(await screen.findByText('Signed in with ChatGPT as me@example.com.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalledWith('/app/model/connect', expect.anything());
  });

  it.each([
    ['/setup?chatgpt=no_plan', 'You signed in, but ChatGPT did not allow plan usage, so nothing was connected.'],
    ['/setup?chatgpt=no_models', 'You signed in, but your plan’s models could not be listed yet. Try again in a moment.'],
    ['/setup?chatgpt=error&reason=denied', 'Sign-in with ChatGPT was cancelled.'],
    ['/setup?chatgpt=error&reason=expired', 'This sign-in expired or was already used. Start it again.'],
    ['/setup?chatgpt=error', 'Sign-in with ChatGPT did not finish. Start it again.'],
  ])('says in plain words how the sign-in ended: %s', async (entry, text) => {
    renderConnect(entry);

    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.getByTestId('address')).toHaveTextContent(/^\/setup$/);
    expect(api.post).not.toHaveBeenCalledWith('/app/model/connect', expect.anything());
  });
});
