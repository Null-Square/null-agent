
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { getSessionFromContext } from '@/domains/agent-brain/application/tools/runtime/ToolContextSelectors';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import { attachProjectionWarning } from '@/domains/security-ops/workspace/workspaceProjectionRuntime';
import { resolveSecurityOpsToolContext } from '../securityopsContext';
import { getSecurityOpsService } from '../securityopsServiceRegistry';
import { getHostedRunPersistencePort } from '@/domains/security-ops/runs/HostedRunPersistencePort';

import {
  buildMermaidRejectionError,
  buildNoteRelatedIds,
  buildSecurityOpsRelatedIds,
  collectMermaidFieldFailures,
  downgradeCompletedScanCoverageForActiveJobs,
  emitSecurityOpsTimeline,
  formatToolError,
  getAssetRefLabel,
  getString,
  hydrateRemoteEvidenceFiles,
  isRecord,
  pickToolArgsPreview,
  projectionScopesForNote,
  recordInventoryProgress,
  recordReportedFinding,
  REPORT_FINDING_MERMAID_FIELDS,
  REPORT_NOTE_DATA_GUIDANCE,
  requireUserId,
  resolveToolWorkspaceDir
} from './shared';

export const ReportAsset: ToolImpl = {
  meta: {
    name: 'report_asset',
    description: 'Report a discovered asset (domain or IP) to the platform inventory.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['domain', 'ip'] },
        value: { type: 'string', description: 'Domain name or IP address.' },
        tags: { type: 'array', items: { type: 'string' } },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              label: { type: 'string' },
            },
            required: ['path'],
          },
        },
      },
      required: ['kind', 'value'],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      ReportAsset.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) {
          return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        }
        const service = getSecurityOpsService(ctx);
        const context = resolveSecurityOpsToolContext(ctx);
        const workspaceDir = resolveToolWorkspaceDir(ctx);
        try {
          await hydrateRemoteEvidenceFiles(ctx, args);
          const result = await service.reportAsset({
            userId,
            sessionId: ctx.sessionId,
            workspaceDir,
            context,
            input: args,
          });
          await recordInventoryProgress(ctx, {
            assetsCreated: result.created ? 1 : 0,
            assetsTouched: result.created ? 0 : 1,
          });
          if (result.created) {
            emitSecurityOpsTimeline(ctx, {
              kind: 'securityops',
              status: 'success',
              title: 'Asset discovered',
              detail: `${getString((args as Record<string, unknown>)?.kind) ?? 'asset'}:${getString((args as Record<string, unknown>)?.value) ?? ''}`,
              importance: 'high',
              relatedIds: buildSecurityOpsRelatedIds(context, result as Record<string, unknown>),
            });
          }
          return {
            ok: true,
            data: await attachProjectionWarning({
              ctx,
              data: result as Record<string, unknown>,
              reason: 'report_asset',
              scopes: ['recon', 'model'],
            }),
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['kind', 'value']),
    );
  },
};


