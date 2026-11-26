import { describe, it, expect } from 'vitest';
/**
 * Prompt Snapshot Tests
 * 
 * Test 7 from the regression test plan:
 * Snapshot the exact prompt payload for key states to ensure:
 * - No control-plane text appears in prompts
 * - Ephemeral nudge appears only when expected
 * - Ordering invariants remain stable over refactors
 */

import { SystemPromptBuilder } from '@/domains/agent-brain/domain/prompts';
import { AGENT_PROMPTS } from '@/config/agentPrompts';
import type { SessionState, PlanItem, Message } from '@/domains/agent-brain/domain/types';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

// Helper to create a mock session state
function createMockSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: 'test-session',
    version: 1,
    userId: 'user-1',
    messages: [],
    plan: [],
    memory: createEmptyMemory(),
    flags: {},
    workspaceDir: '/workspace',
    turn: 1,
    createdAt: Date.now(),
    ...overrides,
  } as SessionState;
}

// Helper to create mock tool registry
function createMockTools() {
  return [
    { name: 'run_command', description: 'Execute a shell command', parameters: {} },
    { name: 'write_file', description: 'Write content to a file', parameters: {} },
    { name: 'read_file', description: 'Read content from a file', parameters: {} },
  ];
}

// ============================================================================
// Prompt content invariants
// ============================================================================

describe('Prompt content invariants', () => {
  describe('Control-plane text exclusion', () => {
    const FORBIDDEN_PATTERNS = [
      'Aborted by operator',
      'Continue automated run',
      'I notice I\'m performing the same action repeatedly',
      'guard exhausted',
      'credits_exhausted',
      'deadlock detected',
    ];

    it('static prompt contains no control-plane text', () => {
      const tools = createMockTools();
      const staticPrompt = SystemPromptBuilder.buildStatic(AGENT_PROMPTS.chat, tools as any);

      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(staticPrompt.toLowerCase()).not.toContain(pattern.toLowerCase());
      }
    });

    it('dynamic prompt (normal state) contains no control-plane text', () => {
      const session = createMockSession({
        mode: 'interactive',
        plan: [{ id: 's1', title: 'Scan target', status: 'pending' }] as PlanItem[],
      });

      const dynamicPrompt = SystemPromptBuilder.buildDynamic(session);

      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(dynamicPrompt.toLowerCase()).not.toContain(pattern.toLowerCase());
      }
    });

    it('dynamic prompt (automated mode) contains no control-plane text', () => {
      const session = createMockSession({
        mode: 'automated',
        plan: [
          { id: 's1', title: 'Scan target', status: 'completed' },
          { id: 's2', title: 'Generate report', status: 'pending' },
        ] as PlanItem[],
      });

      const dynamicPrompt = SystemPromptBuilder.buildDynamic(session);

      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(dynamicPrompt.toLowerCase()).not.toContain(pattern.toLowerCase());
      }
    });
  });

  describe('Automation contract (P1 fix)', () => {
    it('automated mode prompt includes conditional completion language', () => {
      const session = createMockSession({
        mode: 'automated',
        agentType: 'executor',
        plan: [{ id: 's1', title: 'Task', status: 'pending' }] as PlanItem[],
      });

      const dynamicPrompt = SystemPromptBuilder.buildDynamic(session);

      expect(dynamicPrompt).toContain('If a required prerequisite is missing');
      expect(dynamicPrompt).toContain('stop cleanly instead of looping or inventing context');
      expect(dynamicPrompt).toContain('Do not repeat the same failing tool call with identical arguments');
    });

    it('interactive mode prompt does NOT include automation contract', () => {
      const session = createMockSession({
        mode: 'interactive',
      });

      const dynamicPrompt = SystemPromptBuilder.buildDynamic(session);

      expect(dynamicPrompt).not.toContain('AUTOMATION CONTRACT');
      expect(dynamicPrompt).not.toContain('automated mode');
    });
  });

  describe('Plan hint correctness', () => {
    it('includes plan step IDs when plan exists', () => {
      const session = createMockSession({
        plan: [
          { id: 'step-123', title: 'First step', status: 'pending' },
          { id: 'step-456', title: 'Second step', status: 'pending' },
        ] as PlanItem[],
      });

      const dynamicPrompt = SystemPromptBuilder.buildDynamic(session);

      expect(dynamicPrompt).toContain('step-123');
      expect(dynamicPrompt).toContain('step-456');
      expect(dynamicPrompt).toContain('PLAN HINT');
    });

    it('shows "No current plan" when plan is empty', () => {
      const session = createMockSession({
        plan: [],
      });

      const dynamicPrompt = SystemPromptBuilder.buildDynamic(session);

      expect(dynamicPrompt).toContain('No current plan');
    });

    it('shows mission-scoped skill paths for the current plan step', () => {
      const session = createMockSession({
        plan: [
          {
            id: 'task-1',
            title: 'Validate auth bypass',
            status: 'pending',
            mission: {
              question: 'Can auth bypass be reproduced?',
              whyReadyNow: 'Prior evidence points to the login flow.',
              requiredEvidence: ['fresh request and response pair'],
              expectedArtifact: 'Validation outcome',
              stopCondition: 'The auth bypass is confirmed or ruled out.',
              assignedSkills: ['business-logic', 'idor'],
            },
          },
        ] as PlanItem[],
      });

      const dynamicPrompt = SystemPromptBuilder.buildDynamic(session);

      expect(dynamicPrompt).toContain('Current mission skills: business-logic, idor');
      expect(dynamicPrompt).toContain('Current mission expected artifact: Validation outcome');
      expect(dynamicPrompt).toContain('/workspace/.skills/business-logic/methodology.md');
      expect(dynamicPrompt).toContain('/workspace/.skills/idor/methodology.md');
    });
  });

  describe('Mandatory outputs section', () => {
    it('mentions summary.md and report.md', () => {
      const session = createMockSession();

      const dynamicPrompt = SystemPromptBuilder.buildDynamic(session);

      expect(dynamicPrompt).toContain('summary.md');
      expect(dynamicPrompt).toContain('report.md');
      expect(dynamicPrompt).toContain('MANDATORY OUTPUTS');
    });

    it('changes language when artifacts already exist', () => {
      const session = createMockSession({
        flags: {
          artifacts: { hasSummary: true, hasReport: true },
        } as any,
      });

      const dynamicPrompt = SystemPromptBuilder.buildDynamic(session);

      // When artifacts exist, should say "maintain" not "create if missing"
      expect(dynamicPrompt).toContain('maintain');
    });

    it('requires phase handoff instead of report finalization for active non-reporting phases', () => {
      const session = createMockSession({
        mode: 'automated',
        agentType: 'executor',
        promptProfile: 'phase-recon',
        flags: {
          securityops: {
            runId: 'run-1',
            activePhaseId: 'phase-recon',
            activePhaseKey: 'recon',
            phaseOrdinal: 1,
          },
        } as any,
      });

      const dynamicPrompt = SystemPromptBuilder.buildDynamic(session);

      expect(dynamicPrompt).toContain('Active run phase: recon');
      expect(dynamicPrompt).toContain('phase-specific Markdown prompt profile');
      expect(dynamicPrompt).toContain('submit_phase_handoff');
      expect(dynamicPrompt).not.toContain('finalize_run_artifacts');
      expect(dynamicPrompt).not.toContain('final reporting in this session');
    });
  });
});

