import signatureOnDark from '../assets/signature-on-dark.svg';
import signatureOnLight from '../assets/signature-on-light.svg';

/**
 * The horizontal signature: the signal square, a 1px seam, then the wordmark.
 *
 * `variant` names the INK, not the ground — `light` is the light-ink lockup, so
 * it is the one you put on a dark background. That is why every call site reads
 * `variant={isDark ? 'light' : 'dark'}`.
 *
 * SVG, not PNG. The signature is line art on a lattice: at 28px in a header a
 * raster of it is soft, and the two files it replaced were 40KB between them
 * for something that is 2.6KB of vectors.
 *
 * ── THE ARABIC SIGNATURE ────────────────────────────────────────────────
 * `script` selects the mark and exactly one is ever rendered. This component
 * has no opinion about locale — that belongs to whichever app knows it, and
 * the website supplies it once by wrapping this in `shared/ui/SiteLogo`, so
 * adminpanel and frontend keep the Latin mark without being asked.
 *
 * Rendering BOTH and hiding one in CSS was built first and reverted: it puts
 * an <svg> into every page on every surface, and `ErrorView.test` — which
 * reaches for the first svg in the tree to check the scope mark — caught it
 * immediately. A logo has no business changing the shape of a page's DOM in
 * a locale it is not being used in.
 *
 * The Arabic mark is inline <svg> rather than an imported asset on purpose: an
 * <img> is an isolated document that will not load the page's webfonts, so a
 * <text> inside one falls back to a system Arabic face and stops being the
 * brand. Inline, it uses Noto Kufi Arabic like everything else.
 *
 * ── WHY IT IS NOT THE LATIN MARK WITH THE WORD SWAPPED ──────────────────
 * Four of the Latin lockup's properties do not exist in Arabic: there is no
 * uppercase, Noto Kufi stops at 700 where Inter reaches 800, the square leads
 * from the RIGHT under RTL, and — the one that decides the design — Arabic is
 * cursive, so letter-spacing severs the joins and reads as a rendering fault
 * rather than as emphasis. The Latin mark is tracked +0.08em; this one is
 * tracked 0, and the face carries what the tracking used to.
 *
 * Every measurement below is held from the Latin signature (26px square, 1x44
 * seam, 24px gaps) and the word's size was fitted against it rather than
 * matched by nominal px: the Latin word is all caps, so its ink is cap height
 * and nothing else, while Arabic carries an alef ascender and a ya descender.
 * At the Latin's own 30px the word overruns the 44-unit field entirely.
 * Re-measure with `scripts/measure-arabic-signature.mjs` if the word or the
 * face changes — it prints the constants below and a proof sheet beside the
 * real Latin mark.
 */

export type FullLogoVariant = 'dark' | 'light';

/** Which wordmark. Defaults to `latin`, so a consumer with no locale is right. */
export type FullLogoScript = 'latin' | 'arabic';

export type FullLogoProps = {
  className?: string;
  alt?: string;
  variant?: FullLogoVariant;
  script?: FullLogoScript;
};

/* Fitted at 20px/700 in the 44-unit field: ink is 38 tall, which leaves the
   ascender and descender 3 units of air and still reads level with the Latin
   caps beside it. 22px fills the field to within 1 unit; 18px goes light
   against the square. */
const AR = {
  word: 'المربع الصفري',
  size: 20,
  advance: 136.8438,
  baseline: 29,
  seam: 160.8438,
  square: 185.8438,
  width: 211.8438,
};

export const FullLogo = ({
  className = 'h-6 w-auto',
  alt = 'NullSquare',
  variant = 'dark',
  script = 'latin',
}: FullLogoProps) => {
  if (script === 'arabic') {
    const ink = variant === 'light' ? '#F5F5F7' : '#0A0A0A';
    return (
      <svg
        className={className}
        viewBox={`0 0 ${AR.width} 44`}
        role="img"
        aria-label={alt}
        xmlns="http://www.w3.org/2000/svg"
      >
        <text
          x={AR.advance}
          y={AR.baseline}
          textAnchor="start"
          direction="rtl"
          fill={ink}
          style={{ font: `700 ${AR.size}px 'Noto Kufi Arabic', sans-serif`, letterSpacing: 0 }}
        >
          {AR.word}
        </text>
        <rect x={AR.seam} y="0" width="1" height="44" fill={ink} opacity="0.2" />
        <rect x={AR.square} y="9" width="26" height="26" fill="#F5D13A" />
      </svg>
    );
  }

  return (
    <img
      src={variant === 'light' ? signatureOnDark : signatureOnLight}
      alt={alt}
      className={className}
      decoding="async"
      loading="lazy"
    />
  );
};
