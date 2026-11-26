import { cn } from '@null-ai/design-tokens/ui';

interface OwaspBadgeProps {
  category?: string | null;
  className?: string;
}

export function OwaspBadge({ category, className }: OwaspBadgeProps) {
  if (!category) return null;

  // OWASP category is a label, not a status — neutral, square, no ad-hoc hue.
  return (
    <span
      className={cn("inline-flex w-fit items-center justify-center bg-muted text-muted-foreground border border-border px-2.5 py-1 text-[11px] font-medium whitespace-nowrap", className)}
    >
      {category}
    </span>
  );
}