export const ReportService: ToolImpl = {
  meta: {
    name: 'report_service',
    description: 'Report a discovered service on an asset (port, protocol, product info).',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        assetRef: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['domain', 'ip'] },
            value: { type: 'string' },
          },
          required: ['kind', 'value'],
        },
        hostname: {
          type: 'string',
          description:
            'Optional service host when assetRef points at a parent domain (example: api.example.com for example.com).',
        },
        protocol: { type: 'string', enum: ['tcp', 'udp', 'http', 'https'] },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        serviceName: { type: 'string' },
        product: { type: 'string' },
        version: { type: 'string' },
        versionReadMethod: {
          type: 'string',
          enum: [
            'http_banner',
            'service_probe',
            'application_fingerprint',
            'error_behavior',
            'tls_fingerprint',
          ],
          description:
            'For a query_inventory version-acquisition objective, copy its recommendedMethod exactly, including when the attempt found no version.',
        },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              label: { type: 'string' },
            },
            required: ['path'],
          },
        },
      },
      required: ['assetRef', 'protocol', 'port'],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      ReportService.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) {
          return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        }
        const service = getSecurityOpsService(ctx);
        const context = resolveSecurityOpsToolContext(ctx);
        const workspaceDir = resolveToolWorkspaceDir(ctx);
        try {
          await hydrateRemoteEvidenceFiles(ctx, args);
          const result = await service.reportService({
            userId,
            sessionId: ctx.sessionId,
            workspaceDir,
            context,
            input: args,
          });
          await recordInventoryProgress(ctx, {
            servicesCreated: result.created ? 1 : 0,
            servicesTouched: result.created ? 0 : 1,
          });
          if (result.created) {
            const input = args as Record<string, unknown>;
            emitSecurityOpsTimeline(ctx, {
              kind: 'securityops',
              status: 'success',
              title: 'Service recorded',
              detail: `${getString(input.protocol) ?? 'service'}:${String(input.port ?? '')}${getAssetRefLabel(input.assetRef) ? ` on ${getAssetRefLabel(input.assetRef)}` : ''}`,
              importance: 'medium',
              relatedIds: buildSecurityOpsRelatedIds(context, result as Record<string, unknown>),
            });
          }
          return {
            ok: true,
            data: await attachProjectionWarning({
              ctx,
              data: result as Record<string, unknown>,
              reason: 'report_service',
              scopes: ['recon', 'model'],
            }),
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['assetRef', 'hostname', 'port', 'protocol']),
    );
  },
};


