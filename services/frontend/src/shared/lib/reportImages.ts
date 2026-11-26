import type { SessionArtifact } from "@/types/chat";

/**
 * Shared helpers for resolving and embedding raster image evidence
 * (screenshots) in report/evidence surfaces. Consolidates logic that was
 * previously duplicated across RunDetailPage, FindingDetailPage, and
 * RunReportPdfDocument so the matching rules stay in lockstep.
 *
 * NOTE: the backend mirror of `normalizeReportImagePath` lives in
 * `services/backend/src/shared/pdf/PdfReportService.ts` for the server-rendered
 * PDF path. The two must be kept behaviourally identical; they cannot share a
 * module across the service boundary.
 */

const RASTER_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
]);

const getExtension = (value: string): string => {
  const fileName = value.toLowerCase().split("/").pop() ?? "";
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(dotIndex) : "";
};

/** True when the given path/name points at an embeddable raster image. */
export const isRasterImagePath = (value: string | null | undefined): boolean =>
  value ? RASTER_IMAGE_EXTENSIONS.has(getExtension(value)) : false;

export const isRasterImageArtifact = (artifact: SessionArtifact): boolean =>
  isRasterImagePath(artifact.originalName || artifact.filePath || "");

/**
 * Normalize a markdown image href or artifact path into a comparable key:
 * decoded, forward-slashed, stripped of `file://`/`/workspace/` prefixes and
 * leading `./` or `/`, lowercased.
 */
export const normalizeReportImagePath = (value: string): string => {
  let decoded = value.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep malformed URI text as-is.
  }

  return decoded
    .replace(/\\/g, "/")
    .replace(/^file:\/\/\/?/i, "")
    .replace(/^\/workspace\//i, "")
    .replace(/^workspace\//i, "")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .toLowerCase();
};

const artifactMatchCandidates = (artifact: SessionArtifact): string[] =>
  [
    `artifact:${artifact.id}`,
    artifact.originalName,
    artifact.filePath,
    artifact.filePath?.replace(/^sessions\/[^/]+\//i, ""),
  ].filter((candidate): candidate is string => Boolean(candidate));

/**
 * Resolve a markdown image `src` to a session artifact. Skips absolute/remote
 * sources (http/data/blob). Prefers exact match, then a `/`-boundary suffix
 * match in either direction to tolerate workspace-relative vs. absolute paths.
 */
export const resolveReportImageArtifact = (
  src: string | undefined,
  artifacts: SessionArtifact[],
): SessionArtifact | null => {
  if (!src || /^(https?:|data:|blob:)/i.test(src)) return null;
  const normalizedSrc = normalizeReportImagePath(src);
  if (!normalizedSrc) return null;

  return (
    artifacts.find((artifact) => {
      if (!isRasterImageArtifact(artifact)) return false;
      return artifactMatchCandidates(artifact).some((candidate) => {
        const normalizedCandidate = normalizeReportImagePath(candidate);
        return (
          normalizedSrc === normalizedCandidate ||
          normalizedCandidate.endsWith(`/${normalizedSrc}`) ||
          normalizedSrc.endsWith(`/${normalizedCandidate}`)
        );
      });
    }) ?? null
  );
};
