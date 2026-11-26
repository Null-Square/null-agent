import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RunnerDetailPage from './RunnerDetailPage';
import { useDeleteRunnerMutation, useRotateRunnerTokenMutation, useRunnerDetailQuery } from '@/modules/security-ops/api';

vi.mock('@/modules/security-ops/api', () => ({
  useRunnerDetailQuery: vi.fn(),
  useRotateRunnerTokenMutation: vi.fn(),
  useDeleteRunnerMutation: vi.fn(),
}));

const mockUseRunnerDetailQuery = vi.mocked(useRunnerDetailQuery);
const mockUseRotateRunnerTokenMutation = vi.mocked(useRotateRunnerTokenMutation);
const mockUseDeleteRunnerMutation = vi.mocked(useDeleteRunnerMutation);

describe('RunnerDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRunnerDetailQuery.mockReturnValue({
      data: {
        id: 'runner-1',
        organizationId: 'org-1',
        name: 'Private Ranger',
        type: 'private',
        status: 'online',
        platform: 'linux',
        architecture: null,
        ipAddress: '1.2.3.4',
        version: 'shell-server/1.0.0',
        lastHeartbeatAt: new Date().toISOString(),
        metadata: {
          healthState: 'connected',
          healthMessage: 'Runner connected to control plane.',
        },
        assignedScopes: [],
        scopes: [],
        recentRuns: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      isLoading: false,
    } as any);

    const mockMutation = { mutate: vi.fn(), isPending: false } as any;
    mockUseRotateRunnerTokenMutation.mockReturnValue(mockMutation);
    mockUseDeleteRunnerMutation.mockReturnValue(mockMutation);
    vi.spyOn(window, 'confirm').mockImplementation(() => true);
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(),
      },
    });
  });

  it('renders runner details', async () => {
    render(
      <MemoryRouter initialEntries={['/runners/runner-1']}>
        <Routes>
          <Route path="/runners/:id" element={<RunnerDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Private Ranger')).toBeInTheDocument();
    expect(screen.getByText('1.2.3.4')).toBeInTheDocument();
    expect(screen.getByText('linux')).toBeInTheDocument();
    // The rail carries the workflow verbs now, not a "Protocol control" section.
    expect(screen.getByRole('button', { name: /rotate protocol/i })).toBeInTheDocument();
  });

  it('shows offline health banner when runner requires upgrade', async () => {
    mockUseRunnerDetailQuery.mockReturnValue({
      data: {
        id: 'runner-1',
        organizationId: 'org-1',
        name: 'Private Ranger',
        type: 'private',
        status: 'offline',
        platform: 'linux',
        architecture: null,
        ipAddress: null,
        version: null,
        lastHeartbeatAt: null,
        metadata: {
          healthState: 'upgrade_required',
          healthMessage: 'Runner upgrade required.',
        },
        assignedScopes: [],
        scopes: [],
        recentRuns: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      isLoading: false,
    } as any);

    render(
      <MemoryRouter initialEntries={['/runners/runner-1']}>
        <Routes>
          <Route path="/runners/:id" element={<RunnerDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    // The badge and the page heading now use the same sentence-case wording,
    // so the state appears twice — which is the point of one vocabulary.
    expect((await screen.findAllByText(/^Upgrade required$/i)).length).toBeGreaterThan(0);
    expect(screen.getByText('Runner upgrade required.')).toBeInTheDocument();
  });

  it('handles token rotation flow', async () => {
    const mutateMock = vi.fn();
    mockUseRotateRunnerTokenMutation.mockReturnValue({ mutate: mutateMock, isPending: false } as any);

    render(
      <MemoryRouter initialEntries={['/runners/runner-1']}>
        <Routes>
          <Route path="/runners/:id" element={<RunnerDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText(/rotate protocol/i));

    expect(window.confirm).toHaveBeenCalled();
    expect(mutateMock).toHaveBeenCalledWith('runner-1', expect.anything());

    act(() => {
      mutateMock.mock.calls[0][1].onSuccess({
        token: 'new-rotated-token',
        installCommand: 'docker run ...',
      });
    });

    expect((await screen.findAllByText(/new credentials/i)).length).toBeGreaterThan(0);
    expect(screen.getByText('new-rotated-token')).toBeInTheDocument();
    expect(screen.getByText('docker run ...')).toBeInTheDocument();
  });

  it('renders loading state when runner is missing', () => {
    mockUseRunnerDetailQuery.mockReturnValue({ data: undefined, isLoading: false } as any);

    render(
      <MemoryRouter initialEntries={['/runners/bad-id']}>
        <Routes>
          <Route path="/runners/:id" element={<RunnerDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText(/Locating Runner Node/i)).toBeInTheDocument();
  });
});