export const ReportNote: ToolImpl = {
  meta: {
    name: 'report_note',
    description: 'Report a structured observation note, including endpoint, subdomain, tech, DNS, HTTP, TLS, and run-memory observations.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        assetRef: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['domain', 'ip'] },
            value: { type: 'string' },
          },
          required: ['kind', 'value'],
        },
        ntype: { type: 'string', description: 'Observation type, e.g. approach.tried, approach.blocker, run.digest, dns.subdomain, http.endpoint, tech.fingerprint' },
        title: { type: 'string' },
        data: {
          type: 'object',
          description: REPORT_NOTE_DATA_GUIDANCE,
          additionalProperties: true
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              label: { type: 'string' },
              excerpt: { type: 'string' },
            },
            required: ['path'],
          },
        },
      },
      required: ['ntype'],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      ReportNote.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) {
          return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        }
        const service = getSecurityOpsService(ctx);
        const context = resolveSecurityOpsToolContext(ctx);
        const workspaceDir = resolveToolWorkspaceDir(ctx);
        try {
          const coverageDowngrade = downgradeCompletedScanCoverageForActiveJobs(args, ctx);
          const session = getSessionFromContext(ctx);
          const securityopsFlags = isRecord(session?.flags?.securityops) ? session.flags.securityops : undefined;
          const inputRecord = isRecord(args) ? args : {};
          const inputData = isRecord(inputRecord.data) ? inputRecord.data : {};
          const flagWorkflowDiscipline = getString(securityopsFlags?.workflowDiscipline)?.toLowerCase();
          const inputWorkflowDiscipline = getString(inputData.workflowDiscipline)?.toLowerCase();
          const workflowDiscipline =
            flagWorkflowDiscipline === 'compliance' ||
            inputWorkflowDiscipline === 'compliance' ||
            securityopsFlags?.complianceAssessment
              ? 'compliance'
              : 'pentest';
          let noteArgs = coverageDowngrade.args;
          const noteRecord = isRecord(noteArgs) ? noteArgs : undefined;
          const noteNtype = getString(noteRecord?.ntype)?.toLowerCase();
          if (noteNtype === 'run.digest') {
            const existingData = isRecord(noteRecord?.data) ? noteRecord.data : {};
            const complianceAssessment = isRecord(securityopsFlags?.complianceAssessment)
              ? securityopsFlags.complianceAssessment
              : undefined;
            const activeFramework = getString(complianceAssessment?.framework) ?? getString(context.complianceReport?.framework);
            noteArgs = {
              ...(noteRecord ?? {}),
              data: {
                ...existingData,
                workflowDiscipline: getString(existingData.workflowDiscipline) ?? workflowDiscipline,
                ...(workflowDiscipline === 'compliance' && activeFramework
                  ? { frameworkKey: getString(existingData.frameworkKey) ?? activeFramework }
                  : {}),
              },
            };
          }
          if (noteNtype === 'report.section') {
            const sectionData = isRecord(noteRecord?.data) ? noteRecord.data : undefined;
            const sectionFailures = await collectMermaidFieldFailures(sectionData, ['content']);
            if (sectionFailures.length > 0) {
              return { ok: false, data: { error: buildMermaidRejectionError(sectionFailures) } };
            }
          }
          await hydrateRemoteEvidenceFiles(ctx, noteArgs);
          const result = await service.reportNote({
            userId,
            sessionId: ctx.sessionId,
            workspaceDir,
            context,
            input: noteArgs,
          });
          const input = noteArgs as Record<string, unknown>;
          const ntype = getString(input.ntype)?.toLowerCase();
          const data = isRecord(input.data) ? input.data : {};
          const attachNoteProjection = (payload: Record<string, unknown>) =>
            attachProjectionWarning({
              ctx,
              data: payload,
              reason: `report_note:${ntype ?? 'unknown'}`,
              scopes: [...projectionScopesForNote(ntype)],
            });
          await recordInventoryProgress(ctx, {
            noteType: ntype,
            ...(ntype === 'scan.coverage'
              ? { coverageStatus: getString(data.status)?.toLowerCase() }
              : {}),
          });
          if (result.created) {
            if (ntype === 'approach.blocker') {
              emitSecurityOpsTimeline(ctx, {
                kind: 'securityops',
                status: 'error',
                title: 'Testing blocked',
                detail:
                  getString(data.blocker_reason) ??
                  getString(data.reason) ??
                  getString(data.target),
                importance: 'high',
                relatedIds: buildNoteRelatedIds(context, result as Record<string, unknown>, ntype),
              });
            } else if (ntype === 'http.endpoint') {
              emitSecurityOpsTimeline(ctx, {
                kind: 'securityops',
                status: 'success',
                title: 'Endpoint recorded',
                detail: getString(data.url),
                importance: 'medium',
                relatedIds: buildNoteRelatedIds(context, result as Record<string, unknown>, ntype),
              });
            } else if (ntype === 'dns.subdomain') {
              emitSecurityOpsTimeline(ctx, {
                kind: 'securityops',
                status: 'success',
                title: 'Subdomain discovered',
                detail: getString(data.hostname),
                importance: 'high',
                relatedIds: buildNoteRelatedIds(context, result as Record<string, unknown>, ntype),
              });
            } else if (ntype === 'tech.fingerprint') {
              emitSecurityOpsTimeline(ctx, {
                kind: 'securityops',
                status: 'success',
                title: 'Technology fingerprinted',
                detail: [getString(data.product), getString(data.version)].filter(Boolean).join(' '),
                importance: 'medium',
                relatedIds: buildNoteRelatedIds(context, result as Record<string, unknown>, ntype),
              });
            } else if (ntype === 'scan.coverage') {
              const blocked = getString(data.status)?.toLowerCase() === 'blocked';
              emitSecurityOpsTimeline(ctx, {
                kind: 'securityops',
                status: blocked ? 'error' : 'success',
                title: blocked ? 'Coverage blocked' : 'Coverage completed',
                detail:
                  getString(data.reason) ??
                  getAssetRefLabel(input.assetRef) ??
                  getString(data.family),
                importance: blocked ? 'high' : 'medium',
                relatedIds: buildNoteRelatedIds(context, result as Record<string, unknown>, ntype),
              });
            } else if (ntype === 'run.digest') {
              emitSecurityOpsTimeline(ctx, {
                kind: 'securityops',
                status: 'success',
                title: 'Run digest saved',
                detail: getString(data.outcome),
                importance: 'medium',
                relatedIds: buildNoteRelatedIds(context, result as Record<string, unknown>, ntype),
              });
            }
          }

          // Zero-finding gate: warn when run.digest is written with no findings filed this session.
          const digestNtype = getString((noteArgs as Record<string, unknown>).ntype)?.toLowerCase();
          if (digestNtype === 'run.digest') {
            const reportFindingCount =
              typeof securityopsFlags?.reportFindingCount === 'number' ? securityopsFlags.reportFindingCount : 0;
            if (workflowDiscipline !== 'compliance' && reportFindingCount === 0) {
              emitSecurityOpsTimeline(ctx, {
                kind: 'securityops',
                status: 'error',
                title: 'Run digest: zero findings filed',
                detail:
                  'No report_finding calls were made in this session. Evaluate any high-signal discoveries against the triage gate before completing.',
                importance: 'high',
                relatedIds: buildSecurityOpsRelatedIds(context, result as Record<string, unknown>),
              });
              return {
                ok: true,
                data: await attachNoteProjection({
                  ...result,
                  warning:
                    'Zero findings filed in this session. If any Tier 1 or Tier 2 signals were discovered ' +
                    '(suspicious endpoint names, EOL products, unauthenticated sensitive actions, accessible management panels), ' +
                    'evaluate them against the DISCOVERY TRIAGE GATE in your instructions before completing.',
                }),
              };
            }
          }

          if (coverageDowngrade.warning) {
            return {
              ok: true,
              data: await attachNoteProjection({
                success: true,
                ...result,
                ...(result.created === false
                  ? {
                      alreadyExists: true,
                      satisfied: true,
                    }
                  : {}),
                warning: coverageDowngrade.warning,
              }),
            };
          }

          return {
            ok: true,
            data: await attachNoteProjection({
              success: true,
              ...result,
              ...(result.created === false
                ? {
                    alreadyExists: true,
                    satisfied: true,
                  }
                : {}),
            }),
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['assetRef', 'ntype', 'title']),
    );
  },
};


