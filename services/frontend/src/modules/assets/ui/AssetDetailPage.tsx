import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  DetailBackLink,
  DetailHeader,
  DetailPageShell,
  DetailRailBlock,
  DetailSection,
  ListEmptyState,
  ListMetrics,
  RecordTable,
  SeverityBadge,
  StatusTabs,
} from "@null-ai/design-tokens/ui";
import { evidenceURL, useLocal } from "../../../local";
import { recordedAssets, type Asset } from "../recordedAssets";
import { AssetKindBadge } from "./components/AssetKindBadge";

function AssetDetail({ asset }: { asset: Asset }) {
  const { id, project } = useLocal();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("overview");
  const evidenceIds = new Set(
    asset.findings.flatMap((finding) =>
      finding.evidence.map((evidence) => evidence.id),
    ),
  );
  const files =
    project?.artifacts.filter((file) => evidenceIds.has(file.id)) ?? [];
  const backLink = (
    <DetailBackLink
      label="Back to Assets"
      onClick={() => navigate("/assets")}
    />
  );
  return (
    <DetailPageShell
      backLink={backLink}
      rail={
        <DetailRailBlock label="Asset">
          <AssetKindBadge kind={asset.kind} />
          {asset.firstImportedAt && (
            <p className="mt-3 text-sm text-muted-foreground">
              First imported{" "}
              {new Date(asset.firstImportedAt).toLocaleDateString()}
            </p>
          )}
        </DetailRailBlock>
      }
    >
      <DetailHeader
        title={<span className="break-all">{asset.value}</span>}
        subline={["Imported evidence"]}
      />
      <StatusTabs
        value={activeTab}
        onChange={setActiveTab}
        aria-label="Asset sections"
        items={[
          { value: "overview", label: "Overview" },
          { value: "findings", label: "Risks", count: asset.findings.length },
          { value: "runs", label: "Assessments", count: 1 },
        ]}
      />
      {activeTab === "overview" && (
        <div role="tabpanel" aria-label="Overview" className="space-y-6">
          <ListMetrics
            label="Imported finding severity"
            items={[
              {
                label: "Critical",
                value: count("critical"),
                severity: "critical",
              },
              { label: "High", value: count("high"), severity: "high" },
              { label: "Medium", value: count("medium"), severity: "medium" },
              { label: "Low", value: count("low"), severity: "low" },
            ]}
          />
          <DetailSection label="Evidence">
            <ul className="space-y-2">
              {files.map((file) => (
                <li key={file.id}>
                  <a
                    className="underline"
                    href={evidenceURL(id, file.id)}
                    download
                  >
                    {file.name}
                  </a>
                </li>
              ))}
            </ul>
          </DetailSection>
        </div>
      )}
      {activeTab === "findings" && (
        <div role="tabpanel" aria-label="Risks">
          <RecordTable
            rows={asset.findings}
            getRowKey={(finding) => finding.id}
            titleHeader="Risk"
            title={(finding) => finding.title}
            rowActionLabel={(finding) => "Open risk: " + finding.title}
            onRowClick={(finding) =>
              navigate("/risks/" + encodeURIComponent(finding.id))
            }
            columns={[
              {
                key: "severity",
                header: "Severity",
                render: (finding) => (
                  <SeverityBadge severity={finding.severity} />
                ),
              },
            ]}
          />
        </div>
      )}
      {activeTab === "runs" && (
        <div role="tabpanel" aria-label="Assessments" className="py-6">
          <Link to={"/runs/" + encodeURIComponent(id)} className="underline">
            {project?.name}
          </Link>
        </div>
      )}
    </DetailPageShell>
  );

  function count(severity: string) {
    return asset.findings.filter((finding) => finding.severity === severity)
      .length;
  }
}

export default function AssetDetailPage() {
  const [params] = useSearchParams();
  const { project } = useLocal();
  const asset = recordedAssets(project).find(
    (item) => item.value === params.get("value"),
  );
  return asset ? (
    <AssetDetail key={project?.id + ":" + asset.value} asset={asset} />
  ) : (
    <DetailPageShell>
      <ListEmptyState
        icon="assets"
        title="Asset unavailable"
        description="This asset is absent from the current scope’s retained evidence."
        action={
          <Link to="/assets" className="underline">
            Back to Assets
          </Link>
        }
      />
    </DetailPageShell>
  );
}
