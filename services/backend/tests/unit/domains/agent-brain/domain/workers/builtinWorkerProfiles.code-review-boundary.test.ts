import { describe, expect, it } from 'vitest';

import { BUILTIN_WORKER_PROFILES } from '@/domains/agent-brain/domain/workers/builtinWorkerProfiles';

const repositoryTools = [
  'list_connected_repositories',
  'search_connected_repository',
  'read_connected_repository_file',
];

describe('Pentest worker source boundary', () => {
  it('keeps broad repository reads out of enumeration and evidence workers', () => {
    for (const workerType of ['enumeration_worker', 'evidence_worker'] as const) {
      const profile = BUILTIN_WORKER_PROFILES.find((candidate) => candidate.workerType === workerType);
      expect(profile?.allowedTools).toEqual(expect.not.arrayContaining(repositoryTools));
    }
  });

  it('retains repository reads only in the dedicated validation support worker', () => {
    const profile = BUILTIN_WORKER_PROFILES.find(
      (candidate) => candidate.workerType === 'repo_research_worker',
    );

    expect(profile?.allowedTools).toEqual(expect.arrayContaining(repositoryTools));
  });
});
