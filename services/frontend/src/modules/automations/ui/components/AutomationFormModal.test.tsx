import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import AutomationFormModal from './AutomationFormModal';
import {
  useAutomationsQuery,
  useCreateAutomationMutation,
  useUpdateAutomationMutation,
} from '@/modules/security-ops/api';
import { useScope } from '@shared/contexts/ScopeContext';
import { useAvailableModelsQuery } from '@/modules/sessions/api';

vi.mock('@/modules/security-ops/api', () => ({
  useAutomationsQuery: vi.fn(),
  useCreateAutomationMutation: vi.fn(),
  useUpdateAutomationMutation: vi.fn(),
}));

vi.mock('@shared/contexts/ScopeContext', () => ({
  useScope: vi.fn(),
}));

vi.mock('@/modules/sessions/api', () => ({
  getModelEffortLabel: (model?: { displayName?: string; category?: string } | null) =>
    model?.displayName ?? model?.category ?? 'Default',
  useAvailableModelsQuery: vi.fn(),
}));

vi.mock('@shared/services/toastService', () => ({
  toastService: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('AutomationFormModal', () => {
  const mutateAsync = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mutateAsync.mockResolvedValue({});
    vi.mocked(useAutomationsQuery).mockReturnValue({ data: [], isLoading: false } as any);
    vi.mocked(useCreateAutomationMutation).mockReturnValue({ mutateAsync, isPending: false } as any);
    vi.mocked(useUpdateAutomationMutation).mockReturnValue({ mutateAsync: vi.fn(), isPending: false } as any);
    vi.mocked(useScope).mockReturnValue({
      activeScopeId: 'scope-1',
      scopes: [{ id: 'scope-1', name: 'Production', complianceFrameworks: ['soc2', 'pci_dss'] }],
      isLoading: false,
    } as any);
    vi.mocked(useAvailableModelsQuery).mockReturnValue({
      data: [
        {
          id: 'medium',
          category: 'medium',
          displayName: 'Medium',
          isDefault: true,
          availableCount: 1,
        },
      ],
      isLoading: false,
    } as any);
  });

  it('submits compliance automations with the selected framework', async () => {
    render(<AutomationFormModal open onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText(/perimeter monitor/i), {
      target: { value: 'PCI automation' },
    });
    fireEvent.click(screen.getByRole('button', { name: /compliance/i }));
    expect(screen.queryByRole('option', { name: /hipaa/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('SOC 2'), {
      target: { value: 'pci_dss' },
    });
    fireEvent.click(screen.getByRole('button', { name: /next phase/i }));

    fireEvent.change(screen.getByPlaceholderText(/specialized strategy/i), {
      target: { value: 'Assess PCI DSS technical readiness for the production scope.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /next phase/i }));
    fireEvent.click(screen.getByRole('button', { name: /next phase/i }));
    fireEvent.click(screen.getByRole('button', { name: /initialize automation/i }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'PCI automation',
          scopeId: 'scope-1',
          workflowDiscipline: 'compliance',
          complianceFrameworkKey: 'pci_dss',
          triggerType: 'scheduled',
        }),
      );
    });
  });

  it('always offers the compliance path: the plan never hides it', () => {
    render(<AutomationFormModal open onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: /pentest/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /compliance/i })).toBeInTheDocument();
  });
});
