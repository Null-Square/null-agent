import { Link, useLocation } from 'react-router-dom';
import { CellIcon } from '@null-ai/design-tokens/ui';

/**
 * 404 — the one page whose subject is an address.
 *
 * It was `bg-muted/20` (a grey ground this brand does not have), an 8rem yellow
 * "404" — signal spent on a number that is not live and is not an action — and
 * a `rounded-lg` button. Same shape as every other full-page state now: the
 * mark, the kicker, the headline, one line, one verb.
 *
 * The path is shown because it is the only fact the page has, and it is real
 * data, so it sets in mono. Half of these are typos, and seeing the address you
 * actually requested is what tells you which half you are in.
 */
const NotFoundPage = () => {
  const location = useLocation();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-20">
      <div className="w-full max-w-xl text-center">
        <CellIcon name="search" size={84} className="mx-auto text-foreground/30" />

        <p className="mt-10 flex items-center justify-center gap-2.5 font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-warning">
          <span aria-hidden className="h-1.5 w-1.5 bg-warning" />
          Nothing at this address
        </p>

        <h1 className="mt-6 text-[clamp(1.6rem,4vw,2.4rem)] font-extrabold leading-[1.1] tracking-[-0.03em] text-foreground">
          Page not found
        </h1>

        <p
          className="mx-auto mt-6 max-w-[46ch] break-all font-mono text-sm text-muted-foreground"
          title={location.pathname}
        >
          {location.pathname}
        </p>

        <p className="mx-auto mt-6 max-w-[46ch] text-[15px] leading-relaxed text-muted-foreground">
          The page either never existed or has moved. Nothing is wrong with your
          account or your data.
        </p>

        <Link
          to="/"
          className="mt-10 inline-block bg-primary px-8 py-4 text-xs font-extrabold uppercase tracking-wider text-primary-foreground transition-opacity hover:opacity-90"
        >
          Go to dashboard
        </Link>
      </div>
    </div>
  );
};

export default NotFoundPage;
