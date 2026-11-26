import type { ModelCategory } from '@null-ai/contracts';

export type ModelConfig = {
  id?: string;
  modelName: string;
  provider: string;
  apiKey?: string | null;
  apiBaseUrl?: string | null;
  /**
   * Set by the model store from its activation rule: the base URL is not the provider's public
   * API, so the model may answer without a key (a local server often takes none).
   */
  runsOnOwnServer?: boolean;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  isDefault?: boolean;
  isActive?: boolean;
  selectionCategory?: ModelCategory | null;
  selectionPriority?: number | null;
  requestProfile?: Record<string, unknown>;
};

export interface ModelConfigPort {
  getModel(id: string): Promise<ModelConfig | null>;
  getByModelName(modelName: string): Promise<ModelConfig | null>;
  listModelsForCategory(category: ModelCategory): Promise<ModelConfig[]>;
  getDefaultModel(): Promise<ModelConfig | null>;
}
