import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import TargetsList from './TargetsList';
import { useAutoVerifyTargetMutation } from '@/modules/security-ops/api';

const mockAutoVerifyEnabled = vi.fn();

vi.mock('@/modules/scopes/lib/autoVerify', () => ({
  isScopeAutoVerifyEnabled: () => mockAutoVerifyEnabled(),
}));

vi.mock('@/modules/security-ops/api', () => ({
  useAutoVerifyTargetMutation: vi.fn(),
}));

vi.mock('./AddTargetModal', () => ({
  __esModule: true,
  default: () => null,
}));

vi.mock('./TargetVerificationModal', () => ({
  __esModule: true,
  default: () => null,
}));

vi.mock('@shared/ui/TimeAgo', () => ({
  TimeAgo: ({ date }: { date: string | Date }) => <span>{String(date)}</span>,
}));

// The design system is NOT mocked — TargetsList is composition over the shared
// list kit, so these tests render the real RecordTable and StatusPill.

describe('TargetsList', () => {
  const target = {
    id: 'target-1',
    type: 'domain',
    value: 'example.com',
    verified: false,
    verifiedAt: null,
  };

  const renderList = (overrides: Partial<ComponentProps<typeof TargetsList>> = {}) => {
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    const onRestore = vi.fn();
    const view = render(
      <TargetsList
        targets={[target] as never}
        removedTargets={[]}
        scopeId="scope-1"
        canManage
        onAdd={onAdd}
        onRemove={onRemove}
        onRestore={onRestore}
        {...overrides}
      />,
    );
    return { ...view, onAdd, onRemove, onRestore };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAutoVerifyEnabled.mockReturnValue(false);
    vi.mocked(useAutoVerifyTargetMutation).mockReturnValue({
      isPending: false,
      mutate: vi.fn(),
    } as never);
  });

  it('hides auto-verify action when disabled', () => {
    renderList();

    expect(screen.queryByRole('button', { name: /auto/i })).not.toBeInTheDocument();
  });

  it('shows auto-verify action when enabled', () => {
    mockAutoVerifyEnabled.mockReturnValue(true);
    renderList();

    expect(screen.getByRole('button', { name: /dev verify/i })).toBeInTheDocument();
  });

  it('keeps add-target action available when a scope already has a target', () => {
    renderList();

    expect(screen.getByRole('button', { name: /add target/i })).toBeInTheDocument();
    expect(screen.getByText(/1 of 1 pending verification or review/i)).toBeInTheDocument();
  });

  it('shows add-target action when the scope has no target yet', () => {
    renderList({ targets: [] });

    expect(screen.getByRole('button', { name: /add target/i })).toBeInTheDocument();
    expect(screen.getByText(/add a domain or network range/i)).toBeInTheDocument();
  });

  it('shows HTTP verification action labels for HTTP-verified domains', () => {
    renderList({ targets: [{ ...target, verificationMethod: 'http_well_known' }] as never });

    expect(screen.getByRole('button', { name: /verify http/i })).toBeInTheDocument();
  });

  it('renders descendant domain targets as subdomain rows', () => {
    renderList({
      targets: [
        { ...target, id: 'target-root', value: 'example.com', verified: true },
        { ...target, id: 'target-sub', value: 'api.example.com', verified: true, verificationMethod: 'none' },
      ] as never,
    });

    expect(screen.getByText(/subdomain/i)).toBeInTheDocument();
    expect(screen.getByText(/under example\.com/i)).toBeInTheDocument();
  });

  it('shows manual review state for CIDR targets', () => {
    renderList({
      targets: [{
        ...target,
        type: 'cidr',
        value: '10.10.20.0/24',
        verificationMethod: 'manual_review',
      }] as never,
    });

    expect(screen.getAllByText(/pending review/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/awaiting admin review/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 of 1 pending verification or review/i)).toBeInTheDocument();
  });

  it('shows dev verification for CIDR targets when enabled', () => {
    mockAutoVerifyEnabled.mockReturnValue(true);
    renderList({
      targets: [{
        ...target,
        type: 'cidr',
        value: '10.10.20.0/24',
        verificationMethod: 'manual_review',
      }] as never,
    });

    expect(screen.getAllByText(/awaiting admin review/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /dev verify/i })).toBeInTheDocument();
  });

  /* Deleting stages a removal rather than issuing a request, so the customer
     sees the whole boundary change before confirming it once. */
  it('stages a delete instead of writing it', () => {
    const { onRemove } = renderList();

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: 'target-1' }));
  });

  it('keeps a staged removal visible and reversible', () => {
    const { onRestore } = renderList({
      targets: [],
      removedTargets: [{ ...target, value: 'old.example.com' } as never],
    });

    expect(screen.getByText('old.example.com')).toBeInTheDocument();
    expect(screen.getByText(/removed on save/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    expect(onRestore).toHaveBeenCalledWith('target-1');
  });

  it('marks an unsaved target as pending', () => {
    renderList({
      targets: [{ key: 'pending-1', type: 'domain', value: 'new.example.com', pending: true }] as never,
    });

    expect(screen.getByText('new.example.com')).toBeInTheDocument();
    // RecordTable renders a mobile and a desktop cell, so the pill appears twice.
    expect(screen.getAllByText(/unsaved/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/added on save/i).length).toBeGreaterThan(0);
  });
});
