import { cn } from "@null-ai/design-tokens/ui";

interface CvssScoreBadgeProps {
  score?: number | null;
  vector?: string | null;
  className?: string;
}

export function CvssScoreBadge({
  score,
  vector,
  className,
}: CvssScoreBadgeProps) {
  if (score === null || score === undefined) {
    return <span className="text-muted-foreground text-xs">-</span>;
  }

  // CVSS bands use the severity tokens, not raw palette colours.
  let colorClass = "text-muted-foreground";
  if (score >= 9.0) colorClass = "text-critical";
  else if (score >= 7.0) colorClass = "text-high";
  else if (score >= 4.0) colorClass = "text-medium";
  else if (score > 0) colorClass = "text-low";

  return (
    <span
      className={cn("text-[13px] font-medium", colorClass, className)}
      title={vector || undefined}
    >
      {score.toFixed(1)}
    </span>
  );
}
