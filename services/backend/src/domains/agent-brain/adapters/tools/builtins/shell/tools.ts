
import type { ManagedShellJobResult, SandboxExecutionResult } from '@/domains/agent-brain/adapters/sandbox';
import { type ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import { getSessionFromContext } from '@/domains/agent-brain/application/tools/runtime/ToolContextSelectors';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import { findCloudBlockedNetworkTargetsInCommand } from '@/domains/security-ops/scopes/networkTargetPolicy';
import { logger } from '@/shared/logger';
import { summarizeForNote } from '@/shared/utils/text';

import {
  asOptionalPositiveNumber,
  buildManagedShellJobToolResponse,
  buildPartialIngestionSuggestion,
  buildUnknownManagedShellJobResponse,
  checkWorkspaceStoragePreflight,
  createAbortError,
  findReusableScannerJob,
  getActiveScannerJobAdmission,
  getString,
  hasManagedShellJobs,
  isManagedShellJobResponseOk,
  isManagedShellUnsupported,
  isSecurityOpsCloudSession,
  isTerminalManagedShellStatus,
  MAX_MANAGED_CHECK_WAIT_MS,
  normalizeWaitForShellJobMs,
  recordManagedShellJobState,
  resolveAction,
  resolveHttpProxyPrefix,
  resolveScannerWallBudget,
  SCAN_DIGEST_PATH,
  SCANNER_RAW_READ_POLICY,
  scheduleManagedJobMonitor,
  SHELL_RUN_CONTRACT,
  sleep,
  streamLabel,
  syncReferencedWorkspaceSupportFiles,
  validateScannerOutputContract,
  WAIT_FOR_SHELL_JOB_CONTRACT
} from './shared';

export const ShellRun: ToolImpl = {
  meta: {
    name: 'shell_run',
    description: SHELL_RUN_CONTRACT.description,
    category: 'shell',
    schema: SHELL_RUN_CONTRACT.schema,
    risks: ['compute', 'read', 'write', 'network'],
  },
  async run({ command, action: rawAction, jobId: rawJobId, waitMs, hardTimeoutMs }, ctx) {
    const rawCommand = typeof command === 'string' ? command : '';
    const trimmedCommand = rawCommand.trim();
    const jobId = typeof rawJobId === 'string' ? rawJobId.trim() : '';
    const action = resolveAction(rawAction, jobId);
    return runWithGuards(
      ShellRun.meta,
      ctx,
      async () => {
        if (action === 'run' && !trimmedCommand) {
          return { ok: false, data: { success: false, error: 'command is required' } };
        }

        const session = getSessionFromContext(ctx);
        if (!session) {
          return { ok: false, data: { success: false, error: `Session ${ctx.sessionId} not found` } };
        }

        if (action === 'check' || action === 'cancel') {
          if (!jobId) {
            return { ok: false, data: { success: false, error: 'jobId is required for shell job check/cancel' } };
          }
          if (!hasManagedShellJobs(ctx.sandbox)) {
            return { ok: false, data: { success: false, error: 'managed shell jobs are not available in this runtime' } };
          }
          const unknownJobResponse = buildUnknownManagedShellJobResponse(session, jobId);
          if (unknownJobResponse) {
            return { ok: false, data: unknownJobResponse };
          }
          const result = action === 'cancel'
            ? await ctx.sandbox.cancelManagedShellJob(session, jobId, 'cancelled_by_agent')
            : await ctx.sandbox.checkManagedShellJob(session, jobId, {
              waitBudgetMs: asOptionalPositiveNumber(waitMs),
              turnNumber: ctx.turnNumber,
              signal: ctx.abortSignal,
            });
          const state = await recordManagedShellJobState(ctx, result);
          if (result.status === 'running' || result.status === 'unknown') {
            scheduleManagedJobMonitor(ctx, session, jobId, result.nextCheckAfterMs);
          }
          const response = await buildManagedShellJobToolResponse(ctx, session, result, {
            ...(state.scannerBudget ? { scannerBudget: state.scannerBudget } : {}),
          });
          return {
            ok: isManagedShellJobResponseOk(response),
            data: response,
          };
        }

        if (isSecurityOpsCloudSession(session)) {
          const blockedTargets = findCloudBlockedNetworkTargetsInCommand(rawCommand);
          if (blockedTargets.length > 0) {
            return {
              ok: false,
              data: {
                success: false,
                error:
                  `Cloud execution cannot target private or reserved network addresses (${blockedTargets.join(', ')}). ` +
                  'Select an attached private runner for internal CIDR assessment.',
              },
            };
          }
        }

        const scannerOutputContractFailure = validateScannerOutputContract(rawCommand);
        if (scannerOutputContractFailure) {
          await ctx.trace?.write(ctx.sessionId, ctx.turnNumber ?? (session.turn ?? 0) + 1, {
            event: 'scanner.output_contract_failed',
            severity: 'warn',
            payload: scannerOutputContractFailure,
            note: summarizeForNote(getString(scannerOutputContractFailure.error) ?? 'scanner output contract failed'),
          });
          return { ok: false, data: scannerOutputContractFailure };
        }

        ctx.guards.cmdGuard.validate(rawCommand);
        const storagePreflight = await checkWorkspaceStoragePreflight(ctx, session, rawCommand);
        if (storagePreflight?.severity === 'critical') {
          await ctx.trace?.write(ctx.sessionId, ctx.turnNumber ?? (session.turn ?? 0) + 1, {
            event: 'scanner.storage_preflight_blocked',
            severity: 'warn',
            payload: {
              command: rawCommand,
              storagePreflight,
            },
            note: summarizeForNote('scanner blocked by critical workspace storage pressure'),
          });
          return {
            ok: false,
            data: {
              success: false,
              code: 'workspace_storage_pressure',
              error:
                `Scanner start blocked: workspace storage is critically low` +
                (typeof storagePreflight.freeMb === 'number' ? ` (${storagePreflight.freeMb}MB free)` : '') +
                '. Ingest/digest existing output, reduce scan scope, wait for active jobs, or record blocked coverage before starting more scans.',
              storagePreflight,
              digestPath: SCAN_DIGEST_PATH,
              rawReadPolicy: SCANNER_RAW_READ_POLICY,
              nextAction: 'ingest_digest_existing_artifacts_or_record_blocked_coverage',
            },
          };
        }
        await syncReferencedWorkspaceSupportFiles(ctx, session, rawCommand);
        const executionCommand = `${resolveHttpProxyPrefix(session)}${rawCommand}`;

        const config = ctx.config;
        const maxChunk = Math.max(
          1,
          ctx.policies.maxStdoutBytes ||
          config?.trace?.stdoutChunkSize ||
          65_536,
        );
        const recorder = ctx.trace;
        const turn = ctx.turnNumber ?? (session.turn ?? 0) + 1;

        const emitStreamChunk = (type: 'stdout' | 'stderr', chunk: string): void => {
          if (!chunk) {
            return;
          }
          const log = logger.child({ scope: 'shell_run', sessionId: ctx.sessionId });
          for (let offset = 0; offset < chunk.length; offset += maxChunk) {
            const slice = chunk.slice(offset, offset + maxChunk);
            ctx.streamBroker.emit(ctx.sessionId, {
              type: 'tool_output',
              data: { name: 'shell_run', chunk: slice },
            });
            if (type === 'stdout') {
              ctx.planRuntime.appendProvenanceSnippet(ctx.sessionId, slice);
            }
            if (recorder) {
              recorder
                .write(ctx.sessionId, turn, {
                  event: `tool.${streamLabel[type]}`,
                  severity: 'debug',
                  payload: { name: 'shell_run', chunk: slice },
                  note: summarizeForNote(`${streamLabel[type]} len=${slice.length}`),
                })
                .catch((error) => {
                  log.warn({ err: error }, `Failed to record tool.${streamLabel[type]} chunk`);
                });
            }
          }
        };

        if (hasManagedShellJobs(ctx.sandbox)) {
          try {
            const existingScannerJob = findReusableScannerJob(session, rawCommand);
            if (existingScannerJob) {
              const state = await recordManagedShellJobState(ctx, existingScannerJob);
              scheduleManagedJobMonitor(ctx, session, existingScannerJob.jobId, existingScannerJob.nextCheckAfterMs);
              const response = await buildManagedShellJobToolResponse(ctx, session, existingScannerJob, {
                reusedExistingJob: true,
                ...(state.scannerBudget ? { scannerBudget: state.scannerBudget } : {}),
                ...(storagePreflight ? { storagePreflight } : {}),
              });
              return {
                ok: isManagedShellJobResponseOk(response),
                data: response,
              };
            }

            const scannerAdmission = getActiveScannerJobAdmission(session, rawCommand);
            if (scannerAdmission && scannerAdmission.activeCount >= scannerAdmission.cap) {
              await ctx.trace?.write(ctx.sessionId, ctx.turnNumber ?? (session.turn ?? 0) + 1, {
                event: 'scanner.admission_blocked',
                severity: 'warn',
                payload: {
                  command: rawCommand,
                  scannerFamily: scannerAdmission.scannerFamily,
                  activeScannerJobCount: scannerAdmission.activeCount,
                  maxActiveScannerJobs: scannerAdmission.cap,
                  activeJobIds: scannerAdmission.activeJobIds.slice(0, 10),
                },
                note: summarizeForNote('scanner blocked by active scanner job cap'),
              });
              return {
                ok: false,
                data: {
                  success: false,
                  code: 'scanner_concurrency_pressure',
                  error:
                    `Scanner start blocked: ${scannerAdmission.activeCount} active scanner job(s) already meet the run cap of ${scannerAdmission.cap}. ` +
                    'Call wait_for_shell_job, ingest/digest completed artifacts, or record blocked coverage before starting another scanner.',
                  scannerFamily: scannerAdmission.scannerFamily,
                  activeScannerJobCount: scannerAdmission.activeCount,
                  maxActiveScannerJobs: scannerAdmission.cap,
                  activeJobIds: scannerAdmission.activeJobIds.slice(0, 10),
                  digestPath: SCAN_DIGEST_PATH,
                  rawReadPolicy: SCANNER_RAW_READ_POLICY,
                  nextAction: 'wait_for_shell_job',
                },
              };
            }

            const scannerBudget = resolveScannerWallBudget(session, rawCommand);
            const requestedHardTimeoutMs = asOptionalPositiveNumber(hardTimeoutMs);
            const effectiveHardTimeoutMs = scannerBudget
              ? Math.min(requestedHardTimeoutMs ?? scannerBudget.hardTimeoutMs, scannerBudget.hardTimeoutMs)
              : requestedHardTimeoutMs;
            const managedResult = await ctx.sandbox.startManagedShellJob(session, executionCommand, {
              waitBudgetMs: asOptionalPositiveNumber(waitMs),
              hardTimeoutMs: effectiveHardTimeoutMs,
              turnNumber: ctx.turnNumber,
              signal: ctx.abortSignal,
              onStdout: (chunk) => emitStreamChunk('stdout', chunk),
              onStderr: (chunk) => emitStreamChunk('stderr', chunk),
            });
            const state = await recordManagedShellJobState(ctx, managedResult);
            if (managedResult.status === 'running' || managedResult.status === 'unknown') {
              scheduleManagedJobMonitor(ctx, session, managedResult.jobId, managedResult.nextCheckAfterMs);
            }
            const response = await buildManagedShellJobToolResponse(ctx, session, managedResult, {
              ...(state.scannerBudget ? { scannerBudget: state.scannerBudget } : {}),
              ...(storagePreflight ? { storagePreflight } : {}),
            });
            return {
              ok: isManagedShellJobResponseOk(response),
              data: response,
            };
          } catch (error) {
            if (!isManagedShellUnsupported(error)) {
              throw error;
            }
            // Older runtimes can still use the legacy blocking exec path.
          }
        }

        const execResult = await ctx.sandbox.exec({
          session,
          cmd: executionCommand,
          timeoutMs: ctx.policies.timeoutMs,
          signal: ctx.abortSignal,
          onStdout: (chunk) => emitStreamChunk('stdout', chunk),
          onStderr: (chunk) => emitStreamChunk('stderr', chunk),
        });

        const result: SandboxExecutionResult = {
          success: !execResult.timedOut && !execResult.aborted && execResult.exitCode === 0,
          stdout: execResult.stdout,
          stderr: execResult.stderr,
          code: execResult.exitCode,
          timedOut: execResult.timedOut,
          aborted: execResult.aborted,
          abortReason: execResult.abortReason,
          artifacts: execResult.artifacts,
        };

        if (result.aborted) {
          throw createAbortError(result.abortReason);
        }

        return {
          ok: result.success,
          data: result,
        };
      },
      {},
      { cmd: rawCommand, action, jobId }
    );
  },
};

export const WaitForShellJob: ToolImpl = {
  meta: {
    name: 'wait_for_shell_job',
    description: WAIT_FOR_SHELL_JOB_CONTRACT.description,
    category: 'shell',
    schema: WAIT_FOR_SHELL_JOB_CONTRACT.schema,
    risks: ['compute', 'read'],
  },
  async run({ jobId: rawJobId, timeoutSec }, ctx) {
    const jobId = typeof rawJobId === 'string' ? rawJobId.trim() : '';
    const timeoutMs = normalizeWaitForShellJobMs(timeoutSec);

    return runWithGuards(
      WaitForShellJob.meta,
      ctx,
      async () => {
        if (!jobId) {
          return { ok: false, data: { success: false, error: 'jobId is required' } };
        }

        const session = getSessionFromContext(ctx);
        if (!session) {
          return { ok: false, data: { success: false, error: `Session ${ctx.sessionId} not found` } };
        }

        if (!hasManagedShellJobs(ctx.sandbox)) {
          return { ok: false, data: { success: false, error: 'managed shell jobs are not available in this runtime' } };
        }

        const unknownJobResponse = buildUnknownManagedShellJobResponse(session, jobId);
        if (unknownJobResponse) {
          return { ok: false, data: unknownJobResponse };
        }

        const deadline = Date.now() + timeoutMs;
        let result: ManagedShellJobResult | undefined;

        while (Date.now() < deadline) {
          const remainingMs = Math.max(0, deadline - Date.now());
          result = await ctx.sandbox.checkManagedShellJob(session, jobId, {
            waitBudgetMs: Math.min(MAX_MANAGED_CHECK_WAIT_MS, remainingMs),
            turnNumber: ctx.turnNumber,
            signal: ctx.abortSignal,
          });
          const state = await recordManagedShellJobState(ctx, result);

          if (isTerminalManagedShellStatus(result.status)) {
            const response = await buildManagedShellJobToolResponse(ctx, session, result, {
              ...(state.scannerBudget ? { scannerBudget: state.scannerBudget } : {}),
            });
            return {
              ok: isManagedShellJobResponseOk(response),
              data: response,
            };
          }

          const nextDelay = Math.min(result.nextCheckAfterMs ?? 1_000, Math.max(0, deadline - Date.now()), 2_000);
          await sleep(nextDelay, ctx.abortSignal);
        }

        result ??= await ctx.sandbox.checkManagedShellJob(session, jobId, {
          waitBudgetMs: 0,
          turnNumber: ctx.turnNumber,
          signal: ctx.abortSignal,
        });
        if (isTerminalManagedShellStatus(result.status)) {
          const state = await recordManagedShellJobState(ctx, result);
          const response = await buildManagedShellJobToolResponse(ctx, session, result, {
            ...(state.scannerBudget ? { scannerBudget: state.scannerBudget } : {}),
          });
          return {
            ok: isManagedShellJobResponseOk(response),
            data: response,
          };
        }
        if (result.status === 'running' || result.status === 'unknown') {
          scheduleManagedJobMonitor(ctx, session, jobId, result.nextCheckAfterMs);
        }

        const partialIngestion = buildPartialIngestionSuggestion(result);
        const state = await recordManagedShellJobState(ctx, result, {
          incrementWaitCount: true,
          ...(partialIngestion ? { partialIngestion } : {}),
        });
        const response = await buildManagedShellJobToolResponse(ctx, session, result, {
          waitTimedOut: true,
          ...(state.scannerBudget ? { scannerBudget: state.scannerBudget } : {}),
          ...(partialIngestion ? { partialIngestion } : {}),
        });
        return {
          ok: isManagedShellJobResponseOk(response),
          data: response,
        };
      },
      {},
      { jobId, timeoutSec }
    );
  },
};

