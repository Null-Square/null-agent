import { useCallback } from 'react';
import { toastService } from '@shared/services/toastService';

/**
 * Chat toast bridge to the global toastService so chat toasts match the rest of the app.
 * We keep the same signature but delegate rendering to the shared toaster.
 */
export const useToast = () => {
  const clear = useCallback(() => {
    // no-op: global toaster manages its own lifecycle
  }, []);

  const push = useCallback((text: string) => {
    if (!text) return;
    toastService.warning('Notice', text);
  }, []);

  return { toastMessage: '', pushToast: push, clearToast: clear };
};
