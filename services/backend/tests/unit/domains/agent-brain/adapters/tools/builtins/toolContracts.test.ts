import { describe, expect, it } from 'vitest';
import { HttpPayload, HttpRawSend } from '@/domains/agent-brain/adapters/tools/builtins/browser';
import { BrowserAction } from '@/domains/agent-brain/adapters/tools/builtins/browser_action';
import { WebSearch, normalizeWebSearchQuery } from '@/domains/agent-brain/adapters/tools/builtins/web';
import { ShellRun, WaitForShellJob } from '@/domains/agent-brain/adapters/tools/builtins/shell';
import { PythonSession } from '@/domains/agent-brain/adapters/tools/builtins/python';
import { tools as securityOpsTools } from '@/domains/agent-brain/adapters/tools/builtins/securityops';
import { toolContractRegistry } from '@/domains/agent-brain/application/tools/ToolContractRegistry';

describe('builtin tool contracts', () => {
  it('http_payload exposes a rich evidence-first contract', () => {
    expect(HttpPayload.meta.description).toContain('PRIMARY EVIDENCE TOOL');
    expect(HttpPayload.meta.description).toContain('REQUEST SHAPE:');
    expect(HttpPayload.meta.description).toContain('EVIDENCE BEST PRACTICES:');
    expect(HttpPayload.meta.description).toContain('ERROR RECOVERY:');
    expect(HttpPayload.meta.description).toContain('use http_raw_send instead');
    expect(HttpPayload.meta.description).toContain('\n');
    expect((HttpPayload.meta.schema.properties as Record<string, unknown>).rawRequest).toBeDefined();
  });

  it('http_raw_send exposes a byte-exact raw transport contract', () => {
    expect(HttpRawSend.meta.description).toContain('byte-exact HTTP/1.1 bytes');
    expect(HttpRawSend.meta.description).toContain('duplicate headers');
    expect(HttpRawSend.meta.description).toContain('same-socket request sequences');
    expect((HttpRawSend.meta.schema.properties as Record<string, unknown>).raw_request_base64).toBeDefined();
    expect((HttpRawSend.meta.schema.properties as Record<string, unknown>).requests).toBeDefined();
  });

  it('python_session exposes stateful PoC and replay guidance', () => {
    expect(PythonSession.meta.description).toContain('persistent per-run interpreter');
    expect(PythonSession.meta.description).toContain('PRE-INJECTED HELPERS:');
    expect(PythonSession.meta.description).toContain('replay');
    expect(PythonSession.meta.description).toContain('save_poc');
    expect((PythonSession.meta.schema.properties as Record<string, unknown>).exchange_id).toBeDefined();
    expect((PythonSession.meta.schema.properties as Record<string, unknown>).poc_path).toBeDefined();
  });

  it('browser_action exposes routing and interpretation guidance', () => {
    expect(BrowserAction.meta.description).toContain('LIFECYCLE:');
    expect(BrowserAction.meta.description).toContain('OUTPUT INTERPRETATION:');
    expect(BrowserAction.meta.description).toContain('JAVASCRIPT USAGE:');
    expect(BrowserAction.meta.description).toContain('WHEN TO USE vs other tools:');
  });

  it('web_search accepts both q and query aliases', () => {
    expect(normalizeWebSearchQuery({ q: '  cwe sql injection ' })).toBe('cwe sql injection');
    expect(normalizeWebSearchQuery({ query: '  grafana cve ' })).toBe('grafana cve');
    expect(normalizeWebSearchQuery({})).toBe('');
    expect((WebSearch.meta.schema.properties as Record<string, unknown>).query).toBeDefined();
  });

  it('registers built-in tool contracts in the registry', () => {
    expect(toolContractRegistry.get('http_payload')?.description).toContain('PRIMARY EVIDENCE TOOL');
    expect(toolContractRegistry.get('http_raw_send')?.description).toContain('byte-exact HTTP/1.1 bytes');
    expect(toolContractRegistry.get('browser_action')?.description).toContain('LIFECYCLE:');
    expect(toolContractRegistry.get('web_search')?.description).toContain('RESEARCH TOOL');
    expect(toolContractRegistry.get('shell_run')?.description).toContain('TOOL ROUTING');
    expect(toolContractRegistry.get('shell_run')?.schema).toEqual(ShellRun.meta.schema);
    expect(toolContractRegistry.get('wait_for_shell_job')?.description).toContain('managed shell job');
    expect(toolContractRegistry.get('wait_for_shell_job')?.schema).toEqual(WaitForShellJob.meta.schema);
    expect(toolContractRegistry.get('python_session')?.description).toContain('persistent per-run interpreter');
    expect(toolContractRegistry.get('python_session')?.schema).toEqual(PythonSession.meta.schema);
  });

  it('exposes tool contract metadata for diagnostics', () => {
    const entry = toolContractRegistry.getEntry('http_payload');

    expect(entry).toEqual(
      expect.objectContaining({
        priority: 0,
        source: undefined,
        contract: expect.objectContaining({
          name: 'http_payload',
        }),
      }),
    );
    expect(toolContractRegistry.listEntries().some((item) => item.contract.name === 'shell_run')).toBe(true);
    expect(toolContractRegistry.listEntries().some((item) => item.contract.name === 'wait_for_shell_job')).toBe(true);
    expect(toolContractRegistry.listEntries().some((item) => item.contract.name === 'http_raw_send')).toBe(true);
    expect(toolContractRegistry.listEntries().some((item) => item.contract.name === 'python_session')).toBe(true);
  });

  it('keeps model-visible SecurityOps tools live and P0 closeout tools exposed', () => {
    const names = securityOpsTools.map((tool) => tool.manifest.id);
    const retiredDeadTools = ['note_lead', 'promote_candidate', 'link_findings'];

    expect(names).toEqual(
      expect.arrayContaining(['report_finding', 'promote_finding', 'prepare_report_context', 'finalize_run_artifacts', 'ingest_scan_artifact']),
    );
    expect(names).not.toContain('transition_phase');
    for (const retired of retiredDeadTools) {
      expect(names).not.toContain(retired);
    }
    for (const tool of securityOpsTools) {
      expect(typeof tool.run).toBe('function');
      expect(tool.manifest.summary.trim().length).toBeGreaterThan(0);
      expect(tool.manifest.argsSchema).toBeDefined();
    }
  });

  it('requires proof trail fields on submit_validation_outcome', () => {
    const submitValidationOutcome = securityOpsTools.find((tool) => tool.manifest.id === 'submit_validation_outcome');
    const schema = submitValidationOutcome?.manifest.argsSchema as
      | { required?: unknown; properties?: Record<string, unknown> }
      | undefined;
    expect(schema?.required).toEqual(expect.arrayContaining(['proof']));
    const properties = schema?.properties;
    expect(properties?.proof).toBeDefined();
  });

  it('documents durable evidence refs for record_control_check', () => {
    const recordControlCheck = securityOpsTools.find((tool) => tool.manifest.id === 'record_control_check');
    const schema = recordControlCheck?.manifest.argsSchema as
      | { properties?: Record<string, { description?: string; properties?: Record<string, { description?: string }> }> }
      | undefined;

    expect(recordControlCheck?.manifest.summary).toContain('compliance-evidence:<id>');
    expect(schema?.properties?.evidenceRefs?.description).toContain('/workspace/.artifacts/');
    expect(schema?.properties?.proof?.properties?.evidenceIds?.description).toContain('Same durable ref format');
  });
});
