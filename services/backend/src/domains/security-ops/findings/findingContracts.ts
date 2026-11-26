import { createHash } from "crypto";

export const STRUCTURED_HTTP_BODY_LIMIT_BYTES = 16 * 1024;

const REDACTED_HEADER_VALUE = "[REDACTED]";
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-amz-security-token",
]);

type FindingRecord = Record<string, unknown>;

export type FindingPathKind = "repository" | "workspace";
export type FindingEvidenceKind = "artifact" | "http_exchange";
export type FindingHttpEvidenceSource = "browser" | "request_tool" | "manual" | "unknown";
export type FindingValidationReplayEscapeReason =
  | "blind_oob"
  | "race"
  | "one_time_token"
  | "non_idempotent"
  | "unsafe_to_replay"
  | "target_drift"
  | "other";
export type FindingProofObligationStatus = "proven" | "unproven" | "needs_context";
export type FindingAdvisoryTriageVerdict = "agree" | "disagree" | "needs_context";
export type FindingAdvisoryTriageFlag = "duplicate" | "weak_evidence" | "risky_to_replay";

export type FindingCodeLocation = {
  pathKind: FindingPathKind;
  repository: string | null;
  ref: string | null;
  filePath: string;
  startLine: number;
  endLine: number;
  label: string | null;
  fixBefore: string;
  fixAfter: string;
};

export type FindingHttpHeader = {
  name: string;
  value: string;
  redacted?: boolean;
};

export type HttpBodyPreview = {
  text: string;
  truncated: boolean;
};

export type FindingHttpRequest = {
  method: string;
  url: string;
  contentType?: string | null;
  headers?: FindingHttpHeader[];
  body?: HttpBodyPreview | null;
};

export type FindingHttpResponse = {
  statusCode: number;
  contentType?: string | null;
  headers?: FindingHttpHeader[];
  body?: HttpBodyPreview | null;
};

export type FindingHttpExchange = {
  source?: FindingHttpEvidenceSource;
  durationMs?: number | null;
  request: FindingHttpRequest;
  response: FindingHttpResponse;
};

export type FindingValidationProof = {
  claim: string;
  evidenceIds: string[];
  replayAttempted: boolean;
  replayArtifact?: string;
  replayReproduced?: boolean;
  notReplayedReason?: FindingValidationReplayEscapeReason;
};

export type FindingProofObligation = {
  id: string;
  observable: string;
  status: FindingProofObligationStatus;
  evidenceIds: string[];
  note?: string;
};

export type FindingAdvisoryTriage = {
  verdict: FindingAdvisoryTriageVerdict;
  reason: string;
  triagedBy: string;
  evidenceIds: string[];
  duplicateOf?: string;
  flags: FindingAdvisoryTriageFlag[];
};

export type FindingValidationProofBundle = {
  schemaVersion: 1;
  proof: FindingValidationProof;
  obligations: FindingProofObligation[];
  advisoryTriage: FindingAdvisoryTriage;
};

export type FindingValidationEvidenceRef =
  | { path: string; label?: string }
  | ({
      kind: "validation_proof";
      path: string;
      label: string;
    } & FindingValidationProofBundle);

export type FindingEvidenceSummary = {
  total: number;
  artifactCount: number;
  downloadableArtifactCount: number;
  structuredHttpCount: number;
  excerptCount: number;
  fileMissingCount: number;
};

export type FindingReviewMeta = {
  codeLocationCount: number;
  copyFixPromptReady: boolean;
  evidenceSummary: FindingEvidenceSummary;
};

type ReviewMetaEvidenceRow = {
  kind?: string | null;
  excerpt?: string | null;
  fileMissing?: boolean | null;
  hasDownloadableArtifact: boolean;
};

const isRecord = (value: unknown): value is FindingRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const VALID_REPLAY_ESCAPE_REASONS = new Set<FindingValidationReplayEscapeReason>([
  "blind_oob",
  "race",
  "one_time_token",
  "non_idempotent",
  "unsafe_to_replay",
  "target_drift",
  "other",
]);

const VALID_OBLIGATION_STATUSES = new Set<FindingProofObligationStatus>([
  "proven",
  "unproven",
  "needs_context",
]);

const VALID_TRIAGE_VERDICTS = new Set<FindingAdvisoryTriageVerdict>([
  "agree",
  "disagree",
  "needs_context",
]);

const VALID_TRIAGE_FLAGS = new Set<FindingAdvisoryTriageFlag>([
  "duplicate",
  "weak_evidence",
  "risky_to_replay",
]);

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
};

const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .map((entry) => normalizeOptionalString(entry))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  );
};

