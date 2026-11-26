import { Toaster } from 'sonner';
import { useTheme } from '@shared/contexts/ThemeContext';

/**
 * The toast, to the brand doc's own spec.
 *
 * `brand-system.html` draws it exactly:
 *
 *     .toast    { background: var(--lift); border: 1px solid var(--line-2);
 *                 box-shadow: inset 3px 0 0 var(--bone-3);
 *                 padding: 16px 18px; max-width: 360px; }
 *     .toast.ok { box-shadow: inset 3px 0 0 var(--ok); }
 *
 * So: one hairline, radius 0, and the **type carried by an inset left edge**
 * rather than by a tinted ground. What it replaces was a `rounded-[8px]` card
 * with `shadow-xl` and a `backdrop-blur` — a floating pane, on the one surface
 * that appears over whatever the user is reading.
 *
 * `richColors` is off deliberately. It paints sonner's own success/error
 * palettes across the whole toast, which is both a second colour system and
 * the tinted-ground treatment this brand replaced with an edge.
 */
export const AppToaster = () => {
  const { theme } = useTheme();

  return (
    <Toaster
      closeButton
      position="top-right"
      theme={theme}
      offset={{ top: 18, right: 18 }}
      mobileOffset={{ top: 12, right: 12, left: 12 }}
      toastOptions={{
        duration: 5_000,
        classNames: {
          toast:
            'w-full max-w-[360px] items-start gap-3.5 border border-border-strong bg-card px-[18px] py-4 text-foreground',
          title: 'text-sm font-semibold tracking-normal text-foreground',
          description: 'mt-1 text-[13px] leading-relaxed text-muted-foreground',
          // The edge is the type. Neutral gets one too, so every toast is the
          // same shape and only the colour changes.
          default: 'shadow-[inset_3px_0_0_var(--ns-fg-dim)]',
          success: 'shadow-[inset_3px_0_0_var(--ns-success)]',
          error: 'shadow-[inset_3px_0_0_var(--ns-critical)]',
          warning: 'shadow-[inset_3px_0_0_var(--ns-warning)]',
          info: 'shadow-[inset_3px_0_0_var(--ns-info)]',
          actionButton:
            'bg-primary px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wider text-primary-foreground hover:opacity-90',
          cancelButton:
            'border border-border bg-transparent px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground',
          closeButton: 'border-border bg-card text-muted-foreground hover:text-foreground',
        },
      }}
    />
  );
};

export default AppToaster;
