import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ModelSettingsPanel from './ModelSettingsPanel';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@shared/api', () => ({ fetchApi: api }));

// The three choices are tested on their own; here only when they show.
vi.mock('./ModelConnect', () => ({
  default: ({ returnTo }: { returnTo: string }) => <div data-testid="model-connect">{returnTo}</div>,
}));

const PROVIDERS = [{ id: 'ANTHROPIC', label: 'Claude', keyUrl: 'https://console.anthropic.com/settings/keys' }];

const CLAUDE = {
  method: 'api_key',
  provider: 'ANTHROPIC',
  model: 'claude-opus-5-5',
  label: 'Claude Opus 5.5',
  account: null,
  server: null,
};

const ok = <T,>(data: T) => Promise.resolve({ data, status: 200, statusText: 'OK' });

let connection: Record<string, unknown> | null;

const renderPanel = (entry = '/settings') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[entry]}>
        <ModelSettingsPanel returnTo="/settings" />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('ModelSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connection = CLAUDE;
    api.get.mockImplementation(() => ok({ connection, providers: PROVIDERS }));
    api.post.mockImplementation((url: string) =>
      url === '/app/model/test'
        ? ok({ ok: true, latencyMs: 940, message: 'The model answered.' })
        : Promise.reject(new Error(`unexpected POST ${url}`)),
    );
    api.delete.mockImplementation(() => {
      connection = null;
      return ok({ disconnected: true, revocationConfirmed: null });
    });
  });

  it('shows the connected model and how it is connected', async () => {
    renderPanel();

    expect(await screen.findByText('claude-opus-5-5')).toBeInTheDocument();
    expect(screen.getByText('Claude · API key · every effort tier uses it')).toBeInTheDocument();
    expect(screen.queryByTestId('model-connect')).toBeNull();
    expect(screen.getByText(/config\/seeds\/models\.seed\.json/)).toBeInTheDocument();
    expect(screen.getByText(/Another provider, or a server you run such as Ollama\?/)).toHaveTextContent(
      'Another provider, or a server you run such as Ollama? Add it to config/seeds/models.seed.json (see config/seeds/README.md). Keys in .env still work.',
    );
  });

  it('names the ChatGPT account', async () => {
    connection = {
      method: 'chatgpt',
      provider: 'OPENAI',
      model: 'gpt-5.5',
      label: 'GPT-5.5',
      account: 'me@example.com',
      server: null,
    };
    renderPanel();

    expect(await screen.findByText('ChatGPT plan · me@example.com · every effort tier uses it')).toBeInTheDocument();
  });

  it('calls a model from the config file your server, not an API key', async () => {
    connection = {
      method: 'api_key',
      provider: 'OPENAI',
      model: 'llama3.1',
      label: 'Llama 3.1 on Ollama',
      account: null,
      server: '127.0.0.1:11434',
    };
    renderPanel();

    expect(await screen.findByText('Your server · 127.0.0.1:11434 · every effort tier uses it')).toBeInTheDocument();
  });

  it('tests the model and says how fast it answered', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Works · answered in 940 ms');
    expect(api.post).toHaveBeenCalledWith('/app/model/test');
  });

  it('shows a failed test in the words the server used', async () => {
    api.post.mockImplementation(() => ok({ ok: false, latencyMs: 20012, message: 'The model did not answer within 20 s.' }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('The model did not answer within 20 s.');
    expect(status).toHaveClass('text-destructive');
  });

  it('opens the three choices to change the model', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));

    expect(screen.getByTestId('model-connect')).toHaveTextContent('/settings');
  });

  it('disconnects, then offers the choices', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/app/model'));
    expect(await screen.findByText('No model is connected. Null needs one to think.')).toBeInTheDocument();
    expect(screen.getByTestId('model-connect')).toBeInTheDocument();
  });

  it('opens the choices when ChatGPT sends the browser back', async () => {
    renderPanel('/settings?chatgpt=connected');

    expect(await screen.findByTestId('model-connect')).toBeInTheDocument();
  });
});
