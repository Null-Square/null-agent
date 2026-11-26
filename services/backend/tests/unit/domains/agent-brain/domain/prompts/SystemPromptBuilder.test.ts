import { describe, expect, it } from 'vitest';

import { SystemPromptBuilder } from '@/domains/agent-brain/domain/prompts/SystemPromptBuilder';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

describe('SystemPromptBuilder exposure verification contract', () => {
  it('does not reintroduce submit_plan through mandatory planner output', () => {
    const prompt = SystemPromptBuilder.buildDynamic({
      id: 'session-exposure',
      agentType: 'planner',
      mode: 'automated',
      messages: [],
      plan: [],
      memory: createEmptyMemory(),
      flags: {
        securityops: {
          runId: 'run-exposure',
          runTrigger: 'exposure_verification',
          activePhaseKey: 'planning',
        },
      },
      workspaceDir: '/workspace',
      createdAt: Date.now(),
      lastActive: Date.now(),
      turn: 1,
      checkpoints: {},
    } as never);

    expect(prompt).toContain('submit_exposure_verification');
    expect(prompt).toContain('Do not call submit_plan');
    expect(prompt).not.toContain('call submit_plan with');
  });
});

describe('SystemPromptBuilder BE21 recipient alignment', () => {
  const makeSession = (phase: string, agentType: 'planner' | 'executor' = 'executor') => {
    const memory = createEmptyMemory();
    memory.discoveredFacts.push({
      category: 'endpoint',
      key: 'account-api',
      value: '/api/accounts/123',
      confidence: 0.9,
      source: 'tool-1',
      discoveredAt: Date.now(),
    });
    return {
      id: `session-${phase}`,
      agentType,
      mode: 'automated',
      messages: [],
      plan: [{ id: 'mission-1', description: 'Validate the account boundary', status: 'pending' }],
      memory,
      flags: {
        workspaceProjectionModelRecitation: [
          '# Current Surface',
          '- /api/accounts/123',
          '## Next Actions',
          '- Test everything again',
        ].join('\n'),
        securityops: {
          runId: 'run-1',
          workflowDiscipline: 'pentest',
          activePhaseKey: phase,
        },
      },
      workspaceDir: '/workspace',
      createdAt: Date.now(),
      lastActive: Date.now(),
      turn: 1,
      checkpoints: {},
    } as never;
  };

  it('recites the factual model only to a Pentest phase executor and strips generic next actions', () => {
    const prompt = SystemPromptBuilder.buildDynamic(makeSession('validation'));

    expect(prompt).toContain('WORKSPACE ENGAGEMENT MODEL');
    expect(prompt).toContain('/api/accounts/123');
    expect(prompt).not.toContain('Next Actions');
    expect(prompt).not.toContain('APPROVED PLAN (PLANNER-OWNED)');
  });

  it('keeps the active mission body in TARGET CONTEXT only', () => {
    const session = makeSession('validation') as any;
    session.extraContext = [
      '=== VALIDATION MISSIONS ===',
      '- mission-1: Can the account boundary be bypassed?',
      '  expected_artifact: durable authorization evidence',
      '  stop_condition: confirmed, refuted, or blocked',
    ].join('\n');
    session.plan = [{
      id: 'mission-1',
      title: 'Can the account boundary be bypassed?',
      status: 'pending',
      mission: {
        question: 'Can the account boundary be bypassed?',
        expectedArtifact: 'durable authorization evidence',
        stopCondition: 'confirmed, refuted, or blocked',
        assignedSkills: ['idor'],
      },
    }];

    const prompt = SystemPromptBuilder.buildDynamic(session);

    expect(prompt.match(/Can the account boundary be bypassed\?/g)).toHaveLength(1);
    expect(prompt).toContain('Start with mission-1. Its complete mission contract is in TARGET CONTEXT');
    expect(prompt).not.toContain('Current mission question:');
    expect(prompt).not.toContain('Current mission methodology path:');
  });

  it.each(['reporting', 'review_reporting'])('keeps %s free of execution model, plan, and mutable memory', (phase) => {
    const prompt = SystemPromptBuilder.buildDynamic(makeSession(phase));

    expect(prompt).not.toContain('WORKSPACE ENGAGEMENT MODEL');
    expect(prompt).not.toContain('APPROVED PLAN (PLANNER-OWNED)');
    expect(prompt).not.toContain('SESSION MEMORY (MUTABLE)');
    expect(prompt).not.toContain('PLAN HINT');
    expect(prompt).not.toContain('/api/accounts/123');
  });

  it('does not send the execution model to the planner', () => {
    const prompt = SystemPromptBuilder.buildDynamic(makeSession('planning', 'planner'));

    expect(prompt).not.toContain('WORKSPACE ENGAGEMENT MODEL');
  });

  it('makes unversioned components bounded enumeration objectives', () => {
    const prompt = SystemPromptBuilder.buildDynamic(makeSession('enumeration'));

    expect(prompt).toContain('every versionAcquisition item is a bounded attack-surface objective');
    expect(prompt).toContain('Try only its recommendedMethod');
    expect(prompt).toContain('stop when status is exhausted');
    expect(prompt).toContain('Never infer a version');
  });

  it.each([
    { runTrigger: 'exposure_verification' },
    { findingDispositionVerificationId: 'verification-1' },
  ])('keeps whole-scope live state out of focused verification recipients', (focusedFlags) => {
    const session = makeSession('validation') as any;
    session.flags.securityops = {
      ...session.flags.securityops,
      ...focusedFlags,
    };

    const prompt = SystemPromptBuilder.buildDynamic(session);

    expect(prompt).not.toContain('WORKSPACE ENGAGEMENT MODEL');
  });
});
