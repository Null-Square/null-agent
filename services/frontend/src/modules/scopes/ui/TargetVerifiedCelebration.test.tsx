import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { TargetVerifiedCelebration } from './TargetVerifiedCelebration';
import {
  celebrateTargetVerified,
  dismissTargetVerified,
} from '@/modules/scopes/model/verificationCelebration';

/**
 * The bug this exists to stop coming back:
 *
 * verifying a target invalidates `scope-targets`, the refetch flips
 * `primaryTarget.verified`, and `DashboardPage` swaps between its
 * unverified-gate branch and its main branch — each of which renders its own
 * `TargetVerificationModal`. React unmounts one and mounts the other, so a
 * celebration held as state inside that modal is destroyed by the success it
 * is announcing, and the customer is shown the verify form a second time.
 *
 * So the assertion that matters is the last one: the celebration outlives the
 * component that triggered it.
 */

afterEach(() => act(() => dismissTargetVerified()));

describe('TargetVerifiedCelebration', () => {
  it('shows nothing until a target is verified', () => {
    render(<TargetVerifiedCelebration />);
    expect(screen.queryByText(/congratulations/i)).toBeNull();
  });

  it('congratulates, names the domain and says what happens next', () => {
    render(<TargetVerifiedCelebration />);
    act(() => celebrateTargetVerified('acme.com'));

    expect(screen.getByText(/congratulations/i)).toBeTruthy();
    expect(screen.getByText(/target verified/i)).toBeTruthy();
    expect(screen.getByText('acme.com')).toBeTruthy();
    // The two promises: it costs nothing, and they need do nothing.
    expect(screen.getByText(/included with verification/i)).toBeTruthy();
    expect(screen.getByText(/report goes to your email/i)).toBeTruthy();
  });

  it('closes on the action', () => {
    render(<TargetVerifiedCelebration />);
    act(() => celebrateTargetVerified('acme.com'));

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(screen.queryByText(/congratulations/i)).toBeNull();
  });

  it('survives the component that triggered it being unmounted', () => {
    /* Stands in for the modal: mounted, fires the celebration, then is torn
       down by the refetch that same success caused. */
    const trigger = render(<div data-testid="modal" />);
    render(<TargetVerifiedCelebration />);

    act(() => celebrateTargetVerified('acme.com'));
    trigger.unmount();

    expect(screen.getByText(/target verified/i)).toBeTruthy();
    expect(screen.getByText('acme.com')).toBeTruthy();
  });
});
