import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import ScopeSaveBar from './ScopeSaveBar';

vi.mock('@null-ai/design-tokens/ui', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@null-ai/design-tokens/ui')),
}));

const changes = [{ key: 'add-target-1', label: 'Add target', detail: 'other.com' }];

const renderBar = (overrides: Partial<ComponentProps<typeof ScopeSaveBar>> = {}) => {
  const onSave = vi.fn();
  const onDiscard = vi.fn();
  const view = render(
    <ScopeSaveBar
      changes={changes}
      wideningReasons={[]}
      impactTolerance="poc"
      isSaving={false}
      onDiscard={onDiscard}
      onSave={onSave}
      {...overrides}
    />,
  );
  return { ...view, onSave, onDiscard };
};

describe('ScopeSaveBar', () => {
  it('counts what is waiting to be saved', () => {
    renderBar();

    expect(screen.getByTestId('scope-save-bar')).toHaveTextContent('1');
    expect(screen.getByTestId('scope-save-bar')).toHaveTextContent(/unsaved change/i);
  });

  /* A narrowing save is covered by the statement already on file, so the
     confirm step shows the change and nothing else. */
  it('confirms a narrowing save without asking for the statement', () => {
    const { onSave } = renderBar();

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(screen.queryByTestId('scope-authorization-statement')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: /save changes/i })[1]);
    expect(onSave).toHaveBeenCalledWith(undefined);
  });

  it('asks for the statement when the save widens the boundary', () => {
    const { onSave } = renderBar({ wideningReasons: ['root_added'] });

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(screen.getByTestId('scope-authorization-statement')).toHaveTextContent(
      /I confirm that my organization owns the targets/i,
    );
    expect(screen.getByText(/a new target is being brought into the boundary/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /i authorize and save/i }));
    expect(onSave).toHaveBeenCalledWith({ accepted: true });
  });

  it('lists the staged changes in the confirm step', () => {
    renderBar({ wideningReasons: ['root_added'] });

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(screen.getAllByText('Add target').length).toBeGreaterThan(0);
    expect(screen.getAllByText('other.com').length).toBeGreaterThan(0);
  });

  /* Raising the impact limit is the one widening whose meaning is not obvious
     from the word "widening", so the confirm step spells it out beside the
     statement rather than in a warning dialog of its own. */
  it('states what full exploitation means where it is authorized', () => {
    renderBar({ wideningReasons: ['impact_raised'], impactTolerance: 'full' });

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(screen.getByTestId('full-exploitation-conditions')).toHaveTextContent(
      /resettable testing or staging environment/i,
    );
    expect(screen.getByTestId('scope-authorization-statement')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /i authorize and save/i })).toBeInTheDocument();
  });

  it('says nothing about full exploitation when the limit is being lowered', () => {
    renderBar({ wideningReasons: [], impactTolerance: 'poc' });

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(screen.queryByTestId('full-exploitation-conditions')).toBeNull();
  });

  it('discards without confirming', () => {
    const { onDiscard, onSave } = renderBar();

    fireEvent.click(screen.getByRole('button', { name: /discard/i }));

    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});
