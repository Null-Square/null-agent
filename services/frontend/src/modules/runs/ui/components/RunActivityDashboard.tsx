import type { ReactNode } from "react";
import { cn, RecordTable } from "@null-ai/design-tokens/ui";
import type { Project } from "../../../../local";

function ActivityCard({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn(className)}>
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-border pb-3">
        <div>
          <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
            {title}
          </h3>
          {subtitle ? (
            <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {children}
    </section>
  );
}

export default function RunActivityDashboard({ run }: { run: Project }) {
  const events = [
    { id: run.id, title: "Scope created", detail: run.name, at: run.createdAt },
    ...run.artifacts.map((file) => ({
      id: file.id,
      title: "Evidence imported",
      detail: file.name,
      at: file.createdAt,
    })),
    ...run.findings.flatMap((finding) =>
      finding.history
        .filter((event) => event.type === "status_changed")
        .map((event) => ({
          id: "risk-" + event.id,
          title: "Risk status changed",
          at: event.createdAt,
          detail:
            finding.title +
            " Â· " +
            event.fromStatus?.replaceAll("_", " ") +
            " â†’ " +
            event.toStatus.replaceAll("_", " "),
        })),
    ),
    ...run.reviews.map((review) => ({
      id: review.id,
      title: "Review saved",
      detail: review.model + " · " + review.workflow,
      at: review.createdAt,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  const imports = events.filter(
    (event) => event.title === "Evidence imported",
  ).length;
  const decisions = events.filter(
    (event) => event.title === "Risk status changed",
  ).length;

  return (
    <div className="space-y-10 py-6">
      <div className="grid gap-8 md:grid-cols-3">
        <ActivityCard title="Evidence imported">
          <p className="text-3xl font-bold tabular-nums">{imports}</p>
        </ActivityCard>
        <ActivityCard title="Triage decisions">
          <p className="text-3xl font-bold tabular-nums">{decisions}</p>
        </ActivityCard>
        <ActivityCard title="Saved reviews">
          <p className="text-3xl font-bold tabular-nums">
            {run.reviews.length}
          </p>
        </ActivityCard>
      </div>
      <ActivityCard
        title="Assessment timeline"
        subtitle="Local evidence, reviews, and triage events"
      >
        <RecordTable
          rows={events}
          getRowKey={(event) => event.id}
          titleHeader="Activity"
          title={(event) => event.title}
          subtitle={(event) => event.detail}
          columns={[
            {
              key: "time",
              header: "Recorded",
              render: (event) => new Date(event.at).toLocaleString(),
              showOnMobile: true,
            },
          ]}
        />
      </ActivityCard>
    </div>
  );
}
