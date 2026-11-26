import { ShellRun } from '../../../src/domains/agent-brain/adapters/tools/builtins/shell';
import { ReportFinding } from '../../../src/domains/agent-brain/adapters/tools/builtins/securityops';
import { SubmitPhaseHandoff } from '../../../src/domains/agent-brain/adapters/tools/builtins/phase';
import {
  SpawnWorker,
  StopWorker,
  SubmitWorkerResult,
  WaitForWorker,
} from '../../../src/domains/agent-brain/adapters/tools/builtins/workers';
import { FileRead } from '../../../src/domains/agent-brain/adapters/tools/builtins/file';
import {
  evaluateDelegationActivation,
  renderDelegationActivationGuidance,
} from '../../../src/domains/agent-brain/domain/workers/delegationActivation';
import {
  asArray,
  firstTool,
  requireNoToolNames,
  requireSingleTool,
} from '../assertions';
import type { BehaviorScenario } from '../types';

const parentDelegationSession = {
  agentType: 'executor',
  extraContext: '=== ASSIGNED METHODOLOGIES ===\n- broad-surface-scan: /workspace/.skills/broad-surface-scan/methodology.md\n',
  plan: [
    { id: 'task-1', title: 'Broad Surface Scan on app.example.com', status: 'pending' },
    { id: 'task-2', title: 'Broad Surface Scan on api.example.com', status: 'pending' },
  ],
  workerTasks: [],
  coordination: undefined,
  executionMode: 'discovery',
} as const;

const parentDelegationHint = evaluateDelegationActivation({
  session: parentDelegationSession as any,
  maxConcurrency: 1,
});

const parentDelegationGuidance = renderDelegationActivationGuidance(parentDelegationHint);

