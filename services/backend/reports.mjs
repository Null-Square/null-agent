import { redact } from "./evidence.mjs";

const text = (value) =>
  redact(String(value))
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\!#*_\x60[\]<>|])/g, "\\$1");

export function renderMarkdownReport(project) {
  const lines = ["# " + text(project.name), "", text(project.scope), "", "## Imported evidence", ""];
  for (const a of project.artifacts) lines.push("- " + text(a.name) + " (" + a.id + ")");
  for (const f of project.findings) {
    lines.push(
      "",
      "### " + text(f.title),
      "",
      "Severity: " + text(f.severity),
      "",
      "Triage state: " + text(f.state),
      "",
      text(f.description),
      "",
      "Remediation: " + text(f.remediation || "Reviewer assessment required."),
      "",
      "Source: " + text(f.evidence[0].title) + " (" + f.evidence[0].id + ")",
    );
    if (f.location)
      lines.push(
        "",
        "Location: " + text(f.location.path) + (f.location.startLine ? ":" + f.location.startLine : ""),
      );
  }
  lines.push(
    "",
    "## " + project.readiness.frameworks[0].label,
    "",
    "Control effectiveness requires independent review.",
    "",
  );
  for (const m of project.mappings)
    lines.push(
      "- " +
        m.controlId +
        " " +
        m.title +
        " — " +
        m.status +
        " (" +
        (m.evidenceIds.join(", ") || "no evidence references") +
        ")",
    );
  if (project.review) lines.push("", "## Model-assisted review", "", text(project.review.text));
  return lines.join("\n") + "\n";
}
