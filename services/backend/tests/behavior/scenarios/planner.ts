import { SubmitPlan } from '../../../src/domains/agent-brain/adapters/tools/builtins/submit_plan';
import { ListRelevantSkills } from '../../../src/domains/agent-brain/adapters/tools/builtins/skills';
import { PLANNER_KICKOFF_PROMPT } from '../../../src/domains/security-ops/runs/StartRunPromptHelpers';
import {
  asArray,
  asString,
  firstTool,
  requireSingleTool,
} from '../assertions';
import type { BehaviorScenario } from '../types';

const missionPhase = (mission: unknown): string =>
  mission && typeof mission === 'object' && !Array.isArray(mission)
    ? asString((mission as Record<string, unknown>).phase)
    : '';

const missionSkills = (mission: unknown): unknown[] =>
  mission && typeof mission === 'object' && !Array.isArray(mission)
    ? [
        ...asArray((mission as Record<string, unknown>).assigned_skills),
        ...asArray((mission as Record<string, unknown>).assignedSkills),
      ]
    : [];

export const plannerScenarios: BehaviorScenario[] = [
  {
    id: 'planner-routes-one-mission-with-bounded-skill-context',
    title: 'Planner routes one mission without receiving the global skill catalog',
    why: 'BE21 model canary: the production planner prompt must lead the model to query the bounded router for the exact mission instead of guessing skills or requesting the global catalog.',
    tools: [ListRelevantSkills, SubmitPlan],
    prompt: [
      PLANNER_KICKOFF_PROMPT,
      'TARGET CONTEXT authorizes only https://app.example.com. The required inventory, finding, digest, approach, blocker, and coverage prechecks have already returned for this plan revision.',
      'The next proposed non-reporting mission is:',
      JSON.stringify({
        id: 'validate-account-boundary',
        phase: 'validation',
        question: 'Can one authenticated account read another account resource?',
        target: 'https://app.example.com/api/accounts/123',
        riskFamily: 'idor',
        technologies: ['rest'],
        ntypes: ['http.endpoint', 'http.parameters'],
      }, null, 2),
      'The skill router has not been called for this mission. Take exactly one next harness action. Do not submit the plan yet.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'list_relevant_skills') {
        errors.push(`expected list_relevant_skills, observed ${call.name}`);
        return errors;
      }
      if (asString(call.args.missionId) !== 'validate-account-boundary') {
        errors.push('expected exact missionId validate-account-boundary');
      }
      if (asString(call.args.phase) !== 'validation') {
        errors.push('expected exact phase validation');
      }
      return errors;
    },
  },
  {
    id: 'planner-resumed-open-phase-replan-applies-plan',
    title: 'Reopened planner applies an open phase replan instead of idling',
    why: 'Cheap canary for the production open-replan wedge: a reopened original planner session must consume the open replan by calling submit_plan.',
    tools: [SubmitPlan],
    prompt: [
      'You are the ORIGINAL planner session for a SecurityOps run. This is not a new session.',
      'Lifecycle state:',
      JSON.stringify({
        runStatus: 'running',
        plannerSessionId: 'planner-session-original',
        executorSessionId: null,
        resumeSource: 'phase_replan_resume_sweep',
        openReplan: {
          id: 'replan-1',
          phase: 'enumeration',
          phaseStatus: 'completed',
          reason: 'Enumeration discovered authenticated parameterized API routes not covered by the remaining reporting-only plan.',
          dispatchAttempts: 1,
        },
      }, null, 2),
      'The prior enumeration phase already handed off successfully. Do not repeat completed enumeration.',
      'The remaining approved graph currently skips validation and goes directly to reporting, which is wrong because open validation leads exist.',
      'Your task is to apply the open replan now by submitting a revised remaining mission graph. Do not ask for approval. Do not wait. Do not explain without a tool call.',
      'Keep the plan markdown under 80 words.',
      'Use exactly these two missions in missions[] and no others:',
      JSON.stringify([
        {
          id: 'validate-open-api-leads',
          phase: 'validation',
          question: 'Do the newly discovered parameterized API routes expose authorization or input-validation issues?',
          why_ready_now: 'Enumeration produced authenticated parameterized routes and open validation leads.',
          required_evidence: ['fresh request/response evidence', 'validation lead outcomes'],
          expected_artifact: 'validation outcomes for open API leads',
          stop_condition: 'Each open lead is validated, false-positive, blocked, or deferred with evidence.',
          assigned_skills: ['validation', 'idor'],
        },
        {
          id: 'report-revised-results',
          phase: 'reporting',
          question: 'What final or interim report should be delivered after validation?',
          why_ready_now: 'Reporting is the terminal phase after validation lead disposition.',
          required_evidence: ['report_finalizer_preflight', 'summary.md', 'report.md', 'finalize_run_artifacts'],
          expected_artifact: 'final or interim report artifacts',
          stop_condition: 'Report artifacts are finalized or explicit interim blockers are recorded.',
          assigned_skills: ['security-reporting'],
        },
      ], null, 2),
      'Take exactly one next harness action.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'submit_plan') {
        errors.push(`expected submit_plan, observed ${call.name}`);
      }
      const missions = asArray(call.args.missions);
      const phases = missions.map(missionPhase);
      if (!phases.includes('validation')) {
        errors.push('expected revised replan graph to include validation');
      }
      if (!phases.includes('reporting')) {
        errors.push('expected revised replan graph to include reporting');
      }
      const reportingMission = missions.find((mission) => missionPhase(mission) === 'reporting');
      if (!missionSkills(reportingMission).includes('security-reporting')) {
        errors.push('expected reporting mission assigned_skills to include security-reporting');
      }
      const serialized = JSON.stringify(call.args).toLowerCase();
      if (serialized.includes('approval') || serialized.includes('awaiting_approval')) {
        errors.push('phase replan application must not request another approval gate');
      }
      return errors;
    },
  },
  {
    id: 'planner-active-replan-submits-once',
    title: 'Planner submits a revised plan only for an active replan request',
    why: 'Catches planner submit regressions without a full run: active replans need one valid submit_plan with canonical phases and reporting closeout.',
    tools: [SubmitPlan],
    prompt: [
      'You are the planner session for a SecurityOps run.',
      'Run status: running.',
      'A phase handoff requested a replan because enumeration found new parameterized API routes. No revised plan has been applied yet.',
      'The current task is to submit exactly one revised mission graph. Use canonical phases only: enumeration, validation, reporting.',
      'Required missions:',
      JSON.stringify([
        {
          id: 'enumerate-api-routes',
          phase: 'enumeration',
          question: 'Which newly discovered API routes and parameters need validation?',
          why_ready_now: 'Enumeration produced a route catalog that changes validation coverage.',
          required_evidence: ['route inventory', 'parameter list'],
          expected_artifact: 'bounded API route inventory',
          stop_condition: 'top validation candidates are identified and recorded',
          assigned_skills: ['api-enumeration'],
        },
        {
          id: 'validate-top-api-candidates',
          phase: 'validation',
          question: 'Do the highest-signal parameterized API routes cross authorization boundaries?',
          why_ready_now: 'Open validation leads exist for route parameters.',
          required_evidence: ['fresh validator evidence', 'submit_validation_outcome or lead closeout'],
          expected_artifact: 'validation outcomes for top candidates',
          stop_condition: 'top candidates are validated, false-positive, or explicitly blocked',
          assigned_skills: ['validation', 'idor'],
        },
        {
          id: 'report-security-results',
          phase: 'reporting',
          question: 'What operator-ready report should be delivered?',
          why_ready_now: 'Execution phases must close with final or interim reporting.',
          required_evidence: ['report_finalizer_preflight', 'summary.md', 'report.md', 'finalize_run_artifacts'],
          expected_artifact: 'final or interim report artifacts',
          stop_condition: 'report artifacts are finalized',
          assigned_skills: ['security-reporting'],
        },
      ], null, 2),
      'Take exactly one next harness action.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'submit_plan') {
        errors.push(`expected submit_plan, observed ${call.name}`);
      }
      const missions = asArray(call.args.missions);
      if (missions.length < 3) {
        errors.push(`expected at least 3 missions, observed ${missions.length}`);
      }
      const phases = missions.map(missionPhase);
      for (const required of ['enumeration', 'validation', 'reporting']) {
        if (!phases.includes(required)) {
          errors.push(`expected revised plan to include ${required} phase`);
        }
      }
      const reportingMission = missions.find((mission) => missionPhase(mission) === 'reporting');
      if (!missionSkills(reportingMission).includes('security-reporting')) {
        errors.push('expected reporting mission assigned_skills to include security-reporting');
      }
      const serialized = JSON.stringify(call.args).toLowerCase();
      if (serialized.includes('coordinator')) {
        errors.push('revised plan should not reintroduce coordinator terminology');
      }
      return errors;
    },
  },
  {
    id: 'planner-terminal-run-does-not-submit-plan',
    title: 'Planner does not submit a replan after terminal cancellation',
    why: 'Catches the run-revival class where stale planner callbacks moved cancelled runs back to running.',
    tools: [SubmitPlan],
    prompt: [
      'You are the planner session for a SecurityOps run.',
      'Run status: cancelled. The operator cancelled the run after the replan request was created.',
      'Terminal-state rule: cancelled/completed/failed/credits_exhausted runs must not receive submit_plan and must not be moved back to running.',
      'Take exactly the correct next assistant behavior. Do not call any tool.',
    ].join('\n\n'),
    expect: (calls) => {
      if (calls.length === 0) {
        return [];
      }
      return [`expected no tool calls for a cancelled run, observed ${calls.map((call) => call.name).join(', ')}`];
    },
  },
];
