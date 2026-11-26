import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SettingsAuditLogs from './SettingsAuditLogs';
import { useAuditLogsQuery } from '@/modules/security-ops/api';

vi.mock('@/modules/security-ops/api', () => ({
  useAuditLogsQuery: vi.fn(),
}));

// Spread the real kit rather than listing what this file happens to use: a
// hand-written stub breaks the day the component imports one more thing from
// it, which is a test failure that says nothing about the component.
vi.mock('@null-ai/design-tokens/ui', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@null-ai/design-tokens/ui')),
}));

const mockUseAuditLogsQuery = vi.mocked(useAuditLogsQuery);

describe('SettingsAuditLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state', () => {
    mockUseAuditLogsQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    } as any);

    render(
      <MemoryRouter>
        <SettingsAuditLogs />
      </MemoryRouter>
    );

    // Addressed by role, not by class name. The previous assertion counted
    // `.animate-pulse` nodes, which meant this test PASSED ONLY WHILE the
    // skeleton kept the one animation the brand forbids — a test holding a
    // defect in place. `ListSkeleton` announces itself as a live region, and
    // that is the thing a reader actually depends on.
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders error state', () => {
    mockUseAuditLogsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Failed'),
      refetch: vi.fn(),
    } as any);

    render(
      <MemoryRouter>
        <SettingsAuditLogs />
      </MemoryRouter>
    );

    expect(screen.getByText('Could not load the audit log')).toBeInTheDocument();
  });

  it('renders empty state', () => {
    mockUseAuditLogsQuery.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as any);

    render(
      <MemoryRouter>
        <SettingsAuditLogs />
      </MemoryRouter>
    );

    expect(screen.getByText('No audited actions yet')).toBeInTheDocument();
  });

  it('renders logs and filters', async () => {
    const logs = [
      {
        id: 'log-1',
        createdAt: new Date().toISOString(),
        actorId: 'user-1',
        actorType: 'user',
        action: 'create_scope',
        resourceType: 'scope',
        resourceId: 'scope-1',
        changes: {},
        metadata: {},
      },
    ];

    mockUseAuditLogsQuery.mockReturnValue({
      data: logs,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as any);

    render(
      <MemoryRouter>
        <SettingsAuditLogs />
      </MemoryRouter>
    );

    expect(screen.getByText('create_scope')).toBeInTheDocument();
    expect(screen.getByText('scope')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/create_scope/)).toBeInTheDocument();
  });

  it('opens details sheet on row click', async () => {
     const logs = [
      {
        id: 'log-1',
        createdAt: new Date().toISOString(),
        actorId: 'user-1',
        actorType: 'user',
        action: 'critical_action',
        resourceType: 'system',
        resourceId: 'sys-1',
        changes: { field: 'value' },
        metadata: { ip: '127.0.0.1' },
      },
    ];

    mockUseAuditLogsQuery.mockReturnValue({
      data: logs,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as any);

    render(
      <MemoryRouter>
        <SettingsAuditLogs />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open audit record critical_action' }));

    await waitFor(() => {
        expect(screen.getByText('Audit record')).toBeInTheDocument();
        expect(screen.getByText('ID: log-1')).toBeInTheDocument();
        // Check for JSON content
        expect(screen.getByText(/"field": "value"/)).toBeInTheDocument();
    });
  });

  it('updates query when date filters change', async () => {
    mockUseAuditLogsQuery.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as any);

    render(
      <MemoryRouter>
        <SettingsAuditLogs />
      </MemoryRouter>
    );

    const fromDateInput = screen.getByLabelText(/From Date/i);
    const toDateInput = screen.getByLabelText(/To Date/i);

    fireEvent.change(fromDateInput, { target: { value: '2023-01-01' } });
    fireEvent.change(toDateInput, { target: { value: '2023-01-31' } });

    await waitFor(() => {
        expect(mockUseAuditLogsQuery).toHaveBeenCalledWith(expect.objectContaining({
            from: expect.stringContaining('2023-01-01'),
            to: expect.stringContaining('2023-01-31'),
        }));
    });
  });
});
