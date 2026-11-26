import type { AIChatConfig } from '@/types/chat';
import type { ConfigAction } from '../slices/configSlice';

export const setConfig = (config: Partial<AIChatConfig>): ConfigAction => ({
  type: 'config/set',
  payload: config,
});

export const setUsage = (usage: AIChatConfig['usage']): ConfigAction => ({
  type: 'config/setUsage',
  payload: usage,
});
