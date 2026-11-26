/**
 * Artifacts API
 *
 * Uses authenticatedFetch for proper error handling.
 */

import { useQuery } from '@tanstack/react-query';
import { authenticatedFetch, fetchApiBaseUrl as apiBaseUrl } from '@shared/api';
import { validateArtifacts } from '@shared/lib/validators';
import type { SessionArtifact } from '@/types/chat';

interface ArtifactContentResponse {
  content?: string;
}

type SessionArtifactsQueryOptions = {
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: number | false;
  refetchOnMount?: boolean | 'always';
};

export const fetchArtifactContent = async (
  sessionId: string,
  artifactId: string,
): Promise<string | undefined> => {
  const data = await authenticatedFetch<ArtifactContentResponse>(
    `${apiBaseUrl}/api/ai-agent/sessions/${sessionId}/artifacts/${artifactId}/content`
  );
  return data?.content;
};

export const downloadArtifactUrl = (sessionId: string, artifactId: string): string =>
  `${apiBaseUrl}/api/ai-agent/sessions/${sessionId}/artifacts/${artifactId}/download`;

export const downloadArtifactBlob = async (
  sessionId: string,
  artifactId: string,
): Promise<Blob> => {
  const res = await fetch(downloadArtifactUrl(sessionId, artifactId));
  if (!res.ok) {
    // For blob downloads, we can't easily parse JSON error, so we throw a descriptive message
    throw new Error(`Failed to download artifact: ${res.status} ${res.statusText}`);
  }
  return res.blob();
};

export const fetchArtifacts = async (
  sessionId: string,
): Promise<SessionArtifact[]> => {
  const data = await authenticatedFetch<{ artifacts?: SessionArtifact[] }>(
    `/api/ai-agent/sessions/${sessionId}/artifacts`
  );
  return validateArtifacts(data?.artifacts ?? []);
};

export const useSessionArtifactsQuery = (
  sessionId: string | undefined,
  options?: SessionArtifactsQueryOptions,
) => {
  return useQuery<SessionArtifact[]>({
    queryKey: ['ai-agent-session-artifacts', sessionId],
    enabled: options?.enabled ?? !!sessionId,
    queryFn: () => fetchArtifacts(sessionId!),
    staleTime: options?.staleTime ?? 5_000,
    refetchInterval: options?.refetchInterval ?? false,
    refetchOnMount: options?.refetchOnMount,
    refetchOnWindowFocus: true,
  });
};

export const useSessionArtifactContentQuery = (
  sessionId: string | undefined,
  artifactId: string | undefined,
  options?: Omit<SessionArtifactsQueryOptions, 'refetchInterval'>,
) => {
  return useQuery<string | undefined>({
    queryKey: ['ai-agent-session-artifact-content', sessionId, artifactId],
    enabled: options?.enabled ?? Boolean(sessionId && artifactId),
    queryFn: () => fetchArtifactContent(sessionId!, artifactId!),
    staleTime: options?.staleTime ?? 5_000,
    refetchOnMount: options?.refetchOnMount,
    refetchOnWindowFocus: true,
  });
};
