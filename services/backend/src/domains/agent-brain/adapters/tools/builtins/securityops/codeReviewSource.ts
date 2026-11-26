import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import type { CodeReviewContext } from '@/db/schema';
import {
  getHostedRunPersistencePort,
  type HostedRunPersistencePort,
} from '@/domains/security-ops/runs/HostedRunPersistencePort';
import { parseHostedRepositoryManifest } from '@/domains/security-ops/runs/hostedCodeReviewContext';
import { buildCodeReviewManifestHash } from '@/domains/security-ops/runs/codeReviewRunContext';
import { getSecurityOpsService } from '../securityopsServiceRegistry';

// Marker for ToolManifestRegistry: this is a helper module, not a tool module.
export const __skipToolManifest = true as const;

export type CodeReviewManifestResult = {
  repositoryId: string;
  repository: string;
  ref: string;
  files: Array<{ path: string; blobSha: string; size?: number | null }>;
  completeness: 'complete' | 'partial';
};

/**
 * Where a Code Review run reads source from.
 *
 * The product reads the scope's code source (a local folder, or a git clone
 * read at its pinned commit). A hosted Research Lab run resolves a pinned local clone
 * through its persistence port. Both return Git blob object ids, so the
 * revision-compatibility model and memory anchors are identical across hosts.
 *
 * Neither implementation can widen the run's authority: the caller still
 * validates every path and ref against the immutable typed context.
 */
export type CodeReviewRepositorySource = {
  readonly kind: 'connected_github' | 'hosted_local_clone';
  listFiles(): Promise<CodeReviewManifestResult>;
  readFile(params: { path: string; ref: string }): Promise<{ content: string }>;
};

type SecurityOpsToolContextLike = {
  organizationId?: string;
  scopeId?: string;
  runId?: string;
  runHost?: 'research_lab';
  codeReview?: CodeReviewContext;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hostedSource = (
  port: HostedRunPersistencePort,
): CodeReviewRepositorySource => ({
  kind: 'hosted_local_clone',
  async listFiles() {
    return parseHostedRepositoryManifest(
      await port.queryRepository({ operation: 'manifest', input: {} }),
    );
  },
  async readFile(params) {
    const result = await port.queryRepository({
      operation: 'read',
      input: { path: params.path, ref: params.ref },
    });
    if (!isRecord(result) || typeof result.content !== 'string') {
      throw new Error(`Hosted repository read returned no content for ${params.path}`);
    }
    return { content: result.content };
  },
});

const connectedSource = (
  ctx: ToolContext,
  context: SecurityOpsToolContextLike & { codeReview: CodeReviewContext },
): CodeReviewRepositorySource => ({
  kind: 'connected_github',
  async listFiles() {
    const service = getSecurityOpsService(ctx);
    return service.listCodeReviewRepositoryFiles({
      context,
      input: {
        repository: context.codeReview.repository.repositoryId,
        ref: context.codeReview.repository.immutableCommitSha,
      },
    });
  },
  async readFile(params) {
    const service = getSecurityOpsService(ctx);
    return service.readConnectedRepositoryFile({
      context,
      input: {
        repository: context.codeReview.repository.repositoryId,
        path: params.path,
        ref: params.ref,
      },
    });
  },
});

export const resolveCodeReviewRepositorySource = (
  ctx: ToolContext,
  context: SecurityOpsToolContextLike & { codeReview: CodeReviewContext },
): CodeReviewRepositorySource => {
  if (context.runHost === 'research_lab') {
    const port = getHostedRunPersistencePort(context.runId);
    if (!port) {
      throw new Error('Hosted Code Review run has no registered persistence port');
    }
    return hostedSource(port);
  }
  return connectedSource(ctx, context);
};

/**
 * Resolve the manifest and prove it still matches the immutable run identity.
 *
 * Manifest drift is a hard failure in both hosts: a review that silently reads
 * a different file set than the one its context pins is unscoped.
 */
export const loadBoundCodeReviewManifest = async (
  ctx: ToolContext,
  context: SecurityOpsToolContextLike & { codeReview: CodeReviewContext },
): Promise<CodeReviewManifestResult> => {
  const source = resolveCodeReviewRepositorySource(ctx, context);
  const manifest = await source.listFiles();
  if (
    manifest.repositoryId !== context.codeReview.repository.repositoryId
    || manifest.ref.toLowerCase()
      !== context.codeReview.repository.immutableCommitSha.toLowerCase()
  ) {
    throw new Error('The resolved repository manifest does not match the immutable run identity');
  }
  const manifestHash = buildCodeReviewManifestHash({
    immutableCommitSha: manifest.ref,
    files: manifest.files,
    allowedPaths: context.codeReview.reviewScope.allowedPaths,
    excludedPaths: context.codeReview.reviewScope.excludedPaths,
  });
  if (manifestHash !== context.codeReview.reviewScope.manifestHash) {
    throw new Error('The repository manifest hash no longer matches the immutable run context');
  }
  return manifest;
};

export const requireHostedPort = (
  context: SecurityOpsToolContextLike,
): HostedRunPersistencePort | null => {
  if (context.runHost !== 'research_lab') return null;
  const port = getHostedRunPersistencePort(context.runId);
  if (!port) {
    throw new Error('Hosted Code Review run has no registered persistence port');
  }
  return port;
};