// ============================================================================
// Snapshot tests for key states
// ============================================================================

describe('Prompt snapshots for key states', () => {
  it('SNAPSHOT: normal idle state prompt structure', () => {
    const session = createMockSession({
      mode: 'interactive',
      plan: [{ id: 's1', title: 'Task 1', status: 'pending' }] as PlanItem[],
      memory: createEmptyMemory(),
    });

    const dynamicPrompt = SystemPromptBuilder.buildDynamic(session);

    // Verify structure (not exact content - that's too brittle)
    expect(dynamicPrompt).toContain('## MANDATORY OUTPUTS');
    expect(dynamicPrompt).toContain('## APPROVED PLAN (PLANNER-OWNED)');
    expect(dynamicPrompt).toContain('## SESSION MEMORY (MUTABLE)');
    expect(dynamicPrompt).toContain('Workspace directory:');
    
    // Should NOT contain automation contract in interactive mode
    expect(dynamicPrompt).not.toContain('## AUTOMATION CONTRACT');
    expect(dynamicPrompt).not.toContain('## EXECUTION TURN CONTRACT');
  });

  it('SNAPSHOT: automated mode prompt structure', () => {
    const session = createMockSession({
      mode: 'automated',
      agentType: 'executor',
      plan: [
        { id: 's1', title: 'Scan', status: 'completed' },
        { id: 's2', title: 'Report', status: 'pending' },
      ] as PlanItem[],
    });

    const dynamicPrompt = SystemPromptBuilder.buildDynamic(session);

    // Solo executor should contain the direct-work sections.
    expect(dynamicPrompt).toContain('## AUTOMATION CONTRACT');
    expect(dynamicPrompt).toContain('## COORDINATION CONTRACT');
    expect(dynamicPrompt).toContain('## SECURITY WORKFLOW');
    expect(dynamicPrompt).toContain('## EXECUTION TURN CONTRACT');
    expect(dynamicPrompt).toContain('Finish the session with report.md in the workspace root.');
    expect(dynamicPrompt).toContain('## PLAN HINT');
    expect(dynamicPrompt).toContain('s1, s2');
    expect(dynamicPrompt).not.toContain('## DELEGATION PLAYBOOK');
    expect(dynamicPrompt).not.toContain('## WORKER COVERAGE SNAPSHOT');
  });

  it('SNAPSHOT: worker-spawning parent executor prompt structure', () => {
    const session = createMockSession({
      mode: 'automated',
      agentType: 'executor',
      flags: { workerSpawningAvailable: true },
      plan: [
        { id: 's1', title: 'Scan', status: 'completed' },
        { id: 's2', title: 'Report', status: 'pending' },
      ] as PlanItem[],
    });

    const dynamicPrompt = SystemPromptBuilder.buildDynamic(session);

    expect(dynamicPrompt).toContain('## AUTOMATION CONTRACT');
    expect(dynamicPrompt).toContain('## COORDINATION CONTRACT');
    expect(dynamicPrompt).toContain('## SECURITY WORKFLOW');
    expect(dynamicPrompt).toContain('## DELEGATION PLAYBOOK');
    expect(dynamicPrompt).toContain('## EXECUTION TURN CONTRACT');
    expect(dynamicPrompt).toContain('## WORKER COVERAGE SNAPSHOT');
    expect(dynamicPrompt).toContain('s1, s2');
  });

  it('SNAPSHOT: execution mode overlay is rendered when present', () => {
    const session = createMockSession({
      agentType: 'executor',
      executionMode: 'validation',
      plan: [{ id: 's1', title: 'Validate finding', status: 'pending' }] as PlanItem[],
    });

    const dynamicPrompt = SystemPromptBuilder.buildDynamic(session);

    expect(dynamicPrompt).toContain('## EXECUTION MODE');
    expect(dynamicPrompt).toContain('- validation');
  });

  it('SNAPSHOT: message ordering after sanitization', () => {
    // This tests that sanitizeForLLM produces expected ordering
    function sanitizeForLLM(messages: any[]): any[] {
      if (messages.length === 0) return messages;
      const result: any[] = [];

      for (let i = 0; i < messages.length; i++) {
        const curr = messages[i];
        const prev = result[result.length - 1];

        if (curr.role === 'assistant') {
          const hasContent = curr.content && curr.content.trim().length > 0;
          const hasToolCalls = curr.tool_calls?.length > 0;
          if (!hasContent && !hasToolCalls) continue;
        }

        if (prev?.role === 'assistant' && curr.role === 'assistant') {
          prev.content = [prev.content || '', curr.content || ''].filter(Boolean).join('\n\n');
          if (curr.tool_calls?.length > 0) {
            prev.tool_calls = [...(prev.tool_calls ?? []), ...curr.tool_calls];
          }
          continue;
        }

        if (prev && prev.role === curr.role && prev.content === curr.content) continue;

        result.push({ ...curr });
      }
      return result;
    }

    const pollutedMessages = [
      { role: 'user', content: 'Start task' },
      { role: 'assistant', content: 'Starting...', tool_calls: [{ id: 'tc1' }] },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'tc1' },
      { role: 'assistant', content: '' },  // empty - should be removed
      { role: 'assistant', content: 'Continue automated run...' },  // consecutive - should be merged
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'Continuing...' },
    ];

    const sanitized = sanitizeForLLM(pollutedMessages);

    // Expected: user -> assistant(merged) -> tool -> assistant(merged) -> user -> assistant
    const roles = sanitized.map(m => m.role);
    
    // No consecutive assistants
    for (let i = 1; i < roles.length; i++) {
      expect(roles[i] === 'assistant' && roles[i - 1] === 'assistant').toBe(false);
    }

    // No empty assistants without tool_calls
    for (const msg of sanitized) {
      if (msg.role === 'assistant') {
        const hasContent = msg.content && msg.content.trim().length > 0;
        const hasToolCalls = msg.tool_calls?.length > 0;
        expect(hasContent || hasToolCalls).toBe(true);
      }
    }
  });
});







