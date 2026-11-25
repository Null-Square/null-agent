import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import { FullLogo } from './FullLogo';
import { authSurfaceClasses } from './AuthSurface';
import { useTheme } from './theme/ThemeProvider';

/**
 * THE SPLIT SCREEN EVERY NULLSQUARE IDENTITY SURFACE STANDS ON.
 *
 * A narrow form column against a wide brand panel: sign in, sign up, verify,
 * reset, and the partner programme's own front door. The console had this and
 * the partner portal had a centred 1080px band with the copy on the left and a
 * bordered card on the right — two answers to one question, which is the bug
 * the migration rules name outright even when both look fine.
 *
 * ── THE PANEL IS A SLOT, AND THAT IS THE ONLY VARIATION ────────────────
 * What the two products put beside the form is genuinely different — the
 * console shows the globe, the partner programme shows photographs on the
 * Board — but the column widths, the logo row, the way out and the fine print
 * are not, and none of them is worth deciding twice.
 *
 * ── THE PANEL IS UNMOUNTED BELOW `lg`, NOT MERELY HIDDEN ───────────────
 * Both panels are live canvases: one builds a WebGL context, the other runs a
 * cell lattice at 30Hz. `display: none` stops neither, so the console used to
 * carry a second `visible` prop threaded down from a media query in the page
 * purely to keep phones from running a render loop behind a hidden element.
 * That is shell business, so the shell does it — the panel simply is not
 * rendered until its breakpoint is real, and no caller can forget.
 */

export interface AuthSplitShellProps {
  /** The form. Centred in the narrow column at a fixed measure. */
  children: ReactNode;
  /**
   * The brand panel's CONTENT. The shell draws the panel itself — its ground,
   * its seam, its overflow — so two products cannot disagree about the frame
   * while disagreeing about the picture.
   */
  panel: ReactNode;
  /** What the panel is, for anyone who cannot see it. */
  panelLabel: string;
  /** Absolute URL of the marketing site: the logo's link and the way out. */
  homeHref: string;
  /** The way-out link's words. */
  homeLabel?: string;
  /** Fine print, pinned under the form rather than centred with it. */
  footer?: ReactNode;
}

/**
 * True once the panel's breakpoint is real. Starts false so the server render
 * and the first client paint agree, and so a phone never mounts the panel at
 * all.
 */
const useDesktop = (): boolean => {
  const [desktop, setDesktop] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(min-width: 1024px)');
    const sync = () => setDesktop(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  return desktop;
};

export const AuthSplitShell = ({
  children,
  panel,
  panelLabel,
  homeHref,
  homeLabel = 'Return to Base',
  footer,
}: AuthSplitShellProps) => {
  const classes = authSurfaceClasses();
  const { theme } = useTheme();
  const isLight = theme === 'light';
  const desktop = useDesktop();

  return (
    <div className="min-h-screen font-sans selection:bg-ns-yellow/30 lg:grid lg:grid-cols-[minmax(440px,34%)_1fr]">
      {/* No mode toggle: the product is dark only (toggle removed on
          2026-10-02 at the owner's request; light styles kept). */}

      {/* ---------- Form column ---------- */}
      <div className={`relative flex min-h-screen flex-col px-6 py-8 sm:px-10 lg:px-14 ${classes.page}`}>
        <div className="flex items-center justify-between gap-4">
          {/* self-start: the column is a flex container, which would otherwise
              stretch the logo across its full width. */}
          <a href={homeHref} aria-label="NullSquare home" className="inline-flex self-start">
            <FullLogo
              variant={isLight ? 'dark' : 'light'}
              alt="NullSquare"
              className="h-6 w-auto select-none"
            />
          </a>
          {/* An <a> to the marketing origin, never a router link — leaving here
              means leaving this deployment for nullsquare.net. */}
          <a
            href={homeHref}
            className={`inline-flex items-center gap-1.5 text-[13px] transition-colors ${classes.backLink}`}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {homeLabel}
          </a>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          className="relative z-10 mx-auto flex w-full max-w-[380px] flex-1 flex-col justify-center py-10"
        >
          {children}
        </motion.div>

        {footer}
      </div>

      {/* ---------- Brand panel ----------
          `bg-background`, never `bg-muted`: separation from the form column is
          the seam and whatever the panel draws, not a second ground colour. */}
      <aside
        aria-label={panelLabel}
        className="relative hidden overflow-hidden border-s border-border bg-background lg:block"
      >
        {desktop ? panel : null}
      </aside>
    </div>
  );
};

export default AuthSplitShell;
