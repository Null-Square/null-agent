import { useMemo } from "react";
import { cn } from "@null-ai/design-tokens/ui";

export default function SeverityProgressBar({
  findings,
}: {
  findings: Array<{ severity?: string | null }>;
}) {
  const counts = useMemo(() => {
    const c = { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0 };
    for (const f of findings) {
      const severity = f.severity?.toLowerCase() as keyof typeof c;
      c[Object.hasOwn(c, severity) ? severity : "unknown"]++;
    }
    return c;
  }, [findings]);

  const total = findings.length;
  if (total === 0) return null;

  const segments = [
    {
      key: "critical",
      count: counts.critical,
      color: "bg-destructive",
      dotColor: "bg-destructive",
      label: "critical",
    },
    {
      key: "high",
      count: counts.high,
      color: "bg-high",
      dotColor: "bg-high",
      label: "high",
    },
    {
      key: "medium",
      count: counts.medium,
      color: "bg-medium",
      dotColor: "bg-medium",
      label: "medium",
    },
    {
      key: "low",
      count: counts.low,
      color: "bg-low",
      dotColor: "bg-low",
      label: "low",
    },
    {
      key: "info",
      count: counts.info,
      color: "bg-muted-foreground",
      dotColor: "bg-muted-foreground",
      label: "info",
    },
    {
      key: "unknown",
      count: counts.unknown,
      color: "bg-muted-foreground",
      dotColor: "bg-muted-foreground",
      label: "unrated",
    },
  ].filter((s) => s.count > 0);

  return (
    <div className="mb-8">
      <div className="mb-3 flex flex-wrap items-center gap-4">
        <span className="text-3xl font-bold text-heading">{total}</span>
        <span className="text-xs font-sans text-muted-foreground  ">Risks</span>
        <div className="flex flex-wrap items-center gap-4 sm:ml-4">
          {segments.map((s) => (
            <span
              key={s.key}
              className="flex items-center gap-1.5 text-sm font-sans   text-muted-foreground"
            >
              <span className={cn("h-2 w-2", s.dotColor)} />
              <span className="font-bold">{s.count}</span> {s.label}
            </span>
          ))}
        </div>
      </div>
      <div className="h-1.5 w-full bg-border/30 overflow-hidden flex">
        {segments.map((s) => (
          <div
            key={s.key}
            className={cn("h-full", s.color)}
            style={{ width: `${(s.count / total) * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}
