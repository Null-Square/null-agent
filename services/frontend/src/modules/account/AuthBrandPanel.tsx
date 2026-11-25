import { BrandGlobe } from '@null-ai/design-tokens/ui';

/**
 * What the console puts beside its auth form.
 *
 * One view, deliberately: the globe plus a single line about what the product
 * is. It follows the app theme rather than pinning itself dark, so the toggle
 * governs the whole page.
 *
 * ── IT IS THE PANEL'S CONTENT, NOT THE PANEL ───────────────────────────
 * The `<aside>` around this — its ground, its seam against the form column,
 * its overflow, and the fact that it does not exist below `lg` — belongs to
 * `AuthSplitShell`, because the partner programme's panel needs exactly the
 * same frame around a completely different picture. That also retires the
 * `visible` prop this used to take: the shell does not render a panel until
 * its breakpoint is real, so the globe cannot build a WebGL context on a phone
 * whatever the caller forgets to pass.
 */

export interface AuthBrandPanelProps {
  theme: 'dark' | 'light';
}

export const AuthBrandPanel = ({ theme }: AuthBrandPanelProps) => (
  <>
    <div aria-hidden="true" className="absolute inset-0">
      {/* Sized off viewport height and squared, so the sphere is always fully
          inside the panel instead of being clipped by its edges. The camera
          leaves padding around the sphere at a 1:1 aspect, which keeps it clear
          of this container's bounds at every window size. */}
      <div className="absolute left-1/2 top-[9%] aspect-square h-[58vh] -translate-x-1/2">
        {/* className replaces BrandGlobe's theme blend treatment, which is
            tuned for the marketing hero. Full opacity: the panel needs the
            mark to read. */}
        <BrandGlobe theme={theme} className="opacity-100" scale={1} />
      </div>

      {/* Lift behind the globe. surface-3 flips with the theme, so this reads as
          a highlight on dark and a soft shadow on light without hardcoding
          either. */}
      <div className="absolute inset-0 opacity-60 bg-[radial-gradient(ellipse_at_50%_28%,var(--color-surface-3),transparent_62%)]" />

      {/* Scrim, confined to the lower band where the copy sits. Spanning the
          whole panel veiled the globe it was meant to sit under. */}
      <div className="absolute inset-x-0 bottom-0 h-[52%] bg-gradient-to-t from-background via-background/80 to-transparent" />
    </div>

    <div className="relative z-10 flex h-full flex-col justify-end p-12 xl:p-16">
      <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
        Operator console
      </p>
      <p className="mt-5 max-w-lg text-[32px] font-semibold leading-[1.15] tracking-[-0.02em] text-foreground xl:text-[40px]">
        Your security workspace, on your computer.
      </p>
      <p className="mt-4 max-w-md text-[15px] leading-relaxed text-muted-foreground">
        Review saved findings and compliance evidence in one place.
      </p>
    </div>
  </>
);

export default AuthBrandPanel;