export const delegationScenarios: BehaviorScenario[] = [
  {
    id: 'parent-executor-delegation-guidance',
    title: 'Parent executor uses delegation guidance when parallel work is obvious',
    why: 'Catches the V2.1 keystone wiring issue where parent executors did not receive usable delegation activation.',
    tools: [SpawnWorker, ShellRun, ReportFinding],
    preflight: () => {
      const errors: string[] = [];
      if (!parentDelegationHint.shouldPrompt) {
        errors.push('parent executor delegation fixture did not produce a delegation hint');
      }
      if (!parentDelegationGuidance.includes('spawn_worker')) {
        errors.push('parent executor delegation fixture did not render spawn_worker guidance');
      }
      return errors;
    },
    prompt: [
      'You are a parent phase executor session. The spawn_worker tool is available because this phase allows worker spawning.',
      'Dynamic prompt section: delegation_activation_guidance',
      parentDelegationGuidance,
      'Plan:',
      'task-1 pending: Broad Surface Scan on app.example.com',
      'task-2 pending: Broad Surface Scan on api.example.com, not ready until the next turn',
      'Take exactly one next harness action for task-1. Do not spawn task-2 in this smoke test. Do not run a shell command yourself.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'spawn_worker') {
        errors.push(`expected spawn_worker, observed ${call.name}`);
      }
      if (call.args.workerType !== 'recon_worker') {
        errors.push(`expected workerType recon_worker, observed ${String(call.args.workerType ?? '<missing>')}`);
      }
      if (call.args.executionMode && call.args.executionMode !== 'background') {
        errors.push(`expected background execution when executionMode is provided, observed ${String(call.args.executionMode)}`);
      }
      if (call.args.dependencyMode && call.args.dependencyMode !== 'sidecar') {
        errors.push(`expected sidecar dependencyMode when dependencyMode is provided, observed ${String(call.args.dependencyMode)}`);
      }
      return errors;
    },
  },
  {
    id: 'parent-executor-no-worker-tools-direct-work',
    title: 'Parent executor works directly when worker tools are absent',
    why: 'Confirms a phase without spawn_worker still makes progress directly instead of asking for delegation.',
    tools: [ShellRun, ReportFinding],
    prompt: [
      'You are a parent phase executor session.',
      'The current phase tool list does not include spawn_worker, wait_for_worker, continue_worker, or stop_worker.',
      'Plan:',
      'task-1 in_progress: Capture a bounded HTTP header check for app.example.com.',
      'Take exactly one next harness action. Use shell_run for the bounded check. Do not mention unavailable worker tools.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      errors.push(...requireNoToolNames(call, ['spawn_worker', 'wait_for_worker', 'continue_worker', 'stop_worker']));
      if (call.name !== 'shell_run') {
        errors.push(`expected shell_run, observed ${call.name}`);
      }
      return errors;
    },
  },
  {
    id: 'delegation-negative-sequential-local',
    title: 'Executor avoids delegation when the next step is sequential and blocking',
    why: 'Prevents over-delegation: the parent should run the immediate blocking probe locally instead of spawning a worker.',
    tools: [SpawnWorker, ShellRun],
    prompt: [
      'You are an executor session. The spawn_worker tool is available.',
      'Dynamic prompt section: delegation_activation_guidance',
      '- Delegation is not recommended for the immediate next step.',
      '- The next action is a single blocking probe whose result decides whether any worker task is useful.',
      'Plan:',
      'task-1 in_progress: Verify whether /api/orders requires authentication before deciding validation strategy.',
      'No independent sidecar work is ready yet.',
      'Take exactly one next harness action. Use a bounded shell command to perform the probe. Do not spawn a worker.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      errors.push(...requireNoToolNames(call, ['spawn_worker']));
      if (call && call.name !== 'shell_run') {
        errors.push(`expected shell_run, observed ${call.name}`);
      }
      return errors;
    },
  },
  {
    id: 'worker-handoff-complete',
    title: 'Worker submits a structured handoff when delegated work is done',
    why: 'Checks that workers return artifacts to the parent instead of continuing open-ended exploration.',
    tools: [SubmitWorkerResult, ShellRun, FileRead],
    prompt: [
      'You are a recon_worker child session.',
      'The delegated task is complete.',
      'You created these readable artifacts:',
      JSON.stringify([
        '/workspace/.artifacts/recon/httpx-app.jsonl',
        '/workspace/.artifacts/recon/nmap-app.xml',
      ], null, 2),
      'Summary: app.example.com resolves, ports 80 and 443 are open, HTTPS redirects to /login, server header is nginx.',
      'No candidate vulnerability is confirmed. The parent needs artifact paths and a concise next action.',
      'Take exactly one next harness action. Do not run another command.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'submit_worker_result') {
        errors.push(`expected submit_worker_result, observed ${call.name}`);
      }
      const evidenceRefs = asArray(call.args.evidenceRefs);
      if (evidenceRefs.length < 2) {
        errors.push('expected worker handoff to include both artifact paths');
      }
      if (asArray(call.args.touchedTargets).length === 0) {
        errors.push('expected worker handoff to include touchedTargets');
      }
      return errors;
    },
  },
  {
    id: 'worker-result-already-submitted-stops',
    title: 'Worker does not resubmit after result is already recorded',
    why: 'Catches runaway worker loops where the corrective prompt caused repeated submit_worker_result calls after completion.',
    tools: [SubmitWorkerResult, ShellRun, FileRead],
    prompt: [
      'You are a recon_worker child session.',
      'The harness state says your workerResult was already submitted and recorded for task-1.',
      'Recorded artifact summary: app.example.com resolves, HTTPS redirects to /login, no confirmed candidate vulnerability.',
      'The parent already has the artifact paths.',
      'Do not call submit_worker_result again. Do not run another command. If no tool is needed, finish with a short final message and no tool call.',
    ].join('\n\n'),
    expect: (calls) => {
      if (calls.length === 0) {
        return [];
      }
      return [`expected no tool calls after an already-submitted worker result, observed ${calls.map((call) => call.name).join(', ')}`];
    },
  },
  {
    id: 'parent-synthesizes-existing-worker-artifact',
    title: 'Parent reads shared worker evidence instead of spawning another worker',
    why: 'Checks that parent executors synthesize completed worker output before creating duplicate work.',
    tools: [FileRead, SpawnWorker, ShellRun],
    prompt: [
      'You are a parent phase executor session. spawn_worker is available.',
      'Worker task task-1 is completed.',
      'Parent-readable evidence refs: /workspace/.artifacts/scans/task-1/httpx-app.jsonl, /workspace/.artifacts/scans/task-1/nmap-app.xml',
      'The next decision depends on that worker result. Take exactly one next harness action.',
      'Read one of the shared evidence files before doing new work. Do not spawn another worker.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      errors.push(...requireNoToolNames(call, ['spawn_worker']));
      if (call.name !== 'file_read') {
        errors.push(`expected file_read, observed ${call.name}`);
      }
      if (!String(call.args.path ?? call.args.filePath ?? '').includes('.artifacts/scans/task-1/')) {
        errors.push('expected file_read to target a shared worker evidence artifact');
      }
      return errors;
    },
  },
  {
    id: 'parent-syncs-stale-worker-before-phase-close',
    title: 'Parent syncs a stale live-looking worker before phase closeout',
    why: 'Cheap canary for the production stale-worker projection bug: the parent should wait/sync a live-looking worker with submitted terminal evidence, not stop it or close the phase.',
    tools: [WaitForWorker, StopWorker, SubmitPhaseHandoff, SpawnWorker, FileRead],
    prompt: [
      'You are a parent enumeration-phase executor preparing to close the phase.',
      'Current parent WORKER TASKS projection says:',
      JSON.stringify([
        {
          taskId: 'task-stale-worker-1',
          workerType: 'recon_worker',
          status: 'running',
          workerSessionId: 'worker-session-1',
          executionMode: 'background',
          dependencyMode: 'sidecar',
        },
      ], null, 2),
      'But lifecycle evidence says the child worker session already called submit_worker_result successfully:',
      JSON.stringify({
        workerSessionId: 'worker-session-1',
        workerResult: {
          taskId: 'task-stale-worker-1',
          summary: 'Mapped authenticated API routes and produced validation leads.',
          evidenceRefs: ['/workspace/.artifacts/scans/task-stale-worker-1/routes.jsonl'],
        },
      }, null, 2),
      'The parent projection may be stale. Before submit_phase_handoff, synchronize/fetch the worker result. Do not stop the worker because that could downgrade a submitted result. Do not submit the phase handoff yet.',
      'Take exactly one next harness action.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      errors.push(...requireNoToolNames(call, ['stop_worker', 'submit_phase_handoff', 'spawn_worker']));
      if (call.name !== 'wait_for_worker') {
        errors.push(`expected wait_for_worker to sync the stale worker, observed ${call.name}`);
      }
      if (call.args.taskId !== 'task-stale-worker-1') {
        errors.push(`expected wait_for_worker taskId task-stale-worker-1, observed ${String(call.args.taskId ?? '<missing>')}`);
      }
      return errors;
    },
  },
  {
    id: 'parent-continues-after-worker-token-limit-partial-result',
    title: 'Parent continues from a worker token-limit partial result',
    why: 'Checks that a worker token safety stop is treated as a partial artifact for synthesis, not as a reason to loop or spawn duplicate work.',
    tools: [FileRead, SpawnWorker, ShellRun],
    prompt: [
      'You are a parent phase executor session. spawn_worker is available.',
      'Worker task task-token is completed by the runtime with workerTokenLimitPartialResult=true.',
      'The worker reached the universal session token safety limit, but the runtime synthesized a partial result artifact.',
      'Parent-readable evidence refs: /workspace/.artifacts/scans/task-token/partial-httpx.jsonl',
      'The next decision depends on what the partial worker already found.',
      'Take exactly one next harness action. Read the shared evidence file before doing new work. Do not spawn another worker. Do not continue the old worker.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      errors.push(...requireNoToolNames(call, ['spawn_worker', 'continue_worker']));
      if (call.name !== 'file_read') {
        errors.push(`expected file_read, observed ${call.name}`);
      }
      if (!String(call.args.path ?? call.args.filePath ?? '').includes('.artifacts/scans/task-token/')) {
        errors.push('expected file_read to target the token-limit worker evidence artifact');
      }
      return errors;
    },
  },
  {
    id: 'parent-assigns-phase-compatible-worker-skill',
    title: 'Parent assigns a phase-compatible skill not originally assigned by the planner',
    why: 'Checks the V2.1.5 skill-routing change: parent can route compact catalog skills to workers without seeing all methodologies.',
    tools: [SpawnWorker, ShellRun],
    prompt: [
      'You are a parent validation-phase executor. spawn_worker is available.',
      'Planner-assigned skills with methodology paths: validation.',
      'Compact phase-compatible worker skill catalog:',
      '- idor: IDOR/BOLA testing for object references. Compatible phase: validation. Required tools: http_payload, http_differential, file_read.',
      'Active objective: validate a suspected IDOR on GET /api/orders/{orderId}.',
      'Take exactly one next harness action. Spawn a validator worker and assign the idor skill. Do not run a local shell command.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'spawn_worker') {
        errors.push(`expected spawn_worker, observed ${call.name}`);
      }
      if (call.args.workerType !== 'validator_worker') {
        errors.push(`expected validator_worker, observed ${String(call.args.workerType ?? '<missing>')}`);
      }
      const mission = call.args.mission as Record<string, unknown> | undefined;
      const assignedSkills = [
        ...asArray(mission?.assignedSkills),
        ...asArray(mission?.assigned_skills),
      ];
      if (!assignedSkills.includes('idor')) {
        errors.push('expected mission assigned skills to include idor');
      }
      return errors;
    },
  },
];
