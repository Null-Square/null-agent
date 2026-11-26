import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DeployRunnerModal from './DeployRunnerModal';
import { useDeployRunnerMutation, useRunnerDetailQuery } from '@/modules/security-ops/api';

vi.mock('@/modules/security-ops/api', () => ({
  useDeployRunnerMutation: vi.fn(),
  useRunnerDetailQuery: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockUseDeployRunnerMutation = vi.mocked(useDeployRunnerMutation);
const mockUseRunnerDetailQuery = vi.mocked(useRunnerDetailQuery);

describe('DeployRunnerModal', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseDeployRunnerMutation.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as any);
    mockUseRunnerDetailQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      refetch: vi.fn(),
    } as any);
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(),
      },
    });
  });

  it('renders nothing when closed', () => {
    render(<DeployRunnerModal open={false} onClose={onClose} />);
    expect(screen.queryByText(/deploy runner node/i)).toBeNull();
  });

  it('renders form when open', () => {
    render(
      <MemoryRouter>
        <DeployRunnerModal open={true} onClose={onClose} />
      </MemoryRouter>,
    );

    expect(screen.getByText(/deploy runner node/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. AWS_SEC_GATEWAY_01')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /initialize/i })).toBeDisabled();
  });

  it('submits form and shows handshake state', async () => {
    const mutateMock = vi.fn();
    mockUseDeployRunnerMutation.mockReturnValue({
      mutate: mutateMock,
      isPending: false,
    } as any);

    render(
      <MemoryRouter>
        <DeployRunnerModal open={true} onClose={onClose} />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByPlaceholderText('e.g. AWS_SEC_GATEWAY_01'), {
      target: { value: 'My Runner' },
    });
    fireEvent.click(screen.getByRole('button', { name: /initialize/i }));

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'My Runner', type: 'private' }),
      expect.anything(),
    );

    act(() => {
      mutateMock.mock.calls[0][1].onSuccess({
        runner: {
          id: 'r1',
          status: 'offline',
          metadata: {
            healthState: 'awaiting_connect',
            healthMessage: 'Awaiting first runner connection.',
          },
        },
        token: 'secret-token',
        installCommand: 'docker run ...',
      });
    });

    expect(await screen.findByText('Awaiting runner connection...')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show/i }));
    expect(screen.getByText('secret-token')).toBeInTheDocument();
    expect(screen.getByText('docker run ...')).toBeInTheDocument();
  });

  it('shows upgrade-required health from runner detail', async () => {
    const mutateMock = vi.fn();
    mockUseDeployRunnerMutation.mockReturnValue({
      mutate: mutateMock,
      isPending: false,
    } as any);

    mockUseRunnerDetailQuery.mockReturnValue({
      data: {
        id: 'r1',
        status: 'offline',
        metadata: {
          healthState: 'upgrade_required',
          healthMessage: 'Runner upgrade required.',
        },
      },
      isLoading: false,
      refetch: vi.fn(),
    } as any);

    render(
      <MemoryRouter>
        <DeployRunnerModal open={true} onClose={onClose} />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByPlaceholderText('e.g. AWS_SEC_GATEWAY_01'), {
      target: { value: 'My Runner' },
    });
    fireEvent.click(screen.getByRole('button', { name: /initialize/i }));

    act(() => {
      mutateMock.mock.calls[0][1].onSuccess({
        runner: {
          id: 'r1',
          status: 'offline',
          metadata: {},
        },
        token: 'secret-token',
        installCommand: 'docker run ...',
      });
    });

    expect(await screen.findByText(/^Upgrade required$/i)).toBeInTheDocument();
    expect(screen.getByText('Runner upgrade required.')).toBeInTheDocument();
  });

  it('navigates to details page', async () => {
    const mutateMock = vi.fn();
    mockUseDeployRunnerMutation.mockReturnValue({
      mutate: mutateMock,
      isPending: false,
    } as any);

    render(
      <MemoryRouter>
        <DeployRunnerModal open={true} onClose={onClose} />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByPlaceholderText('e.g. AWS_SEC_GATEWAY_01'), {
      target: { value: 'My Runner' },
    });
    fireEvent.click(screen.getByRole('button', { name: /initialize/i }));

    act(() => {
      mutateMock.mock.calls[0][1].onSuccess({
        runner: {
          id: 'r1',
          status: 'offline',
          metadata: {},
        },
      });
    });

    fireEvent.click(await screen.findByRole('button', { name: /Open Command Center/i }));

    expect(mockNavigate).toHaveBeenCalledWith('/runners/r1');
    expect(onClose).toHaveBeenCalled();
  });
});