const normalizeReplayEscapeReason = (value: unknown): FindingValidationReplayEscapeReason | undefined => {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return normalized && VALID_REPLAY_ESCAPE_REASONS.has(normalized as FindingValidationReplayEscapeReason)
    ? normalized as FindingValidationReplayEscapeReason
    : undefined;
};

const normalizeObligationStatus = (value: unknown): FindingProofObligationStatus | undefined => {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return normalized && VALID_OBLIGATION_STATUSES.has(normalized as FindingProofObligationStatus)
    ? normalized as FindingProofObligationStatus
    : undefined;
};

const normalizeTriageVerdict = (value: unknown): FindingAdvisoryTriageVerdict | undefined => {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return normalized && VALID_TRIAGE_VERDICTS.has(normalized as FindingAdvisoryTriageVerdict)
    ? normalized as FindingAdvisoryTriageVerdict
    : undefined;
};

const normalizeTriageFlags = (value: unknown): FindingAdvisoryTriageFlag[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .map((entry) => normalizeOptionalString(entry)?.toLowerCase())
        .filter((entry): entry is FindingAdvisoryTriageFlag =>
          Boolean(entry && VALID_TRIAGE_FLAGS.has(entry as FindingAdvisoryTriageFlag)),
        ),
    ),
  );
};

const normalizePositiveInt = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return null;
};

const truncateUtf8 = (value: string, maxBytes: number): HttpBodyPreview => {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) {
    return { text: value, truncated: false };
  }

  let truncated = buffer.subarray(0, maxBytes).toString("utf8");
  truncated = truncated.replace(/\uFFFD$/, "");
  return { text: truncated, truncated: true };
};

export const normalizeFindingEvidenceKind = (kind: string | null | undefined): FindingEvidenceKind =>
  kind === "http_exchange" ? "http_exchange" : "artifact";

export const redactFindingHttpHeaders = (
  headers: Array<{ name: string; value: string; redacted?: boolean }> | null | undefined,
): FindingHttpHeader[] | undefined => {
  if (!headers || headers.length === 0) {
    return undefined;
  }

  const normalized: FindingHttpHeader[] = [];
  for (const header of headers) {
      const name = header.name.trim();
      if (!name) {
        continue;
      }

      const shouldRedact = header.redacted === true || SENSITIVE_HEADER_NAMES.has(name.toLowerCase());
      const value = shouldRedact ? REDACTED_HEADER_VALUE : header.value.trim();
      normalized.push({
        name,
        value,
        ...(shouldRedact ? { redacted: true } : {}),
      });
  }

  normalized.sort((left, right) => {
    const byName = left.name.toLowerCase().localeCompare(right.name.toLowerCase());
    if (byName !== 0) return byName;
    return left.value.localeCompare(right.value);
  });

  return normalized.length > 0 ? normalized : undefined;
};

export const buildHttpBodyPreview = (value: string | null | undefined): HttpBodyPreview | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return truncateUtf8(trimmed, STRUCTURED_HTTP_BODY_LIMIT_BYTES);
};

export const buildStructuredHttpEvidenceDisplayPath = (method: string, url: string): string =>
  `${method.trim().toUpperCase()} ${url.trim()}`;

export const buildStructuredHttpEvidencePath = (http: FindingHttpExchange): string =>
  `http:${createHash("sha256").update(stableStringify(http)).digest("hex")}`;

export const buildFindingReviewMeta = (params: {
  codeLocations: FindingCodeLocation[];
  evidence: ReviewMetaEvidenceRow[];
}): FindingReviewMeta => {
  const evidenceSummary: FindingEvidenceSummary = {
    total: params.evidence.length,
    artifactCount: 0,
    downloadableArtifactCount: 0,
    structuredHttpCount: 0,
    excerptCount: 0,
    fileMissingCount: 0,
  };

  for (const row of params.evidence) {
    const kind = normalizeFindingEvidenceKind(row.kind);
    if (kind === "http_exchange") {
      evidenceSummary.structuredHttpCount += 1;
    } else {
      evidenceSummary.artifactCount += 1;
      if (row.hasDownloadableArtifact) {
        evidenceSummary.downloadableArtifactCount += 1;
      }
      if (typeof row.excerpt === "string" && row.excerpt.trim().length > 0) {
        evidenceSummary.excerptCount += 1;
      }
      if (row.fileMissing) {
        evidenceSummary.fileMissingCount += 1;
      }
    }
  }

  return {
    codeLocationCount: params.codeLocations.length,
    copyFixPromptReady: params.codeLocations.length > 0,
    evidenceSummary,
  };
};

