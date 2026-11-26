type ArtifactLookupEntry = {
  artifactId: string;
};

export type FindingEvidenceArtifactRow = {
  id: string;
  sessionId: string;
  originalName: string;
  filePath: string;
};

export type ResolveFindingEvidenceInput = {
  sessionId: string | null;
  path: string;
  fileMissing: boolean;
};

export type ResolveFindingEvidenceResult = {
  sessionId?: string;
  artifactId?: string;
  downloadPath?: string;
  fileMissing: boolean;
};

const normalizeRelativePath = (rawPath: string): string => {
  let candidate = rawPath.trim().replace(/\\/g, '/');
  if (!candidate) return candidate;

  if (candidate.startsWith('/workspace/')) {
    candidate = candidate.slice('/workspace/'.length);
  } else if (candidate.startsWith('workspace/')) {
    candidate = candidate.slice('workspace/'.length);
  }

  if (candidate.startsWith('./')) {
    candidate = candidate.slice(2);
  }

  while (candidate.startsWith('/')) {
    candidate = candidate.slice(1);
  }

  return candidate;
};

const extractRelativePathFromArtifactFilePath = (filePath: string, sessionId: string): string | undefined => {
  const marker = `/${sessionId}/`;
  const markerIndex = filePath.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;

  const relative = filePath.slice(markerIndex + marker.length);
  const normalized = normalizeRelativePath(relative);
  return normalized || undefined;
};

const buildLookupKey = (sessionId: string, relativePath: string): string => `${sessionId}::${relativePath}`;

export const buildFindingEvidenceArtifactLookup = (
  artifactRows: FindingEvidenceArtifactRow[],
): Map<string, ArtifactLookupEntry> => {
  const lookup = new Map<string, ArtifactLookupEntry>();

  for (const row of artifactRows) {
    const sessionId = row.sessionId?.trim();
    if (!sessionId) continue;

    const normalizedOriginalName = normalizeRelativePath(row.originalName);
    if (normalizedOriginalName) {
      lookup.set(buildLookupKey(sessionId, normalizedOriginalName), { artifactId: row.id });
    }

    const extractedFromFilePath = extractRelativePathFromArtifactFilePath(row.filePath, sessionId);
    if (extractedFromFilePath) {
      lookup.set(buildLookupKey(sessionId, extractedFromFilePath), { artifactId: row.id });
    }
  }

  return lookup;
};

export const resolveFindingEvidenceArtifact = (
  evidence: ResolveFindingEvidenceInput,
  artifactLookup: Map<string, ArtifactLookupEntry>,
): ResolveFindingEvidenceResult => {
  const sessionId = evidence.sessionId?.trim();
  if (!sessionId) {
    return { fileMissing: evidence.fileMissing };
  }

  const normalizedPath = normalizeRelativePath(evidence.path);
  if (!normalizedPath) {
    return { sessionId, fileMissing: evidence.fileMissing };
  }

  const artifact = artifactLookup.get(buildLookupKey(sessionId, normalizedPath));
  if (!artifact) {
    return { sessionId, fileMissing: evidence.fileMissing };
  }

  return {
    sessionId,
    artifactId: artifact.artifactId,
    downloadPath: `/api/ai-agent/sessions/${sessionId}/artifacts/${artifact.artifactId}/download`,
    fileMissing: false,
  };
};

