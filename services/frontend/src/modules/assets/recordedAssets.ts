import type { Finding, Project } from "../../local";

const severityOrder = ["critical", "high", "medium", "low", "info"] as const;
export type AssetFocusLabel = (typeof severityOrder)[number];

export interface Asset {
  value: string;
  kind: string;
  firstImportedAt?: string;
  focus?: AssetFocusLabel;
  findings: Finding[];
}

export function assetPath(value: string) {
  return "/assets/detail?" + new URLSearchParams({ value });
}

// The imported findings own the asset values and evidence references.
export function recordedAssets(project?: Project): Asset[] {
  const grouped = new Map<string, Finding[]>();
  for (const finding of project?.findings ?? []) {
    if (!finding.assetValue) continue;
    const items = grouped.get(finding.assetValue) ?? [];
    items.push(finding);
    grouped.set(finding.assetValue, items);
  }
  return Array.from(grouped, ([value, findings]) => {
    const kinds = new Set(
      findings.flatMap((finding) =>
        finding.assetKind ? [finding.assetKind.toLowerCase()] : [],
      ),
    );
    return {
      value,
      kind: kinds.size === 1 ? [...kinds][0] : "unknown",
      firstImportedAt: findings
        .flatMap((finding) =>
          finding.evidence.map((evidence) => evidence.createdAt),
        )
        .sort()[0],
      focus: severityOrder.find((severity) =>
        findings.some((finding) => finding.severity === severity),
      ),
      findings,
    };
  }).sort(
    (left, right) =>
      severityRank(left.focus) - severityRank(right.focus) ||
      left.value.localeCompare(right.value),
  );
}

function severityRank(severity?: AssetFocusLabel) {
  return severity === undefined
    ? severityOrder.length
    : severityOrder.indexOf(severity);
}
