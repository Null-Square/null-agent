import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NavigationProvider, useNavigation } from './NavigationContext';

const Consumer = () => {
  const { isVisible, hideNavigation, showNavigation, navGroups } = useNavigation();
  return (
    <div>
      <span data-testid="visible">{isVisible ? 'yes' : 'no'}</span>
      <span data-testid="groups">{navGroups?.length ?? 0}</span>
      <button onClick={hideNavigation}>Hide</button>
      <button onClick={showNavigation}>Show</button>
    </div>
  );
};

describe('NavigationContext', () => {
  it('toggles visibility and exposes nav groups', () => {
    render(
      <NavigationProvider navGroups={[{ label: 'Group', items: [] }]}>
        <Consumer />
      </NavigationProvider>,
    );

    expect(screen.getByTestId('visible')).toHaveTextContent('yes');
    expect(screen.getByTestId('groups')).toHaveTextContent('1');

    fireEvent.click(screen.getByText('Hide'));
    expect(screen.getByTestId('visible')).toHaveTextContent('no');

    fireEvent.click(screen.getByText('Show'));
    expect(screen.getByTestId('visible')).toHaveTextContent('yes');
  });

  it('throws when used outside provider', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Consumer />)).toThrowError(
      'useNavigation must be used within a NavigationProvider',
    );
    consoleSpy.mockRestore();
  });
});