export const normalizeFindingValidationProofBundle = (
  value: unknown,
): FindingValidationProofBundle | null => {
  if (!isRecord(value)) {
    return null;
  }
  const proofRaw = isRecord(value["proof"]) ? value["proof"] : null;
  const triageRaw = isRecord(value["advisoryTriage"]) ? value["advisoryTriage"] : null;
  if (!proofRaw || !triageRaw) {
    return null;
  }

  const claim = normalizeOptionalString(proofRaw["claim"]);
  if (!claim) {
    return null;
  }
  const evidenceIds = normalizeStringArray(proofRaw["evidenceIds"]);
  const replayAttempted = proofRaw["replayAttempted"] === true;
  const replayArtifact = normalizeOptionalString(proofRaw["replayArtifact"]) ?? undefined;
  const replayReproduced =
    typeof proofRaw["replayReproduced"] === "boolean" ? proofRaw["replayReproduced"] : undefined;
  const notReplayedReason = normalizeReplayEscapeReason(proofRaw["notReplayedReason"]);

  const obligationsRaw = Array.isArray(value["obligations"]) ? value["obligations"] : [];
  const obligations: FindingProofObligation[] = [];
  obligationsRaw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      return;
    }
    const observable = normalizeOptionalString(entry["observable"]);
    const status = normalizeObligationStatus(entry["status"]);
    if (!observable || !status) {
      return;
    }
    obligations.push({
      id: normalizeOptionalString(entry["id"]) ?? `obligation-${index + 1}`,
      observable,
      status,
      evidenceIds: normalizeStringArray(entry["evidenceIds"]),
      ...(normalizeOptionalString(entry["note"]) ? { note: normalizeOptionalString(entry["note"]) as string } : {}),
    });
  });

  const verdict = normalizeTriageVerdict(triageRaw["verdict"]);
  const triageReason = normalizeOptionalString(triageRaw["reason"]);
  const triagedBy = normalizeOptionalString(triageRaw["triagedBy"]);
  if (!verdict || !triageReason || !triagedBy) {
    return null;
  }

  return {
    schemaVersion: 1,
    proof: {
      claim,
      evidenceIds,
      replayAttempted,
      ...(replayArtifact ? { replayArtifact } : {}),
      ...(replayReproduced !== undefined ? { replayReproduced } : {}),
      ...(notReplayedReason ? { notReplayedReason } : {}),
    },
    obligations,
    advisoryTriage: {
      verdict,
      reason: triageReason,
      triagedBy,
      evidenceIds: normalizeStringArray(triageRaw["evidenceIds"]),
      ...(normalizeOptionalString(triageRaw["duplicateOf"])
        ? { duplicateOf: normalizeOptionalString(triageRaw["duplicateOf"]) as string }
        : {}),
      flags: normalizeTriageFlags(triageRaw["flags"]),
    },
  };
};

export const extractFindingValidationProofBundle = (
  evidenceRefs: unknown,
): FindingValidationProofBundle | null => {
  if (!Array.isArray(evidenceRefs)) {
    return null;
  }
  for (const entry of evidenceRefs) {
    if (!isRecord(entry) || entry["kind"] !== "validation_proof") {
      continue;
    }
    const bundle = normalizeFindingValidationProofBundle(entry);
    if (bundle) {
      return bundle;
    }
  }
  return null;
};

export const normalizeStoredCodeLocations = (value: unknown): FindingCodeLocation[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: FindingCodeLocation[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }

    const pathKind = item["pathKind"] === "repository" || item["pathKind"] === "workspace" ? item["pathKind"] : null;
    const filePath = normalizeOptionalString(item["filePath"]);
    const startLine = normalizePositiveInt(item["startLine"]);
    const endLine = normalizePositiveInt(item["endLine"]);
    const fixBefore = normalizeOptionalString(item["fixBefore"]);
    const fixAfter = normalizeOptionalString(item["fixAfter"]);
    if (!pathKind || !filePath || !startLine || !endLine || endLine < startLine || !fixBefore || !fixAfter) {
      continue;
    }

    const repository = normalizeOptionalString(item["repository"]);
    if (pathKind === "repository" && !repository) {
      continue;
    }
    if (pathKind === "workspace" && repository) {
      continue;
    }

    normalized.push({
      pathKind,
      repository: pathKind === "repository" ? repository : null,
      ref: normalizeOptionalString(item["ref"]),
      filePath,
      startLine,
      endLine,
      label: normalizeOptionalString(item["label"]),
      fixBefore,
      fixAfter,
    });
  }

  return normalized;
};
