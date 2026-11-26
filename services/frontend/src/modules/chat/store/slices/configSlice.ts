import type { AIChatConfig } from '@/types/chat';

export interface ConfigState {
  value: AIChatConfig;
}

export type ConfigAction =
  | { type: 'config/set'; payload: Partial<AIChatConfig> }
  | { type: 'config/setUsage'; payload: AIChatConfig['usage'] };

export const initialConfigState: ConfigState = {
  value: {
    title: 'NULL AI.',
    subtitle: 'Your AI Security Assistant. Analyze, detect, and protect your digital assets',
    placeholder: 'Analyze my',
    conversationPlaceholder:
      'Ask NULL AI anything about your security or infrastructure concerns...',
  },
};

export const configReducer = (
  state: ConfigState = initialConfigState,
  action: ConfigAction
): ConfigState => {
  switch (action.type) {
    case 'config/set':
      return { ...state, value: { ...state.value, ...action.payload } };
    case 'config/setUsage':
      return {
        ...state,
        value: {
          ...state.value,
          usage: { ...(state.value.usage ?? {}), ...(action.payload ?? {}) },
        },
      };
    default:
      return state;
  }
};

export const configSelectors = {
  value: (state: ConfigState) => state.value,
};
