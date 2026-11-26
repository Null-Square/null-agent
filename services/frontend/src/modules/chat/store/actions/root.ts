import type { FeatureResetAction } from '../types';

export const resetFeatureState = (): FeatureResetAction => ({
  type: 'feature/reset',
});
