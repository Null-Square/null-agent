import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchApi, type paths } from '@shared/api';

/* Every shape here is the API's own, read from the generated schema. */
export type ModelOverview =
  paths['/api/app/model']['get']['responses'][200]['content']['application/json'];
export type ModelConnection = NonNullable<ModelOverview['connection']>;
export type ModelProviderOption = ModelOverview['providers'][number];
export type KeyProvider =
  paths['/api/app/model/key']['post']['requestBody']['content']['application/json']['provider'];
export type ModelChoice =
  paths['/api/app/model/key']['post']['responses'][200]['content']['application/json']['models'][number];
export type ModelConnectBody =
  paths['/api/app/model/connect']['post']['requestBody']['content']['application/json'];
export type ModelTestResult =
  paths['/api/app/model/test']['post']['responses'][200]['content']['application/json'];

/* The providers an API key can be checked against, as the key route accepts them. */
const KEY_PROVIDERS: ReadonlySet<string> = new Set<KeyProvider>(['ANTHROPIC', 'OPENAI', 'DEEPSEEK', 'QWEN', 'MOONSHOT']);

export const isKeyProvider = (id: string): id is KeyProvider => KEY_PROVIDERS.has(id);

export const modelConnectionQueryKey = ['model-connection'] as const;

export const fetchModelOverview = async (): Promise<ModelOverview> =>
  (await fetchApi.get<ModelOverview>('/app/model')).data;

/** The one model the agent uses, and the providers a key can be added for. */
export const useModelConnectionQuery = () =>
  useQuery({ queryKey: modelConnectionQueryKey, queryFn: fetchModelOverview });

const useSettleConnection = () => {
  const queryClient = useQueryClient();
  return (connection: ModelConnection | null) => {
    queryClient.setQueryData<ModelOverview>(modelConnectionQueryKey, (previous) =>
      previous ? { ...previous, connection } : previous,
    );
    void queryClient.invalidateQueries({ queryKey: modelConnectionQueryKey });
    // The effort tiers on the home list what the connected model offers.
    void queryClient.invalidateQueries({ queryKey: ['agent-models'] });
  };
};

/** Checks a key by listing the provider's chat models, newest first. Saves nothing. */
export const useKeyModelsMutation = () =>
  useMutation({
    mutationFn: async (body: { provider: KeyProvider; apiKey: string }) =>
      (await fetchApi.post<{ models: ModelChoice[] }>('/app/model/key', body)).data.models,
  });

/** The signed-in ChatGPT plan's models, in the server's order. */
export const useChatGptModelsQuery = () =>
  useQuery({
    queryKey: ['chatgpt-models'],
    queryFn: async () =>
      (await fetchApi.get<{ models: ModelChoice[] }>('/app/model/chatgpt/models')).data.models,
  });

export const useConnectModelMutation = () => {
  const settle = useSettleConnection();
  return useMutation({
    mutationFn: async (body: ModelConnectBody) =>
      (await fetchApi.post<{ connection: ModelConnection }>('/app/model/connect', body)).data.connection,
    onSuccess: (connection) => settle(connection),
  });
};

/** The authorization URL to open; ChatGPT returns to `returnTo` with `?chatgpt=<outcome>`. */
export const useStartChatGptMutation = () =>
  useMutation({
    mutationFn: async (returnTo: string) =>
      (await fetchApi.post<{ url: string }>('/app/model/chatgpt/start', { returnTo })).data.url,
  });

export const useTestModelMutation = () =>
  useMutation({
    mutationFn: async () => (await fetchApi.post<ModelTestResult>('/app/model/test')).data,
  });

export const useDisconnectModelMutation = () => {
  const settle = useSettleConnection();
  return useMutation({
    mutationFn: async () => {
      await fetchApi.delete('/app/model');
    },
    onSuccess: () => settle(null),
  });
};
