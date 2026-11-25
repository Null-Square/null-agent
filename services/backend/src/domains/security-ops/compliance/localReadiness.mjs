import { controls as nist } from "./nist-csf.mjs";
import { controls as soc } from "./soc2.mjs";
import { controls as iso } from "./iso27001.mjs";
import { controls as pci } from "./pci-dss.mjs";
import { controls as gdpr } from "./gdpr.mjs";
import { controls as hipaa } from "./hipaa.mjs";
import {
  computeQuality,
  dedupeEvidence,
  deriveControlStatus,
  deriveControlVerdict,
  outcomeForControl,
  buildFrameworkSummary,
  buildNistCsfReadinessProfile,
} from "./ComplianceReadinessModel.mjs";

export const framework = "nist_csf";
export const catalogue = {
  soc2: { label: "SOC 2 Readiness", controls: soc },
  gdpr: { label: "GDPR Readiness", controls: gdpr },
  hipaa: { label: "HIPAA Security Rule Readiness", controls: hipaa },
  pci_dss: { label: "PCI DSS v4.0.1 Readiness", controls: pci },
  iso27001: { label: "ISO 27001 Readiness", controls: iso },
  nist_csf: { label: "NIST CSF 2.0 Readiness", controls: nist },
};
export const hasFramework = (key) => typeof key === "string" && Object.hasOwn(catalogue, key);
export const hasControl = (id, key = framework) =>
  hasFramework(key) && catalogue[key].controls.some((c) => c.id === id);

function match(definition, artifact, key) {
  if ((artifact.controlFramework ?? framework) === key && artifact.controlId === definition.id)
    return { source: "user_evidence", confidence: "high", findingIds: [] };
  if (artifact.kind === "compliance_attachment") return;
  const hits = artifact.findings.filter(
    (f) =>
      definition.cweIds?.some((c) => f.cweIds.includes(c)) ||
      definition.findingKeywords?.some((k) =>
        (f.title + " " + f.description + " " + f.ruleId).toLowerCase().includes(k),
      ),
  );
  if (hits.length) return { source: "scanner", confidence: "medium", findingIds: hits.map((f) => f.id) };
  if (
    artifact.kind !== "source" &&
    artifact.kind !== "patch" &&
    artifact.excerpt &&
    definition.noteKeywords?.some((k) => artifact.excerpt.toLowerCase().includes(k))
  )
    return { source: "note", confidence: "low", findingIds: [] };
}

