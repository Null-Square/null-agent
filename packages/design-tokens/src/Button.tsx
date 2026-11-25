import * as React from 'react';

import { Slot } from '@radix-ui/react-slot';

import { cn } from './cn';

export type ButtonVariant =
  | 'primary'
  | 'default'
  | 'outline'
  | 'inverted'
  | 'secondary'
  | 'destructive'
  | 'danger'
  | 'ghost'
  | 'link';

export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon' | 'default';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  label?: string;
  loading?: boolean;
  /** Render the child element with the button's styling — use when the button is a link. */
  asChild?: boolean;
}

// Square, flat, and it does not spin: radius 0 and no shadow are brand law, and
// the only live animation in the system is the ns-blink flicker.
const baseStyles =
  'relative inline-flex items-center justify-center gap-2 font-medium border transition-all duration-200 rounded-none disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-primary-foreground border-primary hover:brightness-110',
  default:
    'bg-primary text-primary-foreground border-primary hover:brightness-110',
  // Secondary/ghost/link buttons are NEUTRAL — the brand yellow is reserved for
  // the one primary action per view (variant="primary"/"default"), never for a
  // secondary control.
  outline:
    'bg-transparent text-foreground border-border hover:border-foreground/50 hover:bg-muted/40',
  inverted:
    'bg-background text-foreground border-border hover:bg-foreground hover:text-background',
  secondary:
    'bg-secondary text-secondary-foreground border-border hover:bg-foreground hover:text-background hover:border-foreground',
  destructive:
    'bg-destructive text-destructive-foreground border-destructive hover:bg-background hover:text-destructive',
  danger:
    'bg-destructive text-destructive-foreground border-destructive hover:bg-background hover:text-destructive',
  ghost:
    'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
  link:
    'border-transparent text-foreground underline underline-offset-4 decoration-border hover:decoration-foreground/50',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-base',
  icon: 'h-10 w-10 p-0',
  default: 'h-10 px-4 text-sm',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'default', label, loading, className, children, asChild, ...props }, ref) => {
    const content = children ?? label;
    const showBrackets = !children && label;

    /* `asChild` renders the given element with the button's styling instead of
       a <button>. It exists for the case a button IS a link: a marketing CTA
       that navigates needs a real href — for middle-click, for "open in new
       tab", and for a crawler to follow it. Without it, every such call site
       either copies the class string (and drifts) or drops the href (and
       breaks). Purely additive; existing call sites are untouched.

       It returns early rather than swapping the tag, because `Slot` requires
       exactly one child and the button body is not one: `{loading && …}`
       evaluates to `false`, which still counts as a child and makes
       React.Children.only throw. The loading mark and the bracket treatment
       are a <button>'s business anyway — a link is never mid-request. */
    if (asChild) {
      return (
        <Slot className={cn(baseStyles, variantStyles[variant], sizeStyles[size], className)}>
          {children}
        </Slot>
      );
    }

    return (
      <button
        ref={ref}
        className={cn(baseStyles, variantStyles[variant], sizeStyles[size], className)}
        disabled={props.disabled || loading}
        {...props}
      >
        {loading && <span aria-hidden className="ns-live-mark h-2 w-2 flex-none bg-current" />}
        {showBrackets ? (
          <span className="flex items-center gap-2">
            <span className="text-xs opacity-50">[</span>
            {content}
            <span className="text-xs opacity-50">]</span>
          </span>
        ) : (
          content
        )}
      </button>
    );
  },
);

Button.displayName = 'Button';
