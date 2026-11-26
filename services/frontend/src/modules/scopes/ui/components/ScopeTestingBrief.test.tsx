import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import ScopeTestingBrief from './ScopeTestingBrief';

vi.mock('@null-ai/design-tokens/ui', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@null-ai/design-tokens/ui')),
}));

const renderBrief = (overrides: Partial<ComponentProps<typeof ScopeTestingBrief>> = {}) => {
  const onChange = vi.fn();
  const view = render(
    <ScopeTestingBrief
      mission={null}
      impactTolerance="poc"
      canManage
      onChange={onChange}
      {...overrides}
    />,
  );
  return { ...view, onChange };
};

describe('ScopeTestingBrief', () => {
  /* Two controls on the page. It was a two-step wizard behind a dialog with a
     save button of its own, wrapped in a page of recital text. */
  it('shows the impact limit and the guidance box, with no dialog to open', () => {
    renderBrief();

    expect(screen.getByRole('radio', { name: 'Exploit' })).toBeInTheDocument();
    expect(screen.getByLabelText(/mission guidance/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit testing brief/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /save brief/i })).toBeNull();
  });

  /* Prose that restates the default is something to scroll past, and it buried
     the two controls that are real. */
  it('carries no recital of the standard contract or the warning bullets', () => {
    renderBrief({ impactTolerance: 'full' });

    expect(screen.queryByText(/standard pentest contract/i)).toBeNull();
    expect(screen.queryByText(/highest-impact testing mode/i)).toBeNull();
    expect(screen.queryByText(/do not enable this mode for production targets/i)).toBeNull();
    expect(screen.queryByText(/broad, methodical discovery/i)).toBeNull();
    expect(screen.queryByTestId('full-exploitation-conditions')).toBeNull();
  });

  it('marks the selected impact limit and describes it in one line', () => {
    renderBrief({ impactTolerance: 'full' });

    expect(screen.getByRole('radio', { name: 'Exploit' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Proof' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/resettable non-production targets only/i)).toBeInTheDocument();
  });

  it('stages an impact change rather than saving it', () => {
    const { onChange } = renderBrief();

    fireEvent.click(screen.getByRole('radio', { name: 'Exploit' }));

    expect(onChange).toHaveBeenCalledWith({ mission: null, impactTolerance: 'full' });
    expect(screen.queryByText('Enable full exploitation?')).toBeNull();
  });

  it('stages a mission edit', () => {
    const { onChange } = renderBrief();

    fireEvent.change(screen.getByLabelText(/mission guidance/i), {
      target: { value: 'Focus on checkout.' },
    });

    expect(onChange).toHaveBeenCalledWith({
      mission: 'Focus on checkout.',
      impactTolerance: 'poc',
    });
  });

  it('reports an emptied mission as cleared, not as untouched', () => {
    const { onChange } = renderBrief({ mission: 'Focus on checkout.' });

    fireEvent.change(screen.getByLabelText(/mission guidance/i), { target: { value: '   ' } });

    expect(onChange).toHaveBeenCalledWith({ mission: null, impactTolerance: 'poc' });
  });

  it('is read-only without scope write permission', () => {
    const { onChange } = renderBrief({ canManage: false });

    fireEvent.click(screen.getByRole('radio', { name: 'Exploit' }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/mission guidance/i)).toBeDisabled();
  });
});
