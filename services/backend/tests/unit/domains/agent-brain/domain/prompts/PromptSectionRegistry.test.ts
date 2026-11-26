import { describe, expect, it } from 'vitest';
import { SystemPromptBuilder } from '@/domains/agent-brain/domain/prompts/SystemPromptBuilder';

describe('PromptSectionRegistry integration', () => {
  it('builds the static prompt through registered sections', () => {
    const sections = SystemPromptBuilder.buildStaticSections('ROLE PROMPT', [
      {
        name: 'file_read',
        description: 'Read a file',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    ]);

    expect(sections.map((section) => section.key)).toEqual(['role_prompt', 'tool_catalog']);
  });

  it('builds dynamic sections through registered prompt section builders', () => {
    const sections = SystemPromptBuilder.buildDynamicSections({
      agentType: 'executor',
      mode: 'automated',
      coordination: { role: 'direct' },
      workerTasks: [],
      plan: [],
      flags: { workerSpawningAvailable: true },
    } as any);

    const keys = sections.map((section) => section.key);
    expect(keys).toContain('coordination_contract');
    expect(keys).toContain('security_workflow');
    expect(keys).toContain('delegation_playbook');
    expect(keys).toContain('session_memory');
  });

  it('recites the workspace engagement model instead of the overlapping worker coverage snapshot', () => {
    const sections = SystemPromptBuilder.buildDynamicSections({
      agentType: 'executor',
      mode: 'automated',
      coordination: { role: 'direct' },
      workerTasks: [
        {
          taskId: 'worker-1',
          status: 'completed',
          workerType: 'wordpress-analyzer',
          reason: 'Analyze WordPress exposure',
        },
      ],
      plan: [],
      flags: {
        securityops: { runId: 'run-1', activePhaseKey: 'recon' },
        workerSpawningAvailable: true,
        workspaceProjectionModelRecitation:
          '# Live Engagement Model\n\n## Do Not Retry\n- wp-json auth probing already ruled out',
      },
    } as any);

    const keys = sections.map((section) => section.key);
    expect(keys).toContain('workspace_engagement_model');
    expect(keys).not.toContain('worker_coverage_snapshot');
    expect(sections.find((section) => section.key === 'workspace_engagement_model')?.content).toContain(
      'wp-json auth probing already ruled out',
    );
  });

  it('surfaces workspace projection warnings as a dynamic section', () => {
    const sections = SystemPromptBuilder.buildDynamicSections({
      agentType: 'executor',
      mode: 'automated',
      coordination: { role: 'direct' },
      workerTasks: [],
      plan: [],
      flags: {
        securityops: { runId: 'run-1' },
        workspaceProjectionWarning: 'Projection refresh failed before prompt recitation.',
      },
    } as any);

    expect(sections.find((section) => section.key === 'workspace_projection_warning')?.content).toContain(
      'Projection refresh failed',
    );
  });
});
