import { describe, expect, it } from 'vitest';
import { MODEL_CATEGORIES } from '@null-ai/contracts';
import { createModelConfigPort } from '@/app/adapters/portFactories';
import { ModelRuntime } from '@/domains/agent-brain/application/orchestration/ModelRuntime';

describe('createModelConfigPort', () => {
  it('redacts undecryptable stored model keys while preserving model metadata', async () => {
    const repo = {
      getById: async () => null,
      getByModelName: async () => ({
        id: 'model-1',
        modelName: 'deepseek-v4-pro',
        provider: 'DEEPSEEK',
        apiKey: 'enc:v1:iv:tag:ciphertext',
        apiBaseUrl: null,
        contextWindow: 128000,
        maxOutputTokens: 8192,
        isDefault: true,
        isActive: true,
        selectionCategory: 'high',
        selectionPriority: 10,
      }),
      getActiveByCategory: async () => null,
      getDefault: async () => null,
    };

    const port = createModelConfigPort(repo as any);

    await expect(port.getByModelName('deepseek-v4-pro')).resolves.toEqual({
      id: 'model-1',
      modelName: 'deepseek-v4-pro',
      provider: 'DEEPSEEK',
      apiKey: undefined,
      apiBaseUrl: undefined,
      runsOnOwnServer: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
      isDefault: true,
      isActive: true,
      selectionCategory: 'high',
      selectionPriority: 10,
      requestProfile: {},
    });
  });

  it('marks a configured model on a server of its own, so it may answer without a key', async () => {
    const row = {
      id: 'local',
      modelName: 'llama3.1',
      provider: 'OPENAI',
      apiKey: null,
      apiBaseUrl: 'http://127.0.0.1:11434/v1',
      isActive: true,
    };
    const port = createModelConfigPort({ getById: async () => row } as any);
    await expect(port.getModel('local')).resolves.toMatchObject({ runsOnOwnServer: true, apiKey: undefined });
  });

  it('every effort tier the run composer offers resolves to the connected model', async () => {
    // The connection: the one active row, holding a plain key (not an `enc:v1:` value).
    const connection = {
      id: 'connection',
      modelName: 'claude-opus-4-8',
      provider: 'ANTHROPIC',
      apiKey: 'sk-ant-fake',
      apiBaseUrl: null,
      isDefault: true,
      isActive: true,
      selectionCategory: 'medium',
    };
    const repo = {
      // The store answers every category with its active rows (ModelRepository.listActiveByCategory).
      listActiveByCategory: async () => [connection],
      getDefault: async () => connection,
    };
    const port = createModelConfigPort(repo as any);
    const runtime = new ModelRuntime();

    for (const category of MODEL_CATEGORIES) {
      await expect(port.listModelsForCategory(category)).resolves.toMatchObject([{ id: 'connection' }]);
      await expect(
        runtime.resolveSessionModel({ modelConfigPort: port, requestedCategory: category }),
      ).resolves.toMatchObject({ id: 'connection', modelName: 'claude-opus-4-8' });
    }
  });
});
