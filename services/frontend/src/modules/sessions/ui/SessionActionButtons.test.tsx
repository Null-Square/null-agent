import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SessionActionButtons from './SessionActionButtons';

describe('SessionActionButtons', () => {
  it('shows Stop for running sessions', () => {
    render(
      <MemoryRouter>
        <SessionActionButtons
          status="running"
          sessionId="session-1"
          onStop={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: /stop/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /start/i })).toBeNull();
  });

  it('shows Stop and never an upgrade action while running intent waits for credits', () => {
    render(
      <MemoryRouter>
        <SessionActionButtons
          status="paused"
          desiredExecution="running"
          condition="waiting_credits"
          sessionId="session-2"
          onStop={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: /stop/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /upgrade/i })).toBeNull();
  });

  it('shows Stop for automatic recovery', () => {
    render(
      <MemoryRouter>
        <SessionActionButtons
          status="paused"
          desiredExecution="running"
          condition="recovering"
          blockedReason="system_paused"
          sessionId="session-system"
          onStop={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: /stop/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /start/i })).toBeNull();
  });

  it('keeps Stop available while approval is required', () => {
    render(
      <MemoryRouter>
        <SessionActionButtons
          status="paused"
          desiredExecution="running"
          condition="waiting_approval"
          blockedReason="awaiting_approval"
          sessionId="session-approval"
          onStop={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: /stop/i })).toBeTruthy();
  });

  it('renders nothing when no actions are available', () => {
    const { container } = render(
      <MemoryRouter>
        <SessionActionButtons status="idle" sessionId="session-4" />
      </MemoryRouter>
    );

    expect(container.firstChild).toBeNull();
  });

  it('renders Start for a cancelled run with preserved session history', () => {
    render(
      <MemoryRouter>
        <SessionActionButtons
          status="paused"
          blockedReason="aborted_by_user"
          pauseReason="manual"
          sessionId="session-cancelled"
          onStart={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: /start/i })).toBeTruthy();
  });

  it('renders Start for a completed session', () => {
    render(
      <MemoryRouter>
        <SessionActionButtons
          status="completed"
          sessionId="session-completed"
          onStart={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: /start/i })).toBeTruthy();
  });

  it('triggers rename and delete handlers when clicked', () => {
    const onDelete = vi.fn();
    const onRename = vi.fn();

    render(
      <MemoryRouter>
        <SessionActionButtons
          status="idle"
          sessionId="session-5"
          onDelete={onDelete}
          onRename={onRename}
        />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: /rename/i }));
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
