import { describe, expect, it } from 'vitest';
import { ToolPolicyChecker } from '@/domains/agent-brain/application/tools/ToolPolicyChecker';
import {
  browserActionTools,
  browserTools,
  fileTools,
  httpCaptureTools,
  httpDifferentialTools,
  oobTools,
  pythonTools,
  securityOpsTools,
  shellTools,
  skillTools,
  webTools,
  workerTools,
} from '@/domains/agent-brain/adapters/tools/builtins';
import {
  deriveWorkerTaskStatus,
  getWorkerSpawnReserveBlockReason,
  isArtifactScopedWriteScope,
  normalizeWorkerType,
  OPENING_WAVE_PREFERRED_CAP,
  resolveWorkerExecutableTools,
  resolveOpeningWaveConcurrency,
  resolveRootReportingReserveToolCalls,
  shouldRequireReportForSession,
  WORKER_WRITE_SCOPE_SAFE_TOOLS,
  WORKER_WRITE_SCOPE_NO_PATH_WRITE_TOOLS,
  WORKER_WRITE_SCOPE_PATH_BOUND_CANONICAL_TOOLS,
  WORKER_WRITE_SCOPE_UNSCOPED_TOOLS,
} from '@/domains/agent-brain/domain/workers/workerContracts';
import { BUILTIN_WORKER_PROFILES } from '@/domains/agent-brain/domain/workers/builtinWorkerProfiles';

const workerReachableBuiltinTools = [
  ...browserActionTools,
  ...browserTools,
  ...fileTools,
  ...httpCaptureTools,
  ...httpDifferentialTools,
  ...oobTools,
  ...pythonTools,
  ...securityOpsTools,
  ...shellTools,
  ...skillTools,
  ...webTools,
  ...workerTools,
];
const toolMetaByName = new Map(workerReachableBuiltinTools.map((tool) => [tool.meta.name, tool.meta]));
const runtimePathKeys = new Set(['path', 'targetPath', 'filePath', 'artifactPath', 'cwd']);

const hasRuntimeConstrainablePathArg = (schema: Record<string, unknown>): boolean => {
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return false;
  }
  return Object.keys(properties).some((key) => runtimePathKeys.has(key));
};

const isRuntimeForbiddenNoPathWriteTool = (toolName: string): boolean => {
  const meta = toolMetaByName.get(toolName);
  expect(meta, `missing builtin tool metadata for worker-advertised tool ${toolName}`).toBeDefined();
  if (!meta) {
    return false;
  }
  if (WORKER_WRITE_SCOPE_SAFE_TOOLS.has(toolName) || WORKER_WRITE_SCOPE_UNSCOPED_TOOLS.has(toolName)) {
    return false;
  }
  const descriptor = new ToolPolicyChecker().describeToolUse({ toolName, toolMeta: meta });
  return descriptor.actions.includes('write') &&
    descriptor.paths.length === 0 &&
    !hasRuntimeConstrainablePathArg(meta.schema);
};

