import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AutomationDetailPage from './AutomationDetailPage';
import {
  useAutomationDetailQuery,
  useToggleAutomationMutation,
  useRunAutomationNowMutation,
  useDeleteAutomationMutation,
  useCreateAutomationMutation,
  useUpdateAutomationMutation,
  useRunsQuery,
} from '@/modules/security-ops/api';
import { useScope } from '@shared/contexts/ScopeContext';
import { useAvailableModelsQuery } from '@/modules/sessions/api';

vi.mock('@/modules/security-ops/api', () => ({
  useAutomationDetailQuery: vi.fn(),
  useToggleAutomationMutation: vi.fn(),
  useRunAutomationNowMutation: vi.fn(),
  useDeleteAutomationMutation: vi.fn(),
  useCreateAutomationMutation: vi.fn(),
  useUpdateAutomationMutation: vi.fn(),
  useRunsQuery: vi.fn(),
  useAutomationsQuery: vi.fn(() => ({ data: [], isLoading: false })),
}));

vi.mock('@shared/contexts/ScopeContext', () => ({
  useScope: vi.fn(),
}));

vi.mock('@/modules/sessions/api', () => ({
  getModelEffortLabel: (model: { category: string }) => `${model.category[0]?.toUpperCase()}${model.category.slice(1)}`,
  useAvailableModelsQuery: vi.fn(),
}));

const mockUseAutomationDetailQuery = vi.mocked(useAutomationDetailQuery);
const mockUseRunsQuery = vi.mocked(useRunsQuery);
const mockMutation = { mutate: vi.fn(), isPending: false } as any;
const mockUseScope = vi.mocked(useScope);
const mockUseAvailableModelsQuery = vi.mocked(useAvailableModelsQuery);

describe('AutomationDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseScope.mockReturnValue({
       scopes: [{ id: 'scope-1', name: 'Production' }] 
    } as any);
    vi.mocked(useToggleAutomationMutation).mockReturnValue(mockMutation);
    vi.mocked(useRunAutomationNowMutation).mockReturnValue(mockMutation);
    vi.mocked(useDeleteAutomationMutation).mockReturnValue(mockMutation);
    vi.mocked(useCreateAutomationMutation).mockReturnValue(mockMutation);
    vi.mocked(useUpdateAutomationMutation).mockReturnValue(mockMutation);
    mockUseRunsQuery.mockReturnValue({ data: [], isLoading: false } as any);
    mockUseAvailableModelsQuery.mockReturnValue({
      data: [
        {
          id: 'medium',
          category: 'medium',
          displayName: 'Medium',
          description: 'Balanced category',
          isDefault: true,
          availableCount: 1,
        },
      ],
      isLoading: false,
    } as any);

    mockUseAutomationDetailQuery.mockReturnValue({
      data: {
        id: 'auto-1',
        name: 'Daily Scan',
        scopeName: 'Production',
        scopeId: 'scope-1',
        modelCategory: 'medium',
        workflowDiscipline: 'compliance',
        complianceFrameworkKey: 'soc2',
        executionTarget: 'cloud',
        goal: 'Attack surface discovery for the production scope',
        triggerType: 'scheduled',
        triggerConfig: { type: 'scheduled', cron: '0 0 * * *', timezone: 'UTC' },
        isActive: true,
        nextRunAt: new Date().toISOString(),
        lastRunAt: new Date().toISOString(),
        deferredReason: null,
        deferredAt: null,
        runs: [],
      },
      isLoading: false,
    } as any);
  });

  it('renders automation details', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/automations/auto-1']}>
        <Routes>
          <Route path="/settings/automations/:id" element={<AutomationDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText('Daily Scan')).toBeTruthy();
    expect(screen.getByText('Production')).toBeTruthy();
    expect(screen.getByText('Medium')).toBeTruthy();
    expect(screen.getByText('Compliance - SOC 2')).toBeTruthy();
    expect(screen.getByText('0 0 * * *')).toBeTruthy();
  });

  it('renders not found state', () => {
    mockUseAutomationDetailQuery.mockReturnValue({ data: undefined, isLoading: false } as any);
    render(
      <MemoryRouter initialEntries={['/settings/automations/bad-id']}>
        <Routes>
          <Route path="/settings/automations/:id" element={<AutomationDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    // The shared empty state carries the message now, not a page heading.
    expect(screen.getByText('Automation not found')).toBeTruthy();
  });
});
