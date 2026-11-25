import { randomUUID } from "node:crypto";
import path from "node:path";
import { redactCodeReviewText } from "./src/domains/security-ops/code-review/CodeReviewRedaction.mjs";
import { resolveCodeReviewSourceAnchor } from "./src/domains/security-ops/code-review/CodeReviewSourceAnchor.mjs";
import {
  framework,
  snapshot,
  evidenceMappings,
  hasControl,
} from "./src/domains/security-ops/compliance/localReadiness.mjs";
export { framework };
import { stripVTControlCharacters } from "node:util";

export function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function inputText(value, field, max, required = false) {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
    throw invalid(
      "Invalid " +
        field +
        ". Expected " +
        (required ? "nonempty " : "") +
        "text up to " +
        max +
        " characters.",
    );
  }
  return value.trim();
}

// Adapted from the tagged application's CodeReviewRedaction, with local paths
// and credential-bearing URLs also removed from exports and model context.
export function redact(value) {
  return redactCodeReviewText(stripVTControlCharacters(value))
    .replace(
      /(["'](?:password|passwd|secret|token|access[_-]?token|client[_-]?secret|api[_-]?key)["']\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
      "$1[redacted]",
    )
    .replace(/\bsk-[a-z\d_-]{16,}\b/gi, "[credential omitted]")
    .replace(/(?:set-cookie|cookie|authorization|x-api-key)\s*:[^\r\n]*/gi, "[header omitted]")
    .replace(/\b(?:https?|file):\/\/[^\s"'<>]+/gi, (raw) => {
      try {
        const u = new URL(raw);
        return u.protocol === "file:" ? "[local file]" : u.origin;
      } catch {
        return "[URL omitted]";
      }
    })
    .replace(
      /(^|[\s("'=])(?:[A-Z]:[\\/]|\\\\|\/(?:Users|home|private|tmp|var|mnt)\/)[^\n\r"'<>]*/gi,
      "$1[local path]",
    )
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}

function relativeLocation(file, line, end) {
  if (typeof file !== "string" || !file || file.length > 512 || /[\x00-\x1f]/.test(file)) return;
  const portable = file.replaceAll("\\", "/");
  if (
    /^(?:\/|[a-z][a-z\d+.-]*:)/i.test(portable) ||
    portable.split("/").includes("..") ||
    redact(portable) !== portable
  )
    return;
  const location = { path: path.posix.normalize(portable) };
  if (Number.isSafeInteger(line) && line > 0) {
    location.startLine = line;
    if (Number.isSafeInteger(end) && end >= line) location.endLine = end;
  }
  return location;
}

const safe = (value, fallback = "") =>
  typeof value === "string" ? redact(value).slice(0, 6000) : fallback;

// Scanner scores and asset identities are supplied evidence. Severity and file
// location alone cannot establish either property.
export function findingDetails(row) {
  const details = {};
  const score = row.cvssScore ?? row.cvss?.score;
  const numericScore =
    typeof score === "string" && /^\d{1,2}(?:\.\d)?$/.test(score) ? Number(score) : score;
  if (Number.isFinite(numericScore) && numericScore >= 0 && numericScore <= 10)
    details.cvssScore = numericScore;
  const vector = row.cvssVector ?? row.cvss?.vector;
  if (
    typeof vector === "string" &&
    vector.length <= 256 &&
    /^(?:CVSS:(?:2\.0|3\.[01]|4\.0)\/|(?=AV:))(?:[A-Z]{1,4}:[A-Z0-9]{1,3}\/)*[A-Z]{1,4}:[A-Z0-9]{1,3}$/i.test(
      vector,
    )
  )
    details.cvssVector = vector;
  const assetValue = row.assetValue ?? row.asset?.value ?? row.asset;
  const assetKind = row.assetKind ?? row.asset?.kind;
  if (typeof assetValue === "string" && assetValue.length <= 2048 && assetValue.trim())
    details.assetValue = safe(assetValue.trim());
  if (typeof assetKind === "string" && /^[a-z][\w -]{0,40}$/i.test(assetKind))
    details.assetKind = assetKind;
  return details;
}

function severity(value) {
  const level = typeof value === "string" ? value.toLowerCase() : "";
  const levels = {
    critical: "critical",
    high: "high",
    error: "high",
    medium: "medium",
    warning: "medium",
    low: "low",
    info: "info",
    informational: "info",
  };
  return Object.hasOwn(levels, level) ? levels[level] : "unknown";
}

export const MAX_EVIDENCE_FILE_BYTES = 1024 * 1024;

function evidenceFileName(name) {
  name = inputText(name, "file name", 180, true);
  if (
    name !== path.win32.basename(name) ||
    /[<>:"|?*\x00-\x1f]/.test(name) ||
    name === "." ||
    name === ".."
  )
    throw invalid("Use a file name without folders or special characters.");
  return name;
}

function evidenceMetadata(name, sizeBytes, controlId, controlFramework) {
  const artifact = {
    id: randomUUID(),
    originalName: name,
    name: redact(name),
    sizeBytes,
    createdAt: new Date().toISOString(),
    findings: [],
    observationCount: 0,
  };
  if (controlId !== undefined && !hasControl(controlId, controlFramework))
    throw invalid("Unknown framework control.");
  if (controlId) {
    artifact.controlId = controlId;
    artifact.controlFramework = controlFramework;
  }
  return artifact;
}

export function importComplianceAttachment(name, bytes, controlId, controlFramework) {
  if (!controlId || !controlFramework) throw invalid("Select a framework and control.");
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_EVIDENCE_FILE_BYTES)
    throw invalid("Choose a nonempty evidence file up to 1 MiB.");
  const artifact = {
    ...evidenceMetadata(evidenceFileName(name), bytes.byteLength, controlId, controlFramework),
    kind: "compliance_attachment",
  };
  if (/\.(txt|md)$/i.test(artifact.originalName) && bytes.byteLength <= 6000) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.trim() && !text.includes("\0")) artifact.excerpt = redact(text);
    } catch {
      // Keep the original bytes even when a document does not contain UTF-8 text.
    }
  }
  return artifact;
}

export function isManageableComplianceEvidence(artifact) {
  const findingCount = artifact.findings?.length ?? artifact.findingCount;
  return (
    artifact.kind === "compliance_attachment" ||
    (!artifact.kind && findingCount === 0 && typeof artifact.excerpt === "string")
  );
}

export function importArtifact(name, content, controlId, controlFramework = framework) {
  name = evidenceFileName(name);
  if (typeof content !== "string" || !content.trim() || Buffer.byteLength(content) > MAX_EVIDENCE_FILE_BYTES)
    throw invalid("Choose a nonempty UTF-8 evidence file up to 1 MiB.");
  const artifact = evidenceMetadata(name, Buffer.byteLength(content), controlId, controlFramework);
  const { id, createdAt } = artifact;
  if (
    /\.(js|mjs|cjs|jsx|ts|tsx|py|go|java|rb|rs|cs|c|cpp|h|hpp|kt|php|swift|sql|sh|ps1|diff|patch)$/i.test(
      name,
    )
  ) {
    if (artifact.sizeBytes > 8192 || /[\u0000\ufffd]/.test(content))
      throw invalid("Select a UTF-8 source file or patch of at most 8 KiB, or save a smaller excerpt.");
    artifact.kind = /\.(diff|patch)$/i.test(name) ? "patch" : "source";
    const anchor = content
      .split(/\r\n?|\n/)
      .find((line) => line.trim())
      .slice(0, 1000);
    const preview = sourceAnchor(content, name, { sourceAnchor: anchor, occurrence: 1 });
    artifact.sourcePreview = { ...preview, sourceExcerpt: redact(preview.sourceExcerpt) };
    return artifact;
  }
  function add(row, source) {
    if (artifact.findings.length >= 500)
      throw invalid("Each evidence file can contain up to 500 findings.");
    const title = safe(row.title);
    if (!title.trim()) throw invalid("A finding is missing its title or rule identifier.");
    artifact.findings.push({
      id: id + ":" + (artifact.findings.length + 1),
      title,
      source,
      severity: severity(row.severity),
      description: safe(row.description),
      remediation: safe(row.remediation),
      location: row.location,
      ...findingDetails(row),
      ruleId: safe(row.ruleId),
      cweIds: Array.isArray(row.cweIds)
        ? row.cweIds
            .filter((v) => typeof v === "string" && /^CWE-\d{1,6}$/i.test(v))
            .map((v) => v.toUpperCase())
        : [],
      evidence: [{ id, kind: "scanner_artifact", title: artifact.name, path: artifact.name, createdAt }],
    });
  }
  if (/\.(txt|md|js|jsx|ts|tsx|py|go|rs|java|cs|diff|patch)$/i.test(name)) {
    if (Buffer.byteLength(content) > 6000 || content.includes("\0"))
      throw invalid(
        "Choose a text source, patch, or note up to 6,000 UTF-8 bytes. Split longer inputs before import.",
      );
    artifact.excerpt = redact(content);
    artifact.observationCount = 1;
    return artifact;
  }
  let data;
  try {
    data = JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch {
    if (!/\.jsonl$/i.test(name))
      throw invalid("Invalid JSON. Choose scanner JSON, JSONL or a text evidence note.");
    data = content
      .trim()
      .split(/\r?\n/)
      .filter((v) => v.trim())
      .map((v, i) => {
        try {
          return JSON.parse(v);
        } catch {
          throw invalid("Invalid JSONL on record " + (i + 1) + ". The file was not imported.");
        }
      });
  }
  if (Array.isArray(data?.results)) {
    if (data.errors?.length)
      throw invalid("Analyzer output contains errors. Resolve them before importing.");
    for (const row of data.results) {
      if (!row?.check_id || !row.extra) throw invalid("Invalid Semgrep result.");
      add(
        {
          title: row.check_id,
          ruleId: row.check_id,
          ...row.extra,
          description: row.extra.message,
          remediation: row.extra.fix ?? row.extra.metadata?.fix,
          cvssScore: row.extra.cvssScore ?? row.extra.metadata?.cvssScore,
          cvssVector: row.extra.cvssVector ?? row.extra.metadata?.cvssVector,
          cvss: row.extra.cvss ?? row.extra.metadata?.cvss,
          assetValue: row.extra.assetValue ?? row.extra.metadata?.assetValue,
          assetKind: row.extra.assetKind ?? row.extra.metadata?.assetKind,
          cweIds: row.extra.metadata?.cwe,
          location: relativeLocation(row.path, row.start?.line, row.end?.line),
        },
        "semgrep",
      );
    }
  } else {
    const rows = Array.isArray(data) ? data : [data];
    for (const row of rows) {
      if (row?.["template-id"] && row.info)
        add(
          {
            ...row.info,
            ruleId: row["template-id"],
            title: row.info.name ?? row["template-id"],
            cweIds: row.info.classification?.["cwe-id"],
            cvssScore: row.info.classification?.["cvss-score"],
            cvssVector: row.info.classification?.["cvss-metrics"],
            assetValue: row.host ?? row["matched-at"],
          },
          "nuclei",
        );
      else if (row?.url && typeof row.status_code === "number") artifact.observationCount++;
      else if (
        Array.isArray(data) &&
        typeof row?.title === "string" &&
        typeof row.description === "string" &&
        typeof row.severity === "string"
      ) {
        add(
          {
            ...row,
            location: relativeLocation(row.location?.path, row.location?.startLine, row.location?.endLine),
          },
          safe(row.source, "imported finding"),
        );
      } else
        throw invalid(
          "Unsupported evidence record. Choose Semgrep JSON, Nuclei JSONL, saved findings, or a text note.",
        );
    }
  }
  return artifact;
}

export function readiness(artifacts) {
  return evidenceMappings(snapshot(artifacts));
}

export function sourceAnchor(content, filePath, body) {
  if (typeof body.sourceAnchor !== "string" || !body.sourceAnchor.trim() || body.sourceAnchor.length > 8000)
    throw invalid("Provide 1�8,000 characters of exact source text.");
  if (body.occurrence !== undefined && (!Number.isInteger(body.occurrence) || body.occurrence < 1))
    throw invalid("Occurrence must be a positive integer.");
  try {
    return resolveCodeReviewSourceAnchor(content, {
      filePath,
      sourceAnchor: body.sourceAnchor,
      occurrence: body.occurrence,
      contextBeforeLines: 1,
      contextAfterLines: 1,
    });
  } catch (err) {
    throw invalid(err.message);
  }
}