describe('workerContracts', () => {
  it('treats inherited parent pauses as blocked worker state, not failure', () => {
    expect(
      deriveWorkerTaskStatus({
        blockedReason: 'user_paused',
        flags: {},
      } as any),
    ).toBe('blocked');

    expect(
      deriveWorkerTaskStatus({
        blockedReason: 'credits_exhausted',
        flags: {},
      } as any),
    ).toBe('blocked');

    expect(
      deriveWorkerTaskStatus({
        blockedReason: 'provider_quota_exhausted',
        flags: {},
      } as any),
    ).toBe('blocked');

    expect(
      deriveWorkerTaskStatus({
        blockedReason: 'system_paused',
        flags: {},
      } as any),
    ).toBe('blocked');
  });

  it('still treats worker terminal failures and cancellations distinctly', () => {
    expect(
      deriveWorkerTaskStatus({
        blockedReason: 'worker_failed',
        flags: {},
      } as any),
    ).toBe('failed');

    expect(
      deriveWorkerTaskStatus({
        blockedReason: 'worker_cancelled',
        flags: {},
      } as any),
    ).toBe('cancelled');
  });

  it('normalizes legacy worker types into canonical capability roles', () => {
    expect(normalizeWorkerType('exploit_worker')).toBe('validator_worker');
    expect(normalizeWorkerType('report_writer_worker')).toBe('evidence_worker');
    expect(normalizeWorkerType('recon_worker')).toBe('recon_worker');
  });

  it('reserves explicit reporting headroom for parent executor sessions', () => {
    expect(
      resolveRootReportingReserveToolCalls(
        { agentType: 'executor', coordination: { role: 'direct' } } as any,
        20,
      ),
    ).toBe(6);
    expect(
      resolveRootReportingReserveToolCalls(
        { agentType: 'planner', coordination: { role: 'direct' } } as any,
        20,
      ),
    ).toBe(0);
  });

  it('requires report closeout only for reporting phase sessions', () => {
    expect(shouldRequireReportForSession({
      agentType: 'executor',
      flags: { securityops: { activePhaseKey: 'validation' } },
    } as any)).toBe(false);
    expect(shouldRequireReportForSession({
      agentType: 'executor',
      flags: { securityops: { activePhaseKey: 'reporting' } },
    } as any)).toBe(true);
    expect(shouldRequireReportForSession({
      agentType: 'executor',
      flags: {},
    } as any)).toBe(true);
  });

  it('blocks late worker spawns when reporting reserve would be violated', () => {
    const reason = getWorkerSpawnReserveBlockReason(
      { agentType: 'executor', coordination: { role: 'direct' } } as any,
      {
        maxToolCalls: 20,
        usedToolCalls: 15,
        remainingToolCalls: 5,
        reservedToolCalls: 6,
      },
    );

    expect(reason).toContain('reserved for required completion work');
  });

  it('keeps parent synthesis reserves active for enumeration-phase B2 spawns', () => {
    const session = {
      agentType: 'executor',
      coordination: { role: 'direct' },
      flags: { securityops: { activePhaseKey: 'enumeration' } },
    } as any;
    expect(getWorkerSpawnReserveBlockReason(
      session,
      {
        maxToolCalls: 20,
        usedToolCalls: 15,
        remainingToolCalls: 5,
        reservedToolCalls: 0,
      },
      'enumeration_worker',
    )).toContain('reserved for required completion work');
    expect(resolveOpeningWaveConcurrency(
      session,
      {
        maxToolCalls: 20,
        usedToolCalls: 13,
        remainingToolCalls: 7,
        reservedToolCalls: 0,
      },
      3,
      ['enumeration_worker', 'enumeration_worker', 'enumeration_worker'],
    )).toBe(1);
  });

  it('treats .artifacts-only write scopes as shell-safe worker scopes', () => {
    expect(isArtifactScopedWriteScope(['/workspace/.artifacts'])).toBe(true);
    expect(isArtifactScopedWriteScope(['/workspace/.artifacts/recon'])).toBe(true);
    expect(isArtifactScopedWriteScope(['/workspace/poc'])).toBe(false);
  });

  it('keeps unconstrained runtimes executable for artifact-only write scopes but withholds them for broader write scopes', () => {
    const runtimeTools = ['shell_run', 'python_session'];
    const artifactScoped = resolveWorkerExecutableTools([...runtimeTools, 'file_write', 'submit_worker_result'], ['/workspace/.artifacts/recon']);
    expect(artifactScoped.executableTools).toEqual(
      expect.arrayContaining([...runtimeTools, 'file_write', 'submit_worker_result']),
    );
    expect(artifactScoped.withheldTools).toEqual([]);

    const broaderScope = resolveWorkerExecutableTools([...runtimeTools, 'file_write', 'submit_worker_result'], ['/workspace/poc']);
    expect(broaderScope.executableTools).toEqual(
      expect.arrayContaining(['file_write', 'submit_worker_result']),
    );
    expect(broaderScope.executableTools).not.toContain('shell_run');
    expect(broaderScope.executableTools).not.toContain('python_session');
    expect(broaderScope.withheldTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: 'shell_run',
        }),
        expect.objectContaining({
          tool: 'python_session',
        }),
      ]),
    );
  });

  describe('canonical writes under writeScope (H-2026-05-28-002)', () => {
    it('allows path-bound scanner ingestion only for artifact-scoped or unscoped workers', () => {
      const artifactScoped = resolveWorkerExecutableTools(
        ['http_payload', 'ingest_scan_artifact', 'submit_worker_result'],
        ['/workspace/.artifacts/recon'],
      );
      expect(artifactScoped.executableTools).toEqual(
        expect.arrayContaining(['http_payload', 'ingest_scan_artifact', 'submit_worker_result']),
      );
      expect(artifactScoped.withheldTools).toEqual([]);

      const broaderScoped = resolveWorkerExecutableTools(
        ['http_payload', 'ingest_scan_artifact', 'submit_worker_result'],
        ['/workspace/poc'],
      );
      expect(broaderScoped.executableTools).not.toContain('ingest_scan_artifact');
      expect(broaderScoped.withheldTools).toEqual(
        expect.arrayContaining([expect.objectContaining({ tool: 'ingest_scan_artifact' })]),
      );

      const unscoped = resolveWorkerExecutableTools(
        ['http_payload', 'ingest_scan_artifact', 'submit_worker_result'],
        [],
      );
      // No writeScope: the runtime allows canonical writes, so the preflight must not withhold them.
      expect(unscoped.executableTools).toContain('ingest_scan_artifact');
      expect(unscoped.withheldTools).toEqual([]);
    });

    it('keeps every path-bound canonical tool backed by a runtime-constrainable schema path', () => {
      for (const toolName of WORKER_WRITE_SCOPE_PATH_BOUND_CANONICAL_TOOLS) {
        const meta = toolMetaByName.get(toolName);
        expect(meta, `missing builtin metadata for path-bound canonical tool ${toolName}`).toBeDefined();
        expect(
          meta ? hasRuntimeConstrainablePathArg(meta.schema) : false,
          `path-bound canonical tool ${toolName} must expose a recognized path argument`,
        ).toBe(true);
      }
    });

    it('withholds canonical no-path writes even for an artifact-scoped writeScope (no shell-style exemption)', () => {
      const scoped = resolveWorkerExecutableTools(
        ['report_finding', 'submit_validation_outcome', 'submit_worker_result'],
        ['/workspace/.artifacts/validation'],
      );
      expect(scoped.executableTools).toEqual(['submit_worker_result']);
      expect(scoped.withheldTools.map((entry) => entry.tool)).toEqual(
        expect.arrayContaining(['report_finding', 'submit_validation_outcome']),
      );
    });

    // Anti-drift guard: derive runtime-forbidden no-path writes from the same tool metadata
    // the runtime policy checker uses. A new worker-advertised write tool with no
    // constrainable path must be added to WORKER_WRITE_SCOPE_NO_PATH_WRITE_TOOLS.
    it('withholds every worker-advertised runtime-forbidden no-path write under an active writeScope', () => {
      const activeScope = ['/workspace/.artifacts/worker'];
      for (const profile of BUILTIN_WORKER_PROFILES) {
        const runtimeForbiddenNoPathWrites = profile.allowedTools.filter(isRuntimeForbiddenNoPathWriteTool);
        for (const tool of runtimeForbiddenNoPathWrites) {
          expect(
            WORKER_WRITE_SCOPE_NO_PATH_WRITE_TOOLS.has(tool),
            `worker ${profile.workerType} advertises runtime-forbidden no-path write ${tool}; add it to WORKER_WRITE_SCOPE_NO_PATH_WRITE_TOOLS`,
          ).toBe(true);
        }

        const resolution = resolveWorkerExecutableTools(profile.allowedTools, activeScope);
        const withheldTools = resolution.withheldTools.map((entry) => entry.tool);
        expect(
          withheldTools,
          `worker ${profile.workerType} must withhold every runtime-forbidden no-path write`,
        ).toEqual(expect.arrayContaining(runtimeForbiddenNoPathWrites));

        const leakedNoPathWrites = resolution.executableTools.filter((tool) =>
          runtimeForbiddenNoPathWrites.includes(tool),
        );
        expect(leakedNoPathWrites, `worker ${profile.workerType} advertises runtime-forbidden no-path writes`).toEqual([]);
      }
    });
  });

  describe('resolveOpeningWaveConcurrency', () => {
    it('returns the preferred cap when no budget snapshot is provided', () => {
      const cap = resolveOpeningWaveConcurrency(
        { agentType: 'executor', coordination: { role: 'direct' }, flags: {} } as any,
        undefined,
      );
      expect(cap).toBe(OPENING_WAVE_PREFERRED_CAP);
    });

    it('returns the preferred cap for worker sessions (no reporting reserve)', () => {
      const cap = resolveOpeningWaveConcurrency(
        { agentType: 'executor', coordination: { role: 'worker' }, flags: {} } as any,
        {
          maxToolCalls: 4,
          usedToolCalls: 0,
          remainingToolCalls: 4,
          reservedToolCalls: 6,
        },
      );
      expect(cap).toBe(OPENING_WAVE_PREFERRED_CAP);
    });

    it('truncates the cap when the reporting reserve would leave no headroom', () => {
      const cap = resolveOpeningWaveConcurrency(
        { agentType: 'executor', coordination: { role: 'direct' }, flags: {} } as any,
        {
          maxToolCalls: 20,
          usedToolCalls: 13,
          remainingToolCalls: 7,
          reservedToolCalls: 6,
        },
      );
      expect(cap).toBe(1);
    });

    it('sizes the opening wave by tool-call headroom only, never by credits', () => {
      const cap = resolveOpeningWaveConcurrency(
        { agentType: 'executor', coordination: { role: 'direct' }, flags: {} } as any,
        {
          maxToolCalls: 100,
          usedToolCalls: 0,
          remainingToolCalls: 100,
          reservedToolCalls: 0,
        },
        3,
      );
      expect(cap).toBe(3);
    });

    it('respects a caller-supplied preferred cap smaller than the default', () => {
      const cap = resolveOpeningWaveConcurrency(
        { agentType: 'executor', coordination: { role: 'direct' }, flags: {} } as any,
        undefined,
        1,
      );
      expect(cap).toBe(1);
    });
  });
});
