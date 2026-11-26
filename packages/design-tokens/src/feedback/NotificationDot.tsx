
import React from 'react';

interface NotificationDotProps {
  active?: boolean;
  count?: number;
  size?: 'sm' | 'md';
  /**
   * Flicker three times on appearance, then hold solid (`ns-attention`).
   *
   * Opt-in, and off by default, because it is only right where the mark is
   * chrome the eye is not already on — a nav dot, the bell. A mark inside the
   * thing you are already reading does not need to announce itself.
   */
  alert?: boolean;
  className?: string;
  containerClassName?: string;
}

// One job, one form: a signal square for unread, a mono count for a number.
// No severity variants — that vocabulary belongs to findings and controls,
// not a presence mark. No ping ring — a fact is stated once.
export const NotificationDot: React.FC<NotificationDotProps> = ({
  active = true,
  count,
  size = 'md',
  alert = false,
  className = '',
  containerClassName = ''
}) => {
  const dimensions = size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5';
  const flicker = alert ? 'ns-attention' : '';

  if (count !== undefined) {
    return (
      <div className={`inline-flex items-center justify-center min-w-[18px] h-4.5 px-1.5 text-[9px] font-mono font-bold border border-border text-foreground ${flicker} ${className}`}>
        {count > 99 ? '99+' : count}
      </div>
    );
  }

  if (!active) return null;

  return (
    <div className={`inline-block ${dimensions} bg-primary ${flicker} ${containerClassName} ${className}`} />
  );
};
