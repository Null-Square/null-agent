import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { toastService } from '@shared/services/toastService';
import { useNotifier } from './useNotifier';

const toastServiceMock = vi.hoisted(() => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock('@shared/services/toastService', () => ({
  toastService: toastServiceMock,
}));

describe('useNotifier', () => {
  it('routes messages to the toast helpers', () => {
    const { result } = renderHook(() => useNotifier());

    result.current.info('info');
    expect(toastService.info).toHaveBeenCalledWith('info');

    result.current.warning('warning');
    expect(toastService.warning).toHaveBeenCalledWith('warning');

    result.current.error('error');
    expect(toastService.error).toHaveBeenCalledWith('error');

    result.current.success('success');
    expect(toastService.success).toHaveBeenCalledWith('success');

    result.current.clear();
    expect(toastService.dismiss).toHaveBeenCalled();
  });
});
