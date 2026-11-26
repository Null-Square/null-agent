import { toastService } from '@shared/services/toastService';

/**
 * Lightweight notification helper to centralize toast usage.
 */
export const useNotifier = () => {
  return {
    info: (msg: string) => toastService.info(msg),
    warning: (msg: string) => toastService.warning(msg),
    error: (msg: string) => toastService.error(msg),
    success: (msg: string) => toastService.success(msg),
    clear: () => toastService.dismiss(),
  };
};
