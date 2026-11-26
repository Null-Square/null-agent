import { describe, expect, it } from 'vitest';
import { getWorkerProfileRegistry } from '@/domains/agent-brain/domain/workers/WorkerProfileRegistry';
import { getWorkerTemplate } from '@/domains/agent-brain/domain/workers/workerContracts';

describe('WorkerProfileRegistry', () => {
  it('exposes the canonical built-in worker profiles', () => {
    const workerProfileRegistry = getWorkerProfileRegistry();
    const workerTypes = workerProfileRegistry.list().map((profile) => profile.workerType);
    expect(workerTypes).toEqual([
      'recon_worker',
      'enumeration_worker',
      'validator_worker',
      'attack_worker',
      'evidence_worker',
      'compliance_control_worker',
      'repo_research_worker',
    ]);
  });

  it('returns cloned profiles so callers cannot mutate registry state', () => {
    const workerProfileRegistry = getWorkerProfileRegistry();
    const profile = workerProfileRegistry.get('recon_worker');
    expect(profile).toBeDefined();
    profile!.allowedTools.push('fake_tool');

    expect(workerProfileRegistry.get('recon_worker')?.allowedTools).not.toContain('fake_tool');
    expect(getWorkerTemplate('recon_worker').allowedTools).not.toContain('fake_tool');
  });

  it('exposes registry metadata for diagnostics', () => {
    const workerProfileRegistry = getWorkerProfileRegistry();
    const entry = workerProfileRegistry.getEntry('recon_worker');

    expect(entry).toEqual(
        expect.objectContaining({
          priority: 10,
          source: 'nullai-core-worker-profiles',
        profile: expect.objectContaining({
          workerType: 'recon_worker',
        }),
      }),
    );
    expect(workerProfileRegistry.listEntries()[0]?.priority).toBeGreaterThanOrEqual(0);
  });

  it('allows http_differential in workers that actively probe targets', () => {
    const workerProfileRegistry = getWorkerProfileRegistry();

    expect(workerProfileRegistry.get('recon_worker')?.allowedTools).toContain('http_differential');
    expect(workerProfileRegistry.get('validator_worker')?.allowedTools).toContain('http_differential');
    expect(workerProfileRegistry.get('evidence_worker')?.allowedTools).not.toContain('http_differential');
  });

  it('allows python_session in validator and bounded enumeration workers', () => {
    const workerProfileRegistry = getWorkerProfileRegistry();

    expect(workerProfileRegistry.get('recon_worker')?.allowedTools).not.toContain('python_session');
    expect(workerProfileRegistry.get('enumeration_worker')?.allowedTools).toContain('python_session');
    expect(workerProfileRegistry.get('validator_worker')?.allowedTools).toContain('python_session');
    expect(workerProfileRegistry.get('evidence_worker')?.allowedTools).not.toContain('python_session');
  });

  it('keeps enumeration_worker inside the locked profile boundary', () => {
    const profile = getWorkerProfileRegistry().get('enumeration_worker');
    expect(profile).toEqual(expect.objectContaining({
      defaultArtifactType: 'enumeration_result/v1',
      defaultBudget: expect.objectContaining({
        maxToolCalls: 45,
        maxTargetRequests: 100,
        maxRequestConcurrency: 2,
        maxStateChanges: 0,
      }),
      maxBudget: expect.objectContaining({
        maxToolCalls: 90,
        maxTargetRequests: 250,
        maxRequestConcurrency: 6,
        maxStateChanges: 0,
      }),
    }));
    expect(profile?.allowedTools).toContain('submit_worker_result');
    expect(profile?.allowedTools).not.toEqual(expect.arrayContaining([
      'spawn_worker',
      'file_write',
      'web_search',
      'report_note',
      'report_finding',
      'oob_token_create',
      'submit_phase_handoff',
    ]));
  });
});
