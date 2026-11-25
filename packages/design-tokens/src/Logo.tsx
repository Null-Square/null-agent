import mark from '../assets/mark.svg';

/**
 * The mark: one filled signal square, and nothing else.
 *
 * It does not invert. The signal is fixed in both themes — a yellow square
 * reads the same on paper as on screen — so both variants resolve to the same
 * file. `variant` is kept because callers pass it and because the signature
 * genuinely has two inks; here it is deliberately inert rather than removed,
 * so a caller cannot silently get the wrong mark by omitting it.
 *
 * Never use the raw mark as a profile avatar: that construction is the black
 * ground with the square centred at identity scale, which is `digital-icon`.
 */

export type LogoVariant = 'dark' | 'light';

export type LogoProps = {
  className?: string;
  alt?: string;
  variant?: LogoVariant;
};

export const Logo = ({ className = 'w-6 h-6', alt = 'NullSquare' }: LogoProps) => (
  <img
    src={mark}
    alt={alt}
    className={className}
    decoding="async"
    loading="lazy"
  />
);
