import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import AddTargetModal from './AddTargetModal';

// Spread the real kit rather than listing what this file happens to use: a
// hand-written stub breaks the day the component imports one more thing from
// it, which is a test failure that says nothing about the component.
vi.mock('@null-ai/design-tokens/ui', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@null-ai/design-tokens/ui')),
}));

describe('AddTargetModal', () => {
  const getTargetInput = () => screen.getByRole('textbox');

  it('shows domain verification method options', () => {
    render(<AddTargetModal open onAdd={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(getTargetInput(), { target: { value: 'example.com' } });

    expect(screen.getByText(/validation protocol/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dns txt/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /web path/i })).toBeInTheDocument();
  });

  it('explains the existing domain boundary when adding another domain target', () => {
    render(
      <AddTargetModal
        open
        existingTargets={[{ type: 'domain', value: 'example.com', verified: true }]}
        onAdd={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(getTargetInput(), { target: { value: 'api.example.com' } });

    expect(screen.getByText(/domain boundary: example\.com/i)).toBeInTheDocument();
    expect(screen.getByText(/this will add api\.example\.com/i)).toBeInTheDocument();
    expect(screen.getByText(/separate scope for another company/i)).toBeInTheDocument();
  });

  /* The modal stages, it does not write. The statement belongs to the page's
     Save, which is the one place the boundary actually changes. */
  it('stages a typed subdomain prefix under the existing domain boundary', () => {
    const onAdd = vi.fn();
    const onClose = vi.fn();

    render(
      <AddTargetModal
        open
        existingTargets={[{ type: 'domain', value: 'example.com', verified: true }]}
        onAdd={onAdd}
        onClose={onClose}
      />,
    );

    fireEvent.change(getTargetInput(), { target: { value: 'api' } });
    fireEvent.click(screen.getByRole('button', { name: /add target/i }));

    expect(onAdd).toHaveBeenCalledWith({
      type: 'domain',
      value: 'api.example.com',
      verificationMethod: 'dns_txt',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('carries no authorization control of its own', () => {
    render(<AddTargetModal open onAdd={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(getTargetInput(), { target: { value: 'example.com' } });

    expect(screen.queryByTestId('scope-authorization-checkbox')).toBeNull();
    expect(screen.queryByText(/I confirm that my organization owns/i)).toBeNull();
  });

  it('blocks adding subdomain prefixes until the parent domain is verified', () => {
    const onAdd = vi.fn();

    render(
      <AddTargetModal
        open
        existingTargets={[{ type: 'domain', value: 'example.com', verified: false }]}
        onAdd={onAdd}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(getTargetInput(), { target: { value: 'api' } });

    expect(screen.getByText(/verify example\.com before adding subdomains/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add target/i })).toBeDisabled();
  });

  it('switches private CIDR targets to private-runner guidance', () => {
    render(<AddTargetModal open onAdd={vi.fn()} onClose={vi.fn()} />);

    fireEvent.change(getTargetInput(), { target: { value: '192.168.1.0/24' } });

    expect(screen.queryByText(/validation protocol/i)).not.toBeInTheDocument();
    expect(screen.getByText(/private runner required/i)).toBeInTheDocument();
    expect(screen.getByText(/private ranges do not use internet ownership proof/i)).toBeInTheDocument();
  });
});
