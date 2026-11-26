import type { CanonicalRiskDetail, Finding } from '@/modules/security-ops/types';

/**
 * A canonical Risk, in the shape the detail page already renders.
 *
 * An unpublished code occurrence has no Finding record, so without this it
 * would need a page of its own — which is exactly the second page this work
 * exists to remove. The anatomy is identical; only the record it comes from
 * differs, so the record is adapted rather than the page duplicated.
 */
export const riskDetailToFinding = (detail: CanonicalRiskDetail): Finding => ({
  id: detail.id,
  title: detail.title,
  severity: detail.severity,
  state: detail.state,
  assetId: detail.asset?.id ?? null,
  assetValue: detail.asset?.value ?? detail.codeOccurrence?.repositoryFullName ?? '',
  assetKind: detail.asset?.kind ?? 'repository',
  scopeId: detail.scope.id,
  scopeName: detail.scope.name,
  summary: detail.summary || null,
  businessImpact: detail.businessImpact,
  technicalAnalysis: detail.technicalAnalysis,
  remediation: detail.remediation,
  cvssVector: detail.cvssVector,
  cvssScore: detail.cvssScore,
  cweId: detail.cweIds[0] ?? null,
  cveId: detail.cveIds[0] ?? null,
  cweIds: detail.cweIds,
  cveIds: detail.cveIds,
  firstSeenAt: detail.firstSeenAt,
  lastSeenAt: detail.lastSeenAt,
  createdAt: detail.firstSeenAt,
  // The source panels render the occurrence's own locations; this keeps the
  // page's affected-code section in step for a code Risk.
  codeLocations: (detail.codeOccurrence?.locations ?? []).map((location) => ({
    pathKind: 'repository' as const,
    repository: detail.codeOccurrence?.repositoryFullName ?? '',
    filePath: location.filePath,
    startLine: location.startLine ?? 0,
    endLine: location.endLine ?? location.startLine ?? 0,
  })),
});
