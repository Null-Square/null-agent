import { describe, it, expect } from 'vitest';
import { SystemPromptBuilder } from '@/domains/agent-brain/domain/prompts';
import { createAttemptKey, createEmptyMemory, type AgentMemory } from '@/domains/agent-brain/domain/types/memory';
import type { SessionState } from '@/domains/agent-brain/domain/types';

const makeSession = (overrides: Partial<SessionState> = {}): SessionState =>
  ({
    id: 'session-1',
    messages: [],
    plan: [],
    memory: createEmptyMemory(),
    flags: {},
    workspaceDir: '/workspace',
    status: 'idle',
    createdAt: Date.now(),
    lastActive: Date.now(),
    turn: 0,
    checkpoints: {},
    ...overrides,
  }) as SessionState;

describe('SystemPromptBuilder compact memory integration', () => {
  it('renders compact fallback for empty memory', () => {
    const session = makeSession({ memory: createEmptyMemory() });
    const prompt = SystemPromptBuilder.buildDynamic(session);

    expect(prompt).toContain('## SESSION MEMORY (MUTABLE)');
    expect(prompt).toContain('stats: none');
  });

  it('renders compact stats and bounded avoid-retries guidance', () => {
    const session = makeSession({
      memory: {
        discoveredFacts: [
          {
            category: 'endpoint',
            key: '/health',
            value: { status: 'ok' },
            confidence: 0.8,
            source: 'tool-3',
            discoveredAt: Date.now(),
          },
          {
            category: 'credential',
            key: 'token',
            value: 'ignored',
            confidence: 0.4,
            source: 'tool-4',
            discoveredAt: Date.now(),
          },
        ],
        attemptedTechniques: {
          '/health:curl': {
            count: 1,
            lastAttemptTurn: 1,
            result: 'success',
            lastAttemptAt: Date.now(),
          },
          '/api/users:sqli': {
            count: 2,
            lastAttemptTurn: 2,
            result: 'failed',
            lastAttemptAt: Date.now(),
          },
        },
        failedApproaches: [
          {
            endpoint: '/api/users',
            technique: 'sqli',
            reason: 'blocked',
            toolCallId: 'tc-1',
            failedAt: Date.now(),
          },
        ],
        testedEndpoints: ['/health', '/api/users'],
      },
    });

    const prompt = SystemPromptBuilder.buildDynamic(session);

    expect(prompt).toContain('## SESSION MEMORY (MUTABLE)');
    expect(prompt).toContain('stats: facts=1, attempts=2, failures=1, endpoints=2');
    expect(prompt).toContain('avoid_retries:');
    expect(prompt).toContain('- failed sqli @ /api/users x2 reason=blocked');
    expect(prompt).not.toContain('### KNOWN FACTS');
  });

  it('renders structured attempt keys with full URL endpoints', () => {
    const session = makeSession({
      memory: {
        discoveredFacts: [],
        attemptedTechniques: {
          [createAttemptKey('https://api.example.com/login', 'broken-auth')]: {
            count: 2,
            lastAttemptTurn: 1,
            result: 'failed',
            lastAttemptAt: Date.now(),
          },
        },
        failedApproaches: [
          {
            endpoint: 'https://api.example.com/login',
            technique: 'broken-auth',
            reason: '401 on all probes',
            toolCallId: 'tc-2',
            failedAt: Date.now(),
          },
        ],
        testedEndpoints: ['https://api.example.com/login'],
      },
    });

    const prompt = SystemPromptBuilder.buildDynamic(session);

    expect(prompt).toContain('- failed broken-auth @ https://api.example.com/login x2');
    expect(prompt).toContain('- failed broken-auth @ https://api.example.com/login x1 reason=401 on all probes');
  });

  it('renders RunCompletion for SecurityOps executor runs', () => {
    const session = makeSession({
      agentType: 'executor',
      mode: 'automated',
      flags: {
        securityops: {
          runId: 'run-1',
          candidateFindingCount: 1,
          reportableFindingCount: 2,
        },
      },
      plan: [
        { id: 'task-1', title: 'Validate finding', status: 'completed' },
        { id: 'task-2', title: 'Check IDOR', status: 'blocked', blockedReason: 'missing credentials' },
      ],
    });

    const prompt = SystemPromptBuilder.buildDynamic(session);

    expect(prompt).toContain('## RUN COMPLETION');
    expect(prompt).toContain('RunCompletion.state = not_ready');
    expect(prompt).toContain('reportable_findings = 2');
    expect(prompt).toContain('candidate_findings = 1');
    expect(prompt).toContain('1 plan step(s) are not completed');
    expect(prompt).toContain('finalize_run_artifacts');
  });
});
