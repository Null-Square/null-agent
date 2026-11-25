import { useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  DetailBackLink,
  DetailPageShell,
  DetailHeader,
  DetailSection,
  DetailRailBlock,
  StatusPill,
  StatusTabs,
  ListNotice,
  ListSkeleton,
} from "@null-ai/design-tokens/ui";
import { useLocal, projectAPI } from "../../../local";
import type { ComplianceReadinessResponse } from "../../security-ops/types";
import { EvidenceLibrary } from "./EvidenceLibrary";
function DetailText({
  value,
  fallback,
}: {
  value: string | null | undefined;
  fallback?: string;
}) {
  return (
    <p className="max-w-[72ch] text-[15px] leading-8 text-foreground">
      {value?.trim() ? (
        value
      ) : (
        <span className="text-muted-foreground">
          {fallback ?? "Not provided."}
        </span>
      )}
    </p>
  );
}

function DefinitionRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-4 py-4">
      <div className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        {label}
      </div>

      <div className="text-sm text-foreground">{children}</div>
    </div>
  );
}

export default function ComplianceControlPage() {
  const { frameworkKey, controlId } = useParams();
  const navigate = useNavigate();
  const { id } = useLocal();
  const [activeTab, setActiveTab] = useState("overview");
  const query = useQuery({
    queryKey: ["readiness", id, frameworkKey],
    queryFn: () =>
      projectAPI<ComplianceReadinessResponse>(
        id,
        "/readiness?framework=" + encodeURIComponent(frameworkKey || ""),
      ),
    enabled: !!id,
  });
  const framework = query.data?.frameworks.find((f) => f.key === frameworkKey);
  const control = framework?.controls.find((c) => c.id === controlId);
  if (query.isLoading) return <ListSkeleton label="Reading control" />;
  if (query.error || !framework || !control)
    return (
      <div className="p-8">
        <ListNotice
          tone="neutral"
          title={query.error?.message || "Control not found"}
        />
        <DetailBackLink
          label="Back to Compliance"
          onClick={() => navigate("/compliance")}
        />
      </div>
    );
  const rail = (
    <DetailRailBlock label="Verdict">
      <p>{control.verdictReason}</p>
      <div className="mt-4 text-xs text-muted-foreground">
        {control.monitoring.state}
      </div>
    </DetailRailBlock>
  );
  return (
    <DetailPageShell
      backLink={
        <DetailBackLink
          label="Back to Compliance"
          onClick={() => navigate("/compliance")}
        />
      }
      displayId={`${framework.label} · ${control.id}`}
      rail={rail}
    >
      <DetailHeader
        badges={
          <>
            <StatusPill
              tone={
                control.outcome === "failed"
                  ? "destructive"
                  : control.outcome === "passed"
                    ? "success"
                    : "neutral"
              }
            >
              {control.outcome.replaceAll("_", " ")}
            </StatusPill>
          </>
        }
        title={control.title}
        subline={[
          framework.label,

          control.theme,

          control.catalogRef ? (
            <span key="ref" className="font-mono">
              {control.catalogRef}
            </span>
          ) : null,
        ]}
      />

      <StatusTabs
        className="mt-10"
        tone="bone"
        aria-label="Control sections"
        value={activeTab}
        onChange={(value) => setActiveTab(value as typeof activeTab)}
        itemAttributes={(item) => ({
          "data-tour": `control-tab-${item.value}`,
        })}
        items={[
          { value: "overview", label: "Overview" },

          { value: "evidence", label: "Evidence" },

          { value: "remediation", label: "Remediation" },

          { value: "history", label: "History" },
        ]}
      />
      {activeTab === "overview" && (
        <div className="mt-8 space-y-10">
          {" "}
          <DetailSection label="What must be true">
            <DetailText
              value={
                control.proofObligation?.statement ??
                control.gaps[0] ??
                control.nextAction
              }
              fallback="No proof obligation has been authored for this control yet."
            />

            {control.requiredEvidence.length > 0 ? (
              <div className="mt-5 flex flex-wrap gap-2">
                {control.requiredEvidence.map((item) => (
                  <span
                    key={item}
                    className="rounded-none border border-border/70 bg-surface-1/50 px-2.5 py-1.5 text-xs text-muted-foreground"
                  >
                    {item}
                  </span>
                ))}
              </div>
            ) : null}
          </DetailSection>
          <DetailSection label="Why this outcome">
            <DetailText value={control.verdictReason} />

            <div className="mt-6 divide-y divide-border/70 border-y border-border/70">
              <DefinitionRow label="Reason code">
                <span className="font-mono text-xs">{control.reasonCode}</span>
              </DefinitionRow>

              <DefinitionRow label="Basis">
                {control.basis ? (
                  control.basis
                ) : (
                  <span className="text-muted-foreground">
                    No agent verdict yet
                  </span>
                )}
              </DefinitionRow>

              <DefinitionRow label="Freshness">
                {control.evidenceFreshness.freshestAt ? (
                  `Updated ${new Date(control.evidenceFreshness.freshestAt).toLocaleDateString()}`
                ) : (
                  <span className="text-muted-foreground">
                    No dated evidence
                  </span>
                )}

                {control.evidenceFreshness.stale ? (
                  <span className="ml-2 text-warning">(stale)</span>
                ) : null}
              </DefinitionRow>
            </div>
          </DetailSection>
        </div>
      )}
      {activeTab === "evidence" && (
        <div className="mt-8 space-y-5">
          <DetailSection label="Mapped evidence">
            {control.evidence.length ? (
              control.evidence.map((e) => <p key={e.id}>{e.title}</p>)
            ) : (
              <p>No evidence mapped to this control.</p>
            )}
          </DetailSection>
          <EvidenceLibrary
            controlId={control.id}
            framework={framework.key}
            artifactIds={control.evidence.map((e) => e.sourceRef)}
          />
        </div>
      )}
      {activeTab === "remediation" && (
        <DetailSection label="Recommendation">
          <DetailText value={control.nextAction} />
          {control.gaps.map((g) => (
            <p key={g}>{g}</p>
          ))}
        </DetailSection>
      )}
    </DetailPageShell>
  );
}
