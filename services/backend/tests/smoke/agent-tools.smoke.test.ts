import { describe, expect, it } from 'vitest';

import {
  browserActionTools,
  browserTools,
  fileTools,
  httpCaptureTools,
  httpDifferentialTools,
  oobTools,
  phaseTools,
  planTools,
  pythonTools,
  securityOpsTools,
  shellTools,
  submitPlanTools,
  webTools,
  workerTools,
} from '@/domains/agent-brain/adapters/tools/builtins';
import type { ToolModuleDefinition } from '@/domains/agent-brain/application/tools/types';

const ENABLED =
  process.env.RUN_SANDBOX_TOOL_SMOKE === '1' ||
  process.env.RUN_TOOL_SMOKE === '1';

const describeSmoke = ENABLED ? describe : describe.skip;

const TOOL_GROUPS: Array<{ group: string; tools: ToolModuleDefinition[] }> = [
  { group: 'file', tools: fileTools },
  { group: 'shell', tools: shellTools },
  { group: 'python', tools: pythonTools },
  { group: 'web', tools: webTools },
  { group: 'browser', tools: browserTools },
  { group: 'browser-action', tools: browserActionTools },
  { group: 'http-capture', tools: httpCaptureTools },
  { group: 'http-differential', tools: httpDifferentialTools },
  { group: 'oob', tools: oobTools },
  { group: 'plan', tools: planTools },
  { group: 'submit-plan', tools: submitPlanTools },
  { group: 'phase', tools: phaseTools },
  { group: 'worker', tools: workerTools },
  { group: 'securityops', tools: securityOpsTools },
];

const allTools = TOOL_GROUPS.flatMap(({ group, tools }) =>
  tools.map((tool) => ({
    group,
    tool,
    name: tool.meta.name,
  })),
);

describeSmoke('agent tool contract smoke', () => {
  it('keeps builtin tool names unique and schemas advertiseable', () => {
    const names = allTools.map((entry) => entry.name);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);

    for (const { group, tool, name } of allTools) {
      expect(name, `${group} tool missing name`).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.meta.category, `${name} missing category`).toEqual(expect.any(String));
      expect(tool.meta.description, `${name} missing description`).toEqual(expect.any(String));
      expect(tool.meta.description.length, `${name} description is too short`).toBeGreaterThan(20);
      expect(tool.meta.schema, `${name} missing schema`).toEqual(expect.objectContaining({ type: 'object' }));
      expect(tool.manifest.id, `${name} manifest id drift`).toBe(name);
      expect(tool.manifest.argsSchema, `${name} manifest schema drift`).toBe(tool.meta.schema);
    }
  });

  it('covers the sandbox-facing tool surface the agent depends on', () => {
    const names = new Set(allTools.map((entry) => entry.name));

    expect([...names]).toEqual(expect.arrayContaining([
      'file_read',
      'file_write',
      'shell_run',
      'wait_for_shell_job',
      'python_session',
      'http_payload',
      'http_raw_send',
      'browser_action',
      'http_list',
      'http_view',
      'http_repeat',
      'http_sitemap',
      'persona_save',
      'persona_load',
      'authz_replay',
      'spawn_worker',
      'submit_worker_result',
      'submit_phase_handoff',
      'report_finding',
    ]));
  });

  it('advertises scanner ingest auto-discovery from the canonical scans directory', () => {
    const ingestScanArtifact = allTools.find((entry) => entry.name === 'ingest_scan_artifact')?.tool;
    expect(ingestScanArtifact).toBeDefined();

    const schema = ingestScanArtifact!.meta.schema as {
      required?: string[];
      properties?: Record<string, { description?: string }>;
    };

    expect(schema.required).toEqual(['parser']);
    expect(schema.required).not.toContain('artifactPath');
    expect(schema.properties?.artifactPath?.description).toContain('.artifacts/scans');
  });
});