export const ReportFinding: ToolImpl = {
  meta: {
    name: 'report_finding',
    description:
      'Record a candidate security finding from a suspicious observation. CANDIDATES ARE NOT EXPLOITS - file at observation level (response variance across IDs, sensitive content disclosure, header/method tamper accepted, user enumeration, framework leak). Heavy fields (businessImpact, technicalAnalysis, pocDescription, pocScriptCode, assumptions, fixEffort, remediation, cvss, cweIds) are OPTIONAL at candidate state. Validation records proof state; final report mode requires canonical businessImpact, technicalAnalysis, pocDescription, assumptions, and remediation. If preflight reports missingReportFields, repair the existing row with report_finding(validatesFindingId=...) using evidence-specific prose. In the reporting phase this tool is repair-only: validatesFindingId is required and new findings are rejected. If you observed a signal a senior pentester would interrogate, FILE A CANDIDATE - recording it as approach.tried is a misuse.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        assetRef: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['domain', 'ip'] },
            value: { type: 'string' },
          },
          required: ['kind', 'value'],
        },
        title: { type: 'string' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
        summary: { type: 'string', description: 'Short operator-facing TL;DR of the finding and why it matters.' },
        businessImpact: { type: 'string', description: 'What an attacker can achieve and the business consequence: data exposure, account takeover, financial loss, compliance breach, etc.' },
        technicalAnalysis: { type: 'string', description: 'Deep technical explanation of the root cause, exploit path, and evidence chain.' },
        pocDescription: { type: 'string', description: 'Structured reproduction steps only. Keep raw exploit code out of this field.' },
        pocScriptCode: { type: 'string', description: 'Actual PoC or exploit code used to demonstrate the issue.' },
        assumptions: { type: 'string', description: 'Exploit prerequisites and attacker assumptions required for the issue to work.' },
        fixEffort: { type: 'string', enum: ['trivial', 'low', 'medium', 'high'] },
        remediation: { type: 'string', description: 'Concrete fix steps: config change, patch version, code pattern, or control to apply.' },
        cvss: {
          type: 'object',
          description: 'CVSS v3.1 base metrics. Always required — used to compute the numeric score and vector string. Choose values that reflect the worst-case realistic exploit path (e.g. AV:N if exploitable over the internet, PR:N if no auth required).',
          properties: {
            attackVector: { type: 'string', enum: ['N', 'A', 'L', 'P'] },
            attackComplexity: { type: 'string', enum: ['L', 'H'] },
            privilegesRequired: { type: 'string', enum: ['N', 'L', 'H'] },
            userInteraction: { type: 'string', enum: ['N', 'R'] },
            scope: { type: 'string', enum: ['U', 'C'] },
            confidentiality: { type: 'string', enum: ['N', 'L', 'H'] },
            integrity: { type: 'string', enum: ['N', 'L', 'H'] },
            availability: { type: 'string', enum: ['N', 'L', 'H'] },
          },
          required: [
            'attackVector',
            'attackComplexity',
            'privilegesRequired',
            'userInteraction',
            'scope',
            'confidentiality',
            'integrity',
            'availability',
          ],
        },
        cweId: { type: 'string' },
        cveId: { type: 'string' },
        cweIds: { type: 'array', items: { type: 'string' }, description: 'One or more CWE IDs classifying the root cause (e.g. ["CWE-79", "CWE-116"]). Always required — provide at least one.' },
        cveIds: { type: 'array', items: { type: 'string' }, description: 'Known CVE IDs if the finding is for a specific disclosed vulnerability. Omit if not applicable.' },
        owaspCategory: { type: 'string' },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Finding confidence score from 0.0 (heuristic) to 1.0 (confirmed exploitable).',
        },
        evidence: {
          type: 'array',
          items: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  label: { type: 'string' },
                  excerpt: { type: 'string' },
                },
                required: ['path'],
              },
              {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['http_exchange'] },
                  label: { type: 'string' },
                  source: { type: 'string', enum: ['browser', 'request_tool', 'manual', 'unknown'] },
                  durationMs: { type: 'number', minimum: 0 },
                  request: {
                    type: 'object',
                    properties: {
                      method: { type: 'string' },
                      url: { type: 'string' },
                      contentType: { type: 'string' },
                      headers: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            name: { type: 'string' },
                            value: { type: 'string' },
                            redacted: { type: 'boolean' },
                          },
                          required: ['name', 'value'],
                        },
                      },
                      body: { type: 'string' },
                    },
                    required: ['method', 'url'],
                  },
                  response: {
                    type: 'object',
                    properties: {
                      statusCode: { type: 'integer' },
                      contentType: { type: 'string' },
                      headers: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            name: { type: 'string' },
                            value: { type: 'string' },
                            redacted: { type: 'boolean' },
                          },
                          required: ['name', 'value'],
                        },
                      },
                      body: { type: 'string' },
                    },
                    required: ['statusCode'],
                  },
                },
                required: ['kind', 'request', 'response'],
              },
            ],
          },
          minItems: 1,
        },
        codeLocations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              pathKind: { type: 'string', enum: ['repository', 'workspace'] },
              repository: { type: 'string', nullable: true },
              ref: { type: 'string', nullable: true },
              filePath: { type: 'string' },
              startLine: { type: 'integer', minimum: 1 },
              endLine: { type: 'integer', minimum: 1 },
              label: { type: 'string', nullable: true },
              fixBefore: { type: 'string' },
              fixAfter: { type: 'string' },
            },
            required: ['pathKind', 'filePath', 'startLine', 'endLine', 'fixBefore', 'fixAfter'],
          },
        },
        endpointRef: { type: 'string', description: 'Optional endpoint ID if finding is endpoint-specific.' },
        serviceRef: { type: 'string', description: 'Optional service ID if finding is service-specific.' },
        validatesFindingId: { type: 'string', description: 'ID of an existing finding this call validates or repairs. When provided, fresh evidence is attached to that finding directly, bypassing title deduplication. In reporting, this field is required and report_finding may only backfill final-report fields on an existing row.' },
        signalClass: {
          type: 'string',
          enum: [
            'sensitive-content-disclosure',
            'id-variance-with-pii',
            'id-variance-without-pii',
            'open-redirect-accepted',
            'user-enum-confirmed',
            'user-enum-undifferentiated',
            'auth-tamper-accepted',
            'framework-leak',
            'header-tamper-accepted',
            'method-tamper-accepted',
            'mass-assignment-accepted',
            'unauthenticated-state-change',
            'response-variance',
            'waf-detected',
            'other',
          ],
          description: 'Adversarial-reasoning signal class that justifies filing this candidate. Pick the closest match. Optional but strongly recommended for observation-level candidates.',
        },
        hypothesis: {
          type: 'string',
          description: 'One sentence: what attack class you suspected and what evidence triggered the candidate. Surface for validation prioritization.',
        },
        differentialEvidence: {
          type: 'array',
          description: 'Optional array of differential observations recorded with http_differential (or equivalent manual probes). Each entry pairs a baseline value with an observed value and the signal that diverged.',
          items: {
            type: 'object',
            properties: {
              parameter: { type: 'string' },
              baselineValue: {},
              observedValue: {},
              signal: { type: 'string', enum: ['status', 'body_length', 'body_diff', 'response_time', 'headers', 'set'] },
              delta: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['parameter', 'observedValue', 'signal'],
          },
        },
        observationLeadId: {
          type: 'string',
          description: 'UUID of the validation.lead note this candidate is anchored to, if any. Helps validation phase map candidates back to their leads.',
        },
      },
      required: [
        'assetRef',
        'title',
        'severity',
        'summary',
        'evidence',
      ],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      ReportFinding.meta,
      ctx,
      async () => {
        const context = resolveSecurityOpsToolContext(ctx);
        const workspaceDir = resolveToolWorkspaceDir(ctx);
        try {
          const mermaidFailures = await collectMermaidFieldFailures(
            isRecord(args) ? args : undefined,
            REPORT_FINDING_MERMAID_FIELDS,
          );
          if (mermaidFailures.length > 0) {
            return { ok: false, data: { error: buildMermaidRejectionError(mermaidFailures) } };
          }
          const session = getSessionFromContext(ctx);
          const hostedRun = context.runHost === 'research_lab'
            ? getHostedRunPersistencePort(context.runId)
            : null;
          if (hostedRun) {
            if (!isRecord(args)) {
              return { ok: false, data: { error: 'report_finding requires an object payload' } };
            }
            const result = await hostedRun.reportFinding({
              runId: hostedRun.runId,
              sessionId: ctx.sessionId,
              workerType: session?.coordination?.workerType,
              input: args,
            });
            await recordReportedFinding(ctx, result);
            return { ok: true, data: result };
          }
          const userId = requireUserId(ctx);
          if (!userId) {
            return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
          }
          const service = getSecurityOpsService(ctx);
          await hydrateRemoteEvidenceFiles(ctx, args);
          const result = await service.reportFinding({
            userId,
            sessionId: ctx.sessionId,
            workspaceDir,
            context,
            input: args,
            workerTasks: session?.workerTasks,
            turnNumber: ctx.turnNumber,
            abortSignal: ctx.abortSignal,
            executeModelCall: ctx.executeModelCall,
          });
          await recordReportedFinding(ctx, result);
          if (!result.created && isRecord(result.dedupe) && ctx.trace) {
            void ctx.trace
              .write(ctx.sessionId, ctx.turnNumber ?? 0, {
                event: 'report_finding.dedupe_merged',
                severity: Array.isArray(result.warnings) && result.warnings.length > 0 ? 'warn' : 'info',
                payload: {
                  findingId: result.findingId,
                  dedupe: result.dedupe,
                  warnings: result.warnings ?? [],
                },
                note: `report_finding merged with ${getString(result.dedupe.matchedBy) ?? 'dedupe'}`,
              })
              .catch(() => {});
          }
          if (result.created) {
            const input = args as Record<string, unknown>;
            const severity = getString(input.severity)?.toLowerCase() ?? 'new';
            emitSecurityOpsTimeline(ctx, {
              kind: 'securityops',
              status: 'success',
              title: `New ${severity} finding`,
              detail: getString(input.title),
              importance: 'high',
              relatedIds: buildSecurityOpsRelatedIds(context, result as Record<string, unknown>),
            });
          }
          return {
            ok: true,
            data: await attachProjectionWarning({
              ctx,
              data: result as Record<string, unknown>,
              reason: 'report_finding',
              scopes: ['findings', 'evidence', 'leads', 'model'],
            }),
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['assetRef', 'title', 'severity']),
    );
  },
};

