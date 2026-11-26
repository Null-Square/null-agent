import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import HomePage from './HomePage';

vi.mock('@modules/chat/ui/HeroWave', () => ({
  HeroWave: ({ motionPreset, title }: { motionPreset?: string; title?: string }) => (
    <div data-testid="hero-wave" data-motion-preset={motionPreset}>
      {title}
    </div>
  ),
}));

describe('HomePage', () => {
  it('uses the calm hero wave preset', () => {
    render(<HomePage />);

    expect(screen.getByTestId('hero-wave')).toHaveAttribute('data-motion-preset', 'calm');
    expect(screen.getByText('Null Ai.')).toBeInTheDocument();
  });
});
