import type { ProviderFactoryPort, ChatProvider, ModelConfigPort } from '../../ports';
import type { ResolvedConfig } from '@/config/configTypes';
import { ProviderFactory } from './ProviderFactory';

export class ProviderFactoryAdapter implements ProviderFactoryPort {
  private readonly factory: ProviderFactory;

  constructor(config: ResolvedConfig, modelConfigPort: ModelConfigPort) {
    this.factory = new ProviderFactory(config, modelConfigPort);
  }

  async create(modelName: string, modelId?: string): Promise<ChatProvider> {
    return this.factory.create(modelName, modelId);
  }
}
