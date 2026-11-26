import { describe, expect, it } from 'vitest';

import { phaseProfileRegistry } from '@/domains/security-ops/runs/PhaseProfileRegistry';

const allowFor = (
  phaseKey: Parameters<typeof phaseProfileRegistry.buildToolPolicy>[0],
  context?: Parameters<typeof phaseProfileRegistry.buildToolPolicy>[1],
): string[] => phaseProfileRegistry.buildToolPolicy(phaseKey, context).allow ?? [];

describe('PhaseProfileRegistry tool policy', () => {
  it('keeps only canonical handoff and restart checkpoint tools in discovery phases', () => {
    for (const phaseKey of ['recon', 'enumeration'] as const) {
      const allow = allowFor(phaseKey);

      expect(allow).toContain('submit_phase_handoff');
      expect(allow).toContain('submit_phase_checkpoint');
      expect(allow).toContain(`${phaseKey}_handoff_preflight`);
      expect(allow).not.toContain(`${phaseKey === 'recon' ? 'enumeration' : 'recon'}_handoff_preflight`);
      expect(allow).not.toContain('transition_phase');
      expect(allow).not.toContain('oob_token_create');
      expect(allow).not.toContain('oob_check_interactions');
    }
  });

  it('withholds checkpoints and deprecated phase movement outside discovery phases', () => {
    for (const phaseKey of ['validation', 'evidence', 'reporting'] as const) {
      const allow = allowFor(phaseKey);

      expect(allow).toContain('submit_phase_handoff');
      expect(allow).toContain(`${phaseKey}_handoff_preflight`);
      expect(allow).not.toContain('submit_phase_checkpoint');
      expect(allow).not.toContain('transition_phase');
    }
  });

  it('keeps OOB tools available to validation where blind proof skills need them', () => {
    const allow = allowFor('validation');

    expect(allow).toContain('oob_token_create');
    expect(allow).toContain('oob_check_interactions');
    expect(allow).toContain('submit_validation_lead_outcome');
  });

  it('makes http_differential available in probing phases but not reporting', () => {
    expect(allowFor('recon')).toContain('http_differential');
    expect(allowFor('enumeration')).toContain('http_differential');
    expect(allowFor('validation')).toContain('http_differential');
    expect(allowFor('reporting')).not.toContain('http_differential');
  });

  it('admits enumeration_worker and its parent disposition only in enumeration', () => {
    expect(phaseProfileRegistry.get('enumeration').workerSpawning.allowedWorkerTypes)
      .toContain('enumeration_worker');
    for (const phaseKey of ['planning', 'recon', 'validation', 'evidence', 'control_assessment', 'reporting'] as const) {
      expect(phaseProfileRegistry.get(phaseKey).workerSpawning.allowedWorkerTypes)
        .not.toContain('enumeration_worker');
      expect(allowFor(phaseKey)).not.toContain('submit_enumeration_disposition');
    }
    expect(allowFor('enumeration')).toContain('submit_enumeration_disposition');
  });

  it('exposes durable personas and authz replay only to probing phases', () => {
    expect(allowFor('recon')).toEqual(expect.arrayContaining(['persona_save', 'persona_list', 'persona_load']));
    expect(allowFor('recon')).not.toContain('authz_replay');
    expect(allowFor('enumeration')).toEqual(expect.arrayContaining(['persona_save', 'persona_list', 'persona_load', 'authz_replay']));
    expect(allowFor('validation')).toEqual(expect.arrayContaining(['persona_save', 'persona_list', 'persona_load', 'authz_replay']));
    expect(allowFor('reporting')).not.toContain('persona_save');
    expect(allowFor('reporting')).not.toContain('authz_replay');
  });

  it('exposes python_session only where stateful PoC and replay work belongs', () => {
    expect(allowFor('recon')).not.toContain('python_session');
    expect(allowFor('enumeration')).toContain('python_session');
    expect(allowFor('validation')).toContain('python_session');
    expect(allowFor('evidence')).toContain('python_session');
    expect(allowFor('reporting')).not.toContain('python_session');
  });

  it('allows reporting finalizer preflight before authored closeout', () => {
    const allow = allowFor('reporting');

    expect(allow).toContain('report_finalizer_preflight');
    expect(allow).toContain('prepare_report_context');
    expect(allow).toContain('finalize_run_artifacts');
  });

  it('keeps compliance query tools out of normal pentest reporting', () => {
    const allow = allowFor('reporting');

    expect(allow).not.toContain('query_compliance_readiness');
    expect(allow).not.toContain('query_compliance_evidence');
    expect(allow).not.toContain('query_compliance_proof_package');
  });

  it('adds compliance query tools only for explicit compliance reporting', () => {
    const allow = allowFor('reporting', { complianceReporting: true });

    expect(allow).toContain('query_compliance_readiness');
    expect(allow).toContain('query_compliance_evidence');
    expect(allow).toContain('query_compliance_proof_package');
    expect(allow).not.toContain('report_finding');
  });

  it('allows reporting to repair canonical finding report fields without validation controls', () => {
    const allow = allowFor('reporting');

    expect(allow).toContain('report_finding');
    expect(allow).not.toContain('promote_finding');
    expect(allow).not.toContain('submit_validation_outcome');
    expect(allow).not.toContain('submit_validation_lead_outcome');
  });

  it('keeps every Code Review phase on its isolated product policy', () => {
    for (const phaseKey of [
      'review_mapping',
      'review_analysis',
      'review_validation',
      'review_reporting',
    ] as const) {
      const profile = phaseProfileRegistry.get(phaseKey);
      const allow = allowFor(phaseKey, { whiteboxEnabled: true, connectedRepoCount: 1 });

      expect(profile.phaseProfile).toBe(`phase-${phaseKey.replace('_', '-')}`);
      expect(allow).toEqual(expect.arrayContaining([
        'file_read',
        'file_write',
        'submit_phase_handoff',
      ]));
      expect(allow).not.toEqual(expect.arrayContaining([
        'list_connected_repositories',
        'search_connected_repository',
        'http_raw_send',
        'browser_action',
        'shell_run',
        'report_finding',
        'finalize_run_artifacts',
        'spawn_worker',
      ]));
    }

    expect(allowFor('review_mapping')).toEqual(expect.arrayContaining([
      'list_code_review_repository_files',
      'search_code_review_repository',
      'read_connected_repository_file',
      'query_code_review_memory',
      'record_code_review_memory',
    ]));
    expect(allowFor('review_analysis')).toEqual(expect.arrayContaining([
      'search_code_review_repository',
      'read_connected_repository_file',
      'query_code_review_memory',
      'query_code_review_findings',
      'report_code_review_candidate',
    ]));
    expect(allowFor('review_validation')).toEqual(expect.arrayContaining([
      'search_code_review_repository',
      'read_connected_repository_file',
      'query_code_review_memory',
      'record_code_review_memory',
      'query_code_review_findings',
      'validate_code_review_finding',
    ]));
    expect(allowFor('review_reporting')).toEqual(expect.arrayContaining([
      'query_code_review_findings',
      'record_code_review_memory',
      'finalize_code_review_report',
    ]));
    expect(allowFor('review_reporting')).not.toEqual(expect.arrayContaining([
      'read_connected_repository_file',
      'report_code_review_candidate',
      'validate_code_review_finding',
      'query_code_review_memory',
    ]));
    expect(allowFor('review_analysis')).not.toContain('record_code_review_memory');
    expect(allowFor('review_reporting')).not.toContain('query_code_review_memory');
  });

  it('removes durable memory writes from pull-request, fix, and non-default-branch review phases', () => {
    for (const phaseKey of ['review_mapping', 'review_validation', 'review_reporting'] as const) {
      const allow = allowFor(phaseKey, {
        workflowDiscipline: 'code_review',
        codeReviewMemoryWriteAllowed: false,
      });

      expect(allow).not.toContain('record_code_review_memory');
    }
    expect(allowFor('review_mapping', {
      workflowDiscipline: 'code_review',
      codeReviewMemoryWriteAllowed: false,
    })).toContain('query_code_review_memory');
  });

  it('limits Pentest repository reads to bounded validation', () => {
    const repoTools = [
      'list_connected_repositories',
      'search_connected_repository',
      'read_connected_repository_file',
    ];

    expect(allowFor('validation', {
      whiteboxEnabled: false,
      connectedRepoCount: 0,
      workflowDiscipline: 'pentest',
    }))
      .toEqual(expect.not.arrayContaining(repoTools));
    expect(allowFor('validation', {
      whiteboxEnabled: true,
      connectedRepoCount: 0,
      workflowDiscipline: 'pentest',
    }))
      .toEqual(expect.not.arrayContaining(repoTools));
    expect(allowFor('validation', {
      whiteboxEnabled: true,
      connectedRepoCount: 1,
      workflowDiscipline: 'pentest',
    }))
      .toEqual(expect.arrayContaining(repoTools));
    for (const phaseKey of ['planning', 'recon', 'enumeration', 'evidence', 'reporting'] as const) {
      expect(allowFor(phaseKey, {
        whiteboxEnabled: true,
        connectedRepoCount: 1,
        workflowDiscipline: 'pentest',
      })).toEqual(expect.not.arrayContaining(repoTools));
    }
  });

  it('adds worker management tools only for worker-spawning phases', () => {
    const reconPolicy = allowFor('recon');
    const reportingPolicy = allowFor('reporting');

    expect(reconPolicy).toContain('spawn_worker');
    expect(reconPolicy).toContain('wait_for_worker');
    expect(reportingPolicy).not.toContain('spawn_worker');
    expect(reportingPolicy).not.toContain('wait_for_worker');
  });

  it('defines scanner wall budgets for each phase profile', () => {
    for (const profile of phaseProfileRegistry.list()) {
      expect(profile.maxScannerWallSeconds).toBeGreaterThan(0);
    }
    expect(phaseProfileRegistry.get('validation').maxScannerWallSeconds).toBe(180);
    expect(phaseProfileRegistry.get('reporting').maxScannerWallSeconds).toBe(60);
  });
});
