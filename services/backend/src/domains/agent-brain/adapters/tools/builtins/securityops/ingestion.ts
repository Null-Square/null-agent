
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import { attachProjectionWarning } from '@/domains/security-ops/workspace/workspaceProjectionRuntime';
import { resolveSecurityOpsToolContext } from '../securityopsContext';
import { getSecurityOpsService } from '../securityopsServiceRegistry';

import {
  buildSecurityOpsRelatedIds,
  emitSecurityOpsTimeline,
  formatToolError,
  getString,
  hydrateRemoteWorkspaceFile,
  isRecord,
  pickToolArgsPreview,
  recordInventoryProgress,
  recordScannerIngestResolution,
  requireUserId,
  resolveToolWorkspaceDir
} from './shared';

export const IngestScanArtifact: ToolImpl = {
  meta: {
    name: 'ingest_scan_artifact',
    description:
      'Parse a scanner artifact and persist canonical inventory, scanner observations, and candidate findings through SecurityOps. Use this after wait_for_shell_job for supported scanner artifacts instead of manually re-parsing output every turn; set partial=true for partial output from a still-running or budget-exceeded scanner before waiting again.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        parser: {
          type: 'string',
          enum: [
            'subfinder',
            'naabu',
            'httpx',
            'nuclei',
            'sqlmap',
            'dalfox',
            'semgrep',
            'trivy',
            'gitleaks',
            'trufflehog',
            'nmap',
            'ffuf',
            'katana',
            'openapi',
          ],
        },
        artifactPath: {
          type: 'string',
          description: 'Workspace-relative or /workspace/... path to the completed scanner artifact. Optional when the artifact is under .artifacts/scans and can be discovered for the selected parser.',
        },
        rootAssetRef: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['domain', 'ip'] },
            value: { type: 'string' },
          },
          required: ['kind', 'value'],
        },
        partial: {
          type: 'boolean',
          description: 'Set true when ingesting partial scanner output from a still-running or budget-exceeded job before waiting again.',
        },
      },
      required: ['parser'],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      IngestScanArtifact.meta,
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
          const artifactPath = isRecord(args) ? getString(args.artifactPath) : undefined;
          if (artifactPath) {
            await hydrateRemoteWorkspaceFile(ctx, artifactPath, { required: true });
          }
          const result = await service.ingestScanArtifact({
            userId,
            sessionId: ctx.sessionId,
            workspaceDir,
            context,
            input: args,
          });
          await recordInventoryProgress(ctx, {
            assetsCreated: result.assetsCreated,
            assetsTouched: result.assetsTouched,
            servicesCreated: result.servicesCreated,
            servicesTouched: result.servicesTouched,
            subdomainNotesCreated: result.subdomainNotesCreated,
            subdomainNotesTouched: result.subdomainNotesTouched,
            endpointNotesCreated: result.endpointNotesCreated,
            endpointNotesTouched: result.endpointNotesTouched,
            techNotesCreated: result.techNotesCreated,
            techNotesTouched: result.techNotesTouched,
            ingestParser: result.parser,
            ingestSucceeded: true,
          });
          await recordScannerIngestResolution(ctx, result.parser, result.artifactPath, result.partial === true);
          emitSecurityOpsTimeline(ctx, {
            kind: 'securityops',
            status: 'success',
            title: 'Scanner artifact ingested',
            detail: `${result.parser}: ${result.artifactPath}`,
            importance: 'medium',
            relatedIds: buildSecurityOpsRelatedIds(context, {}),
          });
          return {
            ok: true,
            data: await attachProjectionWarning({
              ctx,
              data: result as Record<string, unknown>,
              reason: 'ingest_scan_artifact',
              scopes: ['recon', 'coverage', 'leads', 'findings', 'evidence', 'scanDigest', 'model'],
            }),
          };
        } catch (error) {
          await recordInventoryProgress(ctx, {
            ingestParser: isRecord(args) ? getString(args.parser) : undefined,
            ingestFailed: true,
            lastIngestError: formatToolError(error),
          });
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['parser', 'artifactPath', 'rootAssetRef']),
    );
  },
};

