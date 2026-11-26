const MISSION_ENVELOPE_SECTION_PATTERN =
  /^\s*##+\s+mission envelope\s*$\s*```(?:json)?\s*[\s\S]*?```\s*/im;

export function stripMissionEnvelopeFromPlan(
  planMarkdown: string | null | undefined,
): string {
  if (typeof planMarkdown !== "string" || planMarkdown.trim().length === 0) {
    return "";
  }

  return planMarkdown
    .replace(MISSION_ENVELOPE_SECTION_PATTERN, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