export function snapshot(
  artifacts,
  states = [],
  scopeId = null,
  scope = "",
  key = framework,
  now = new Date(),
) {
  const output = catalogue[key].controls.map((def) => {
    const explicit = states.find((s) => s.controlId === def.id);
    const monitoring = {
      state: explicit?.state ?? (def.supportLevel === "out_of_selected_scope" ? "excluded" : "monitored"),
      source: explicit ? "explicit" : "default",
      exclusionReason: explicit?.reason || null,
      updatedAt: explicit?.updatedAt ?? null,
    };
    const evidence = dedupeEvidence(
      artifacts.flatMap((a) => {
        const hit = match(def, a, key);
        if (!hit) return [];
        const date = Date.parse(a.createdAt);
        return [
          {
            id: a.id,
            kind: "user_evidence",
            title: a.name,
            source: a.name,
            sourceRef: a.id,
            lastSeenAt: a.createdAt,
            findingIds: hit.findingIds,
            mappingSource: hit.source,
            mappingConfidence: hit.confidence,
            quality: computeQuality({
              traceable: true,
              fresh: now - date < (def.freshnessWindowDays ?? 90) * 86400000,
              trustedSource: false,
              scopeComplete: !!scope,
              humanReviewed: false,
            }),
          },
        ];
      }),
    );
    const status = monitoring.state === "excluded" ? "not_applicable" : deriveControlStatus(def, evidence);
    const verdict = deriveControlVerdict(status, []),
      outcome = outcomeForControl(verdict, []);
    const reason =
      monitoring.state === "excluded"
        ? monitoring.exclusionReason || "Outside the monitored scope."
        : evidence.length
          ? "Supplied evidence is available for review. Independent control testing is pending."
          : def.missingGap;
    const limits = [
      "The local assessment contains user-supplied evidence. No independent control test has been recorded.",
    ];
    return {
      id: def.id,
      title: def.title,
      theme: def.theme,
      supportLevel: def.supportLevel,
      implementationSpec: def.implementationSpec ?? null,
      pciDssRequirement: def.pciDssRequirement ?? null,
      pciDssGoal: def.pciDssGoal ?? null,
      pciDssApproach: def.pciDssApproach ?? null,
      pciDssSaqTypes: def.pciDssSaqTypes ?? null,
      pciDssCdeScope: def.pciDssCdeScope ?? null,
      pciDssAccountData: def.pciDssAccountData ?? null,
      status,
      verdict,
      outcome,
      monitoring,
      reasonCode: status,
      basis: null,
      score: 0,
      rationale: reason,
      verdictReason: reason,
      controlStatement: def.title,
      description: def.title,
      gaps: evidence.length || monitoring.state === "excluded" ? [] : [def.missingGap],
      evidence,
      coverageLimitations: limits,
      limitations: limits,
      catalogRef: key + ":" + def.id,
      proofObligation: null,
      requiredEvidence: def.evidenceExamples ?? [],
      nextAction:
        monitoring.state === "excluded"
          ? "Review the documented scope decision."
          : "Inspect the linked evidence and record a validation decision independently.",
      evidenceFreshness: { freshestAt: evidence[0]?.lastSeenAt ?? null, stale: status === "stale" },
      assignment: { assignedToUserId: null, assignedByUserId: null, assignedAt: null },
      actionRequests: [],
      controlChecks: [],
    };
  });
  const summary = buildFrameworkSummary({
    key,
    label: catalogue[key].label,
    selected: true,
    supported: true,
    controls: output,
  });
  if (key === "nist_csf") summary.frameworkProfile = buildNistCsfReadinessProfile(output);
  const monitored = output.filter((c) => c.monitoring.state === "monitored");
  const technical = monitored.filter((c) => c.supportLevel === "automated_testable");
  const manual = monitored.filter((c) =>
    ["manual_evidence_required", "integration_required"].includes(c.supportLevel),
  );
  return {
    generatedAt: now.toISOString(),
    scopeId,
    runId: null,
    latestCompletedRunId: null,
    selectedFrameworks: [{ key, label: summary.label, sources: ["scope_profile"] }],
    supportedFrameworks: Object.keys(catalogue),
    frameworks: [summary],
    scorecards: {
      agentProvenTechnical: {
        total: technical.length,
        passed: 0,
        failed: 0,
        needsContext: 0,
        notAttempted: technical.filter((c) => c.verdict === "not_attempted").length,
        stale: technical.filter((c) => c.status === "stale").length,
      },
      customerEvidence: {
        total: manual.length,
        approved: 0,
        missing: manual.filter((c) => c.verdict === "not_attempted" || c.verdict === "needs_evidence")
          .length,
        stale: manual.filter((c) => c.status === "stale").length,
        integrationRequired: manual.filter((c) => c.supportLevel === "integration_required").length,
        acceptedRisk: 0,
      },
      outcomes: summary.outcomeCounts,
    },
    reviewSummary: { total: 0, unreviewed: 0, confirmed: 0, rejected: 0, retestRequired: 0 },
    reportRequest: { canStart: true, scopeId, latestCompletedRunId: null, reason: null },
  };
}

export function evidenceMappings(readiness) {
  return readiness.frameworks[0].controls.map((c) => ({
    framework: readiness.frameworks[0].key,
    edition: readiness.frameworks[0].label,
    controlId: c.id,
    title: c.title,
    status: c.monitoring.state === "excluded" ? "excluded" : c.evidence.length ? "review" : "no_evidence",
    verdict: c.verdict,
    rationale: c.rationale,
    evidenceIds: c.evidence.map((e) => e.id),
    findingIds: [...new Set(c.evidence.flatMap((e) => e.findingIds))],
  }));
}
