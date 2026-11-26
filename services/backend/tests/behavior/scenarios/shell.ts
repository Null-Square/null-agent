import { FileRead } from '../../../src/domains/agent-brain/adapters/tools/builtins/file';
import { SubmitPhaseHandoff } from '../../../src/domains/agent-brain/adapters/tools/builtins/phase';
import { ShellRun, WaitForShellJob } from '../../../src/domains/agent-brain/adapters/tools/builtins/shell';
import {
  asString,
  firstTool,
  isUuid,
  normalizedPath,
  requireNoToolNames,
  requireSingleTool,
} from '../assertions';
import type { BehaviorScenario } from '../types';

const ACTIVE_RECON_PHASE_ID = '33333333-3333-4333-8333-333333333333';
const CANONICAL_NEXT_PHASES = new Set(['recon', 'enumeration', 'validation', 'evidence', 'reporting']);

export const shellScenarios: BehaviorScenario[] = [
  {
    id: 'unknown-shell-job-recovery',
    title: 'Unknown shell job response steers model to a known job id',
    why: 'Catches the V2.1 dead wait pattern where the model repeated an unknown shell job id.',
    tools: [WaitForShellJob, ShellRun],
    prompt: [
      'You are an executor recovering from a shell job status mistake.',
      'The last tool result was:',
      JSON.stringify({
        success: false,
        failureKind: 'unknown_job_id',
        status: 'unknown',
        outcome: 'failed',
        requestedJobId: 'shelljob-wrong',
        knownJobIds: ['shelljob-known-1'],
        nextAction: 'record_blocked',
        error: 'Unknown managed shell job id. Use a known job id or record the blocker.',
      }, null, 2),
      'You still need one bounded check of the running scan before deciding whether to block.',
      'Take exactly one next harness action using a known job id. Do not use shelljob-wrong.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (!['wait_for_shell_job', 'shell_run'].includes(call.name)) {
        errors.push(`expected wait_for_shell_job or shell_run, observed ${call.name}`);
      }
      const jobId = asString(call.args.jobId);
      if (jobId !== 'shelljob-known-1') {
        errors.push(`expected jobId shelljob-known-1, observed ${jobId || '<missing>'}`);
      }
      if (jobId === 'shelljob-wrong') {
        errors.push('model reused the unknown job id');
      }
      return errors;
    },
  },
  {
    id: 'unknown-shell-job-no-known-ids-block',
    title: 'Unknown shell job with no recoverable ids produces blocked handoff',
    why: 'Checks that an unrecoverable shell-job state becomes a visible phase blocker instead of an endless wait loop.',
    tools: [WaitForShellJob, ShellRun, SubmitPhaseHandoff],
    prompt: [
      'You are the recon phase executor.',
      `The active phase id is ${ACTIVE_RECON_PHASE_ID}. If you include phaseId, it must exactly equal this UUID.`,
      'If you include recommendedNextPhase, it must be one of: recon, enumeration, validation, evidence, reporting. Do not invent recon_retry.',
      'The phase budget is exhausted, so starting a new scan is not allowed.',
      'The last tool result was:',
      JSON.stringify({
        success: false,
        failureKind: 'unknown_job_id',
        status: 'unknown',
        outcome: 'failed',
        requestedJobId: 'shelljob-lost',
        knownJobIds: [],
        nextAction: 'record_blocked',
        error: 'Unknown managed shell job id and no known ids are available.',
      }, null, 2),
      'Take exactly one next harness action. Do not wait on shelljob-lost and do not start a replacement command.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      errors.push(...requireNoToolNames(call, ['wait_for_shell_job', 'shell_run']));
      if (!call) return errors;
      if (call.name !== 'submit_phase_handoff') {
        errors.push(`expected submit_phase_handoff, observed ${call.name}`);
      }
      if (call.args.status !== 'blocked') {
        errors.push(`expected blocked status, observed ${String(call.args.status ?? '<missing>')}`);
      }
      if (call.args.phaseId !== undefined && call.args.phaseId !== ACTIVE_RECON_PHASE_ID) {
        errors.push(`expected phaseId ${ACTIVE_RECON_PHASE_ID} or omitted phaseId, observed ${String(call.args.phaseId)}`);
      }
      if (call.args.phaseId !== undefined && !isUuid(call.args.phaseId)) {
        errors.push(`expected phaseId to be a UUID when present, observed ${String(call.args.phaseId)}`);
      }
      const recommendedNextPhase = asString(call.args.recommendedNextPhase);
      if (recommendedNextPhase && !CANONICAL_NEXT_PHASES.has(recommendedNextPhase)) {
        errors.push(`expected canonical recommendedNextPhase, observed ${recommendedNextPhase}`);
      }
      return errors;
    },
  },
  {
    id: 'completed-shell-job-read-output',
    title: 'Completed shell job result steers model to inspect stdout artifact',
    why: 'Checks that preserved shell job compaction fields are enough for the model to continue productively.',
    tools: [FileRead, WaitForShellJob, ShellRun],
    prompt: [
      'You are the recon phase executor.',
      'The last shell_run result was compacted but preserved as:',
      JSON.stringify({
        jobId: 'shelljob-nmap-1',
        status: 'completed',
        outcome: 'succeeded',
        nextAction: 'read_stdout_path',
        stdoutPath: '.artifacts/shell/shelljob-nmap-1.stdout.txt',
        stderrPath: '.artifacts/shell/shelljob-nmap-1.stderr.txt',
        command: 'nmap -sV -oX .artifacts/nmap.xml app.example.com',
      }, null, 2),
      'Take exactly one next harness action. Read the preserved stdout artifact before deciding whether to run anything else.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'file_read') {
        errors.push(`expected file_read, observed ${call.name}`);
      }
      const targetPath = normalizedPath(call.args.path);
      if (targetPath !== '.artifacts/shell/shelljob-nmap-1.stdout.txt') {
        errors.push(`expected stdout artifact path, observed ${targetPath || '<missing>'}`);
      }
      return errors;
    },
  },
  {
    id: 'persisted-tool-result-read-artifact',
    title: 'Persisted tool result envelope steers model to inspect artifact path',
    why: 'Checks that the compact artifact-reference shape remains behaviorally usable after tool-result cost control.',
    tools: [FileRead, ShellRun],
    prompt: [
      'You are the recon phase executor.',
      'The last shell_run result was persisted by the tool-result policy:',
      JSON.stringify({
        status: 'tool_result_persisted',
        tool: 'shell_run',
        ok: true,
        data: {
          success: true,
          stdout: '[output truncated by tool result policy; showing last 3000 chars]',
          stdoutPath: '/workspace/.artifacts/shell/stdout.log',
        },
        artifact: {
          path: '/workspace/.artifacts/tool-results/tc-shell-abc123.json',
          bytes: 48291,
          sha256: 'a'.repeat(64),
          contentType: 'application/json',
        },
        policy: {
          reason: 'tool_result_policy',
          savedApproxTokens: 9312,
        },
      }, null, 2),
      'Take exactly one next harness action. Read the full persisted artifact before deciding whether to run another command.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'file_read') {
        errors.push(`expected file_read, observed ${call.name}`);
      }
      const targetPath = normalizedPath(call.args.path);
      if (targetPath !== '.artifacts/tool-results/tc-shell-abc123.json') {
        errors.push(`expected persisted tool result artifact path, observed ${targetPath || '<missing>'}`);
      }
      return errors;
    },
  },
];
