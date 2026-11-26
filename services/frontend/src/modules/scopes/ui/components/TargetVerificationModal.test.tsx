import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import TargetVerificationModal from './TargetVerificationModal';
import {
  useAutoVerifyTargetMutation,
  useVerifyTargetMutation,
} from '@/modules/security-ops/api';

vi.mock('@/modules/security-ops/api', () => ({
  useAutoVerifyTargetMutation: vi.fn(),
  useVerifyTargetMutation: vi.fn(),
}));

const mockAutoVerifyEnabled = vi.fn(() => false);
vi.mock('@/modules/scopes/lib/autoVerify', () => ({
  isScopeAutoVerifyEnabled: () => mockAutoVerifyEnabled(),
}));

/* The celebration is announced to the app, not rendered here. */
const celebrated: string[] = [];
vi.mock('@/modules/scopes/model/verificationCelebration', () => ({
  celebrateTargetVerified: (domain: string) => celebrated.push(domain),
}));

// Spread the real kit rather than listing what this file happens to use: a
// hand-written stub breaks the day the component imports one more thing from
// it, which is a test failure that says nothing about the component.
vi.mock('@null-ai/design-tokens/ui', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@null-ai/design-tokens/ui')),
}));

const mockUseVerifyTargetMutation = vi.mocked(useVerifyTargetMutation);
const mockUseAutoVerifyTargetMutation = vi.mocked(useAutoVerifyTargetMutation);

const target = {
  id: 'target-1',
  scopeId: 'scope-1',
  type: 'domain',
  value: 'example.com',
  verified: false,
  verificationMethod: 'dns_txt',
  verificationToken: 'abc123',
  verifiedAt: null,
};

describe('TargetVerificationModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    celebrated.length = 0;
    mockUseVerifyTargetMutation.mockReturnValue({
      isPending: false,
      mutate: vi.fn(),
    } as any);
    mockUseAutoVerifyTargetMutation.mockReturnValue({
      isPending: false,
      mutate: vi.fn(),
    } as any);
    mockAutoVerifyEnabled.mockReturnValue(false);
  });

  it('offers only DNS TXT and HTTPS file verification, with no hosted-provider path', () => {
    render(<TargetVerificationModal open target={target as any} scopeId="scope-1" onClose={vi.fn()} />);

    expect(screen.queryByText(/detected|wordpress|squarespace|shopify|wix/i)).not.toBeInTheDocument();
    expect(screen.getByText(/dns host/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^https file$/i }));

    expect(screen.getAllByText(/verification url/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /verify and authorize \(https file\)/i })).toBeInTheDocument();
  });

  it('offers the development auto-verify shortcut only when the dev gate is enabled', () => {
    const mutate = vi.fn();
    mockAutoVerifyEnabled.mockReturnValue(true);
    mockUseAutoVerifyTargetMutation.mockReturnValue({ isPending: false, mutate } as any);

    render(<TargetVerificationModal open target={target as any} scopeId="scope-1" onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /dev auto-verify/i }));
    expect(mutate).toHaveBeenCalledWith(
      { scopeId: 'scope-1', targetId: 'target-1' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('hides the development auto-verify shortcut when the dev gate is disabled', () => {
    render(<TargetVerificationModal open target={target as any} scopeId="scope-1" onClose={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /dev auto-verify/i })).toBeNull();
  });

  /**
   * What happens AFTER the button is pressed had no coverage at all, which is
   * how both of these survived: the modal called `onClose()` from `onSuccess`
   * and never read the response, so a failed lookup looked identical to a
   * successful one, and a successful one never mentioned that verifying had
   * just bought the customer a free first assessment.
   *
   * The celebration itself is deliberately NOT asserted here, because it is
   * deliberately not rendered here — this modal is unmounted by the refetch
   * that its own success triggers. See `verificationCelebration.test.tsx`.
   */
  describe('after verifying', () => {
    /** Runs `onSuccess` with whatever the route would have answered. */
    const verifyAnswering = (response: { verified: boolean; message?: string }) => {
      const mutate = vi.fn((_vars, opts) => opts?.onSuccess?.(response));
      mockUseVerifyTargetMutation.mockReturnValue({ isPending: false, mutate } as any);
      return mutate;
    };

    it('hands the celebration to the app and closes', () => {
      verifyAnswering({ verified: true, message: 'Verified' });
      const onClose = vi.fn();
      render(<TargetVerificationModal open target={target as any} scopeId="scope-1" onClose={onClose} />);

      fireEvent.click(screen.getByTestId('target-verify-submit'));

      // The domain travels with it — the overlay names the target back.
      expect(celebrated).toEqual(['example.com']);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('keeps the modal open and shows why when the record is not visible yet', () => {
      // A 200 that reports `verified: false` is the ordinary first attempt —
      // DNS has not propagated. It used to close the modal as a success.
      verifyAnswering({ verified: false, message: 'No TXT record found for _nullsquare.example.com.' });
      const onClose = vi.fn();
      render(<TargetVerificationModal open target={target as any} scopeId="scope-1" onClose={onClose} />);

      fireEvent.click(screen.getByTestId('target-verify-submit'));

      expect(screen.getByText(/no txt record found/i)).toBeTruthy();
      // Nothing to celebrate, and the modal stays put so the reason is read.
      expect(celebrated).toEqual([]);
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  /**
   * Verifying is the authorization.
   *
   * Publishing the token proves control of the zone, and control is what
   * NullSquare acts on — so the dialog states what completing it means, in the
   * words the action is taken under, rather than deferring to a second
   * confirmation elsewhere. One system, said out loud.
   */
  it('states what verifying authorizes, without gating on a second step', () => {
    render(<TargetVerificationModal open target={target as any} scopeId="scope-1" onClose={vi.fn()} />);

    const statement = screen.getByTestId('target-authorization-statement');
    expect(statement.textContent).toMatch(/authority from the owner/i);
    expect(statement.textContent).toMatch(/does not independently verify/i);

    expect((screen.getByTestId('target-verify-submit') as HTMLButtonElement).disabled).toBe(false);
  });

});
