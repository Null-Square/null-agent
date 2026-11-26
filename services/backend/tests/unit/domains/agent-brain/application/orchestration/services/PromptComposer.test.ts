import { describe, it, expect } from 'vitest';
import { PromptComposer } from '@/domains/agent-brain/application/orchestration/services/PromptComposer';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@/domains/agent-brain/domain/prompts';
import { phaseProfileRegistry } from '@/domains/security-ops/runs/PhaseProfileRegistry';

describe('PromptComposer', () => {
  it('builds static prompt from agentType and tools', () => {
    const composer = new PromptComposer();
    const result = composer.build({
      session: {} as any,
      agentType: 'chat',
      softContext: '',
      tools: [
        {
          name: 'file_read',
          description: 'Read a file\nUse this before guessing file contents.',
          parameters: {} as any,
        },
      ],
    });

    expect(result.staticPrompt).toContain('file_read');
    expect(result.staticPrompt).toContain('You have access to the following tools');
    expect(result.staticPrompt).toContain('  Use this before guessing file contents.');
    expect(result.agentType).toBe('chat');
    expect(result.promptProfile).toBe('chat');
  });

  it('composes executor base prompt with phase-specific Markdown profile', () => {
    const composer = new PromptComposer();
    const result = composer.build({
      session: {
        agentType: 'executor',
        promptProfile: 'phase-recon',
        flags: {},
        plan: [],
      } as any,
      agentType: 'executor',
      softContext: '',
      tools: [],
    });

    expect(result.promptProfile).toBe('phase-recon');
    expect(result.staticPrompt).toContain('You are a senior security operator');
    expect(result.staticPrompt).toContain('Recon Phase Contract');
    expect(result.staticPrompt).toContain('submit_phase_handoff');
  });

  it('uses compliance executor posture for control assessment phases', () => {
    const composer = new PromptComposer();
    const result = composer.build({
      session: {
        agentType: 'executor',
        promptProfile: 'phase-control-assessment',
        flags: { securityops: { workflowDiscipline: 'compliance', activePhaseKey: 'control_assessment' } },
        plan: [],
      } as any,
      agentType: 'executor',
      softContext: '',
      tools: [],
    });

    expect(result.promptProfile).toBe('phase-control-assessment');
    expect(result.staticPrompt).toContain('compliance readiness operator');
    expect(result.staticPrompt).toContain('Control Assessment Phase Contract');
    expect(result.staticPrompt).not.toContain('authorized penetration test');
    expect(result.staticPrompt).not.toContain('report_finding');
  });

  it('uses compliance executor posture for compliance reporting phases', () => {
    const composer = new PromptComposer();
    const result = composer.build({
      session: {
        agentType: 'executor',
        promptProfile: 'compliance-reporting',
        flags: { securityops: { workflowDiscipline: 'compliance', activePhaseKey: 'reporting' } },
        plan: [],
      } as any,
      agentType: 'executor',
      softContext: '',
      tools: [],
    });

    expect(result.promptProfile).toBe('compliance-reporting');
    expect(result.staticPrompt).toContain('compliance readiness operator');
    expect(result.staticPrompt).toContain('Compliance Reporting Phase Contract');
    expect(result.staticPrompt).not.toContain('authorized penetration test');
    expect(result.staticPrompt).not.toContain('report_finding');
  });

  it('uses a standalone Code Review planner contract without Pentest campaign instructions', () => {
    const composer = new PromptComposer();
    const result = composer.build({
      session: {
        agentType: 'planner',
        promptProfile: 'code-review-planner',
        flags: {
          securityops: {
            workflowDiscipline: 'code_review',
            activePhaseKey: 'planning',
          },
        },
        mode: 'automated',
        toolPolicy: {
          allow: ['submit_plan', 'file_read'],
        },
        plan: [],
      } as any,
      agentType: 'planner',
      softContext: '',
      tools: [],
    });

    expect(result.promptProfile).toBe('code-review-planner');
    expect(result.staticPrompt).toContain('Plan one security-focused review');
    expect(result.staticPrompt).toContain('review_mapping');
    expect(result.staticPrompt).toContain('phase-to-skill routing is fixed');
    expect(result.staticPrompt).not.toContain('continuous testing platform');
    expect(result.staticPrompt).not.toContain('Broad Scan Rule');
    expect(result.staticPrompt).not.toContain('query_notes');
    expect(result.dynamicPrompt).not.toContain('call report_note');
    expect(result.dynamicPrompt).toContain('stop cleanly instead of looping');
  });

  it('keeps all composed Code Review phase prompts aligned with their specialized tools', () => {
    const composer = new PromptComposer();
    const requiredTools = {
      review_mapping: [
        'query_code_review_memory',
        'record_code_review_memory',
        'list_code_review_repository_files',
        'search_code_review_repository',
        'read_connected_repository_file',
        'submit_phase_handoff',
      ],
      review_analysis: [
        'query_code_review_memory',
        'query_code_review_findings',
        'report_code_review_candidate',
        'submit_phase_handoff',
      ],
      review_validation: [
        'query_code_review_memory',
        'record_code_review_memory',
        'query_code_review_findings',
        'validate_code_review_finding',
        'submit_phase_handoff',
      ],
      review_reporting: [
        'record_code_review_memory',
        'query_code_review_findings',
        'finalize_code_review_report',
        'submit_phase_handoff',
      ],
    } as const;
    const forbiddenTools = [
      'http_raw_send',
      'browser_action',
      'shell_run',
      'report_finding',
      'promote_finding',
      'prepare_report_context',
      'finalize_run_artifacts',
      'record_control_check',
    ];

    for (const [phaseKey, required] of Object.entries(requiredTools)) {
      const profile = phaseProfileRegistry.get(phaseKey as keyof typeof requiredTools);
      const toolPolicy = phaseProfileRegistry.buildToolPolicy(
        phaseKey as keyof typeof requiredTools,
        {
          whiteboxEnabled: true,
          connectedRepoCount: 1,
          workflowDiscipline: 'code_review',
        },
      );
      const result = composer.build({
        session: {
          agentType: 'executor',
          promptProfile: profile.promptProfile,
          mode: 'automated',
          toolPolicy,
          flags: {
            securityops: {
              runId: 'run-1',
              workflowDiscipline: 'code_review',
              activePhaseKey: phaseKey,
            },
          },
          plan: [],
        } as any,
        agentType: 'executor',
        softContext: '',
        tools: [],
      });

      expect(toolPolicy.allow).toEqual(expect.arrayContaining([...required]));
      expect(toolPolicy.allow).toEqual(expect.not.arrayContaining(forbiddenTools));
      expect(result.staticPrompt).toContain('security-focused Code Review');
      expect(result.staticPrompt).not.toContain('You are a senior security operator');
      expect(result.dynamicPrompt).toContain('submit_phase_handoff');
      expect(result.dynamicPrompt).toContain(
        'Capture blockers and unresolved questions in submit_phase_handoff',
      );
      expect(result.dynamicPrompt).not.toContain('approach.tried');
      expect(result.dynamicPrompt).not.toContain('prepare_report_context');
      expect(result.dynamicPrompt).not.toContain('finalize_run_artifacts');
    }
  });

  it('includes soft context in cacheablePrefix', () => {
    const composer = new PromptComposer();
    const result = composer.build({
      session: {} as any,
      agentType: 'chat',
      softContext: 'TASK CONTEXT: scan the target',
      tools: [],
    });

    expect(result.cacheablePrefix).toContain('TASK CONTEXT: scan the target');
    expect(result.cacheablePrefix).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(result.dynamicBoundary).toBe(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(result.sections.soft.map((section) => section.key)).toEqual(['soft_context']);
  });

  it('bakes security testing posture rules into the static prompt', () => {
    const composer = new PromptComposer();
    const result = composer.build({
      session: {
        agentType: 'executor',
        promptProfile: 'phase-validation',
        extraContext: '=== ENGAGEMENT BRIEF ===\nTesting Posture: white-box (auto-derived: connected source repository present)',
        flags: { securityops: { runId: 'run-1', activePhaseKey: 'validation' } },
        plan: [],
      } as any,
      agentType: 'executor',
      softContext: '',
      tools: [],
    });

    expect(result.staticPrompt).toContain('TESTING MODE POLICY');
    expect(result.staticPrompt).toContain('Testing Mode: WHITE-BOX');
    expect(result.staticPrompt).toContain('This remains a Pentest');
    expect(result.staticPrompt).toContain('Do not perform repository-wide review');
    expect(result.cacheablePrefix).toContain('Testing Mode: WHITE-BOX');
  });

  it('builds a worker execution contract without report requirements', () => {
    const composer = new PromptComposer();
    const result = composer.build({
      session: {
        agentType: 'executor',
        mode: 'automated',
        coordination: {
          role: 'worker',
          parentSessionId: 'parent-1',
          parentTaskId: 'task-1',
          workerType: 'recon_worker',
          expectedArtifactType: 'surface_map',
        },
        flags: {},
        plan: [],
      } as any,
      agentType: 'executor',
      softContext: '',
      tools: [],
    });

    expect(result.dynamicPrompt).toContain('COORDINATION CONTRACT');
    expect(result.dynamicPrompt).toContain('submit_worker_result');
    expect(result.dynamicPrompt).toContain('Do not delegate further');
    expect(result.dynamicPrompt).toContain('automated worker mode');
    expect(result.dynamicPrompt).not.toContain('SECURITY WORKFLOW');
    expect(result.dynamicPrompt).not.toContain('EXECUTION TURN CONTRACT');
    expect(result.dynamicPrompt).not.toContain('report.md');
  });

  it('renders the hard automated executor tool-call rule for security runs', () => {
    const composer = new PromptComposer();
    const result = composer.build({
      session: {
        agentType: 'executor',
        mode: 'automated',
        promptProfile: 'phase-recon',
        flags: { securityops: { runId: 'run-1', activePhaseKey: 'recon' } },
        plan: [],
      } as any,
      agentType: 'executor',
      softContext: '',
      tools: [],
    });

    expect(result.dynamicPrompt).toContain('Every output MUST contain at least one tool call');
    expect(result.dynamicPrompt).toContain('submit_phase_checkpoint');
    expect(result.dynamicPrompt).toContain('submit_phase_handoff with a blocker reason');
  });

  it('renders parent worker task summaries into the dynamic prompt when worker spawning is available', () => {
    const composer = new PromptComposer();
    const result = composer.build({
      session: {
        agentType: 'executor',
        mode: 'automated',
        coordination: { role: 'direct' },
        workerTasks: [
          {
            taskId: 'task-1',
            parentSessionId: 'parent-1',
            workerSessionId: 'worker-1',
            workerType: 'validator_worker',
            status: 'completed',
            reason: 'Confirm SQL injection path',
            task: 'Validate the reported path',
            expectedArtifactType: 'validation_result',
            executionMode: 'blocking',
            continuationMode: 'spawn',
            createdAt: 1,
            summary: 'Validator confirmed the request path is exploitable.',
          },
        ],
        flags: { workerSpawningAvailable: true },
        plan: [],
      } as any,
      agentType: 'executor',
      softContext: '',
      tools: [],
    });

    expect(result.dynamicPrompt).toContain('WORKER TASKS (MUTABLE)');
    expect(result.dynamicPrompt).toContain('WORKER COVERAGE SNAPSHOT');
    expect(result.dynamicPrompt).toContain('task-1 [completed/blocking] validator_worker');
    expect(result.dynamicPrompt).toContain('Use workers only when they materially improve coverage, confidence, or speed over direct work');
    expect(result.dynamicPrompt).toContain('DELEGATION PLAYBOOK');
    expect(result.dynamicPrompt).toContain('executionMode="background"');
    expect(result.dynamicPrompt).toContain('dependencyMode="dependency"');
    expect(result.dynamicPrompt).toContain('wait_for_worker is a plain state tool');
    expect(result.dynamicPrompt).toContain('SECURITY WORKFLOW');
    expect(result.dynamicPrompt).toContain('Use report_finding to record candidate findings with evidence');
    expect(result.dynamicPrompt).toContain('Use promote_finding only after durable evidence satisfies the reportable gate');
    expect(result.dynamicPrompt).toContain('The spawn_worker tool description is the source of truth for worker-role selection and arguments');
    expect(result.dynamicPrompt).not.toContain('exploit_worker');
    expect(result.dynamicPrompt).not.toContain('report_writer_worker');
  });

  it('renders delegation activation guidance only when the build stage provides the one-turn flag', () => {
    const composer = new PromptComposer();
    const result = composer.build({
      session: {
        agentType: 'executor',
        mode: 'automated',
        coordination: { role: 'direct' },
        workerTasks: [],
        plan: [],
        flags: {
          workerSpawningAvailable: true,
          delegationActivationGuidance:
            '- This run matches high-confidence delegation patterns.\n- [strong] spawn_worker(workerType="recon_worker", executionMode="background", dependencyMode="sidecar")',
        },
      } as any,
      agentType: 'executor',
      softContext: '',
      tools: [],
    });

    expect(result.dynamicPrompt).toContain('DELEGATION ACTIVATION GUIDANCE');
    expect(result.dynamicPrompt).toContain('high-confidence delegation patterns');
    expect(result.dynamicPrompt).toContain('spawn_worker(workerType="recon_worker"');
  });

  it('does not render delegation activation guidance without the build-stage one-turn flag', () => {
    const composer = new PromptComposer();
    const result = composer.build({
      session: {
        agentType: 'executor',
        mode: 'automated',
        executionMode: 'discovery',
        coordination: { role: 'direct' },
        workerTasks: [],
        extraContext: '=== ASSIGNED METHODOLOGIES ===\n- broad-surface-scan: /workspace/.skills/broad-surface-scan/methodology.md\n',
        plan: [
          { id: 'task-1', title: 'Broad Surface Scan on app.example.com', status: 'pending' },
          { id: 'task-2', title: 'Broad Surface Scan on api.example.com', status: 'pending' },
        ],
        flags: { workerSpawningAvailable: true },
      } as any,
      agentType: 'executor',
      softContext: '',
      tools: [],
    });

    expect(result.dynamicPrompt).not.toContain('DELEGATION ACTIVATION');
    expect(result.dynamicPrompt).not.toContain('high-confidence delegation patterns');
    expect(result.dynamicPrompt).not.toContain('spawn_worker(workerType="recon_worker"');
  });
});
