import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';

import { cn } from './cn';

/**
 * Select — the same control as the query bar's facet, on a Radix root.
 *
 * Brand system, Chapter IV: "Select and Tag are explicitly **not** new
 * components — Select reuses the query bar's facet trigger + menu verbatim."
 * So this matches `FacetSelect`: a 46px hairline field, a 1.6px stroke chevron
 * that rotates when open, and a menu of plain rows on `--lift` where the chosen
 * row is marked with a **signal edge** rather than a tick.
 *
 * What this replaced: `rounded-sm` on the trigger, menu and every item; a
 * `0 10px 30px` drop shadow on the menu (the system has no shadows); lucide
 * chevrons at `opacity-50`; and a `Check` glyph restating the state the signal
 * edge already carries.
 *
 * The compound API is unchanged, so consumers did not have to move.
 */

const Select = SelectPrimitive.Root;

const SelectGroup = SelectPrimitive.Group;

const SelectValue = SelectPrimitive.Value;

/** Control glyphs are 1.6px bone strokes with square caps, never CellIcons. */
const Chevron = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className={cn('flex-none', className)}>
    <path d="M3.5 6.5 L8 11 L12.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
  </svg>
);

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      'flex h-[46px] w-full items-center justify-between gap-2.5 rounded-none border border-border bg-transparent px-4 text-sm text-foreground transition-colors',
      'hover:border-foreground/20 data-[state=open]:border-foreground/20',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
      'disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1 [&>span]:truncate',
      'data-[placeholder]:text-muted-foreground',
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <Chevron className="transition-transform duration-200 data-[state=open]:rotate-180" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectScrollUpButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn('flex cursor-default items-center justify-center py-1 text-muted-foreground', className)}
    {...props}
  >
    <Chevron className="rotate-180" />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn('flex cursor-default items-center justify-center py-1 text-muted-foreground', className)}
    {...props}
  >
    <Chevron />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName = SelectPrimitive.ScrollDownButton.displayName;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={cn(
        // Anchored, not modal: opaque --lift, one hairline, no scrim and no
        // blur. Radius 0 and no shadow — the menu is a frame, not a card.
        'relative z-[1000] max-h-96 min-w-[8rem] overflow-hidden rounded-none border border-foreground/20 bg-ns-elevated text-foreground',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        position === 'popper' && 'data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
        className,
      )}
      position={position}
      {...props}
    >
      <SelectScrollUpButton />
      <SelectPrimitive.Viewport
        className={cn(
          'py-1.5',
          position === 'popper' && 'w-full min-w-[var(--radix-select-trigger-width)]',
        )}
      >
        {children}
      </SelectPrimitive.Viewport>
      <SelectScrollDownButton />
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn(
      'px-4 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground',
      className,
    )}
    {...props}
  />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      // The chosen row takes a signal edge — the facet menu's exact device. A
      // menu is transient, so it may hold the signal for as long as it is open.
      'relative flex w-full cursor-default select-none items-center px-4 py-2.5 text-left text-sm text-muted-foreground outline-none transition-colors',
      'focus:bg-foreground/5 focus:text-foreground data-[highlighted]:bg-foreground/5 data-[highlighted]:text-foreground',
      'data-[state=checked]:text-foreground data-[state=checked]:shadow-[inset_3px_0_0_var(--ns-yellow)]',
      'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator ref={ref} className={cn('my-1.5 h-px bg-border', className)} {...props} />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
};
