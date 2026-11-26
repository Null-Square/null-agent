/**
 * SessionArtifactController - Handle session artifact operations
 * 
 * Routes:
 * - GET /sessions/:sessionId/artifacts - List artifacts
 * - GET /sessions/:sessionId/artifacts/:artifactId/download - Download artifact
 * - GET /sessions/:sessionId/report - Get report
 * - GET /sessions/:sessionId/report/pdf - Generate PDF report
 * - POST /sessions/:sessionId/files - Upload files
 */

import { type Request, type Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import {
  BaseSessionController,
  type SessionControllerContext,
  type AuthenticatedRequest,
  type SessionArtifact,
  type SessionState,
} from './types';
import { ensureSessionAccess, ensureSessionExists } from '../routes/helpers/sessionAccess';
import { ErrorFactory } from '@/shared/errors';
import { parseS3Uri } from '@/shared/storage/s3Utils';

const artifactIdentity = (artifact: { id?: string; filePath: string; originalName?: string }): string => {
  const originalName = artifact.originalName?.trim().toLowerCase();
  if (originalName) {
    return `name:${originalName}`;
  }
  const filePath = artifact.filePath.trim().toLowerCase();
  if (filePath) {
    return `path:${filePath}`;
  }
  return `id:${artifact.id ?? ''}`;
};

export class SessionArtifactController extends BaseSessionController {
  constructor(context: SessionControllerContext) {
    super(context);
  }

  private isInsideRoot(targetPath: string, rootPath: string): boolean {
    const relative = path.relative(rootPath, targetPath);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  private resolveSafeLocalArtifactPath(
    artifact: SessionArtifact,
    session?: SessionState,
  ): string {
    const candidates: Array<{ absolutePath: string; root: string }> = [];
    const storageRoot = this.ctx.artifactStorageRoot;
    const workspaceRoot = session?.workspaceDir;

    if (path.isAbsolute(artifact.filePath)) {
      if (this.isInsideRoot(artifact.filePath, storageRoot)) {
        candidates.push({ absolutePath: artifact.filePath, root: storageRoot });
      }
      if (workspaceRoot && this.isInsideRoot(artifact.filePath, workspaceRoot)) {
        candidates.push({ absolutePath: artifact.filePath, root: workspaceRoot });
      }
    } else {
      const storagePath = path.resolve(storageRoot, artifact.filePath);
      if (this.isInsideRoot(storagePath, storageRoot)) {
        candidates.push({ absolutePath: storagePath, root: storageRoot });
      }

      if (workspaceRoot) {
        const workspacePath = path.resolve(workspaceRoot, artifact.filePath);
        if (this.isInsideRoot(workspacePath, workspaceRoot)) {
          candidates.push({ absolutePath: workspacePath, root: workspaceRoot });
        }
      }
    }

    if (candidates.length === 0) {
      throw ErrorFactory.auth.insufficientPermissions('artifact', {
        context: { path: artifact.filePath, message: 'Artifact path escapes allowed storage roots' },
      });
    }

    const existing = candidates.find((candidate) => fs.existsSync(candidate.absolutePath));
    if (!existing) {
      throw ErrorFactory.resource.notFound('artifact', artifact.id);
    }

    return existing.absolutePath;
  }

  private async resolveSessionOwner(
    sessionId: string,
    req: AuthenticatedRequest,
  ): Promise<SessionState | undefined> {
    const session = this.services.sessionStore.get(sessionId);
    if (session) {
      ensureSessionExists(session, sessionId);
      ensureSessionAccess(session, req);
      return session;
    }

    const row = await this.sessionRepository.findById(sessionId);
    if (!row) {
      throw ErrorFactory.session.notFound(sessionId);
    }
    const requester = req.user?.id;
    if (row.userId && requester && row.userId !== requester) {
      throw ErrorFactory.auth.insufficientPermissions('session', { context: { sessionId, userId: requester } });
    }
    return undefined;
  }

  private async getArtifactsForSession(
    sessionId: string,
    session?: SessionState,
  ): Promise<SessionArtifact[]> {
    const persistedArtifacts = (await this.ctx.artifactRepository.listBySession(sessionId))
      .map((row) => this.responseBuilder.adaptArtifactRow(row));
    const liveArtifacts = Array.isArray(session?.artifacts)
      ? session.artifacts.map((artifact) => this.responseBuilder.adaptArtifactRow(artifact))
      : [];

    if (liveArtifacts.length === 0) {
      return persistedArtifacts;
    }
    if (persistedArtifacts.length === 0) {
      return liveArtifacts;
    }

    const merged = new Map<string, SessionArtifact>();
    for (const artifact of liveArtifacts) {
      merged.set(artifactIdentity(artifact), artifact);
    }
    for (const artifact of persistedArtifacts) {
      const key = artifactIdentity(artifact);
      if (!merged.has(key)) {
        merged.set(key, artifact);
      }
    }
    return Array.from(merged.values());
  }

  async findArtifactByName(
    sessionId: string,
    req: AuthenticatedRequest,
    originalName: string,
  ): Promise<{ session?: SessionState; artifact?: SessionArtifact }> {
    const session = await this.resolveSessionOwner(sessionId, req);
    const artifacts = await this.getArtifactsForSession(sessionId, session);
    const target = originalName.toLowerCase();
    const artifact = artifacts.find((item) => item.originalName?.toLowerCase() === target);
    return { session, artifact };
  }

  async resolveArtifactsForSession(
    sessionId: string,
    req: AuthenticatedRequest,
  ): Promise<{ session?: SessionState; artifacts: SessionArtifact[] }> {
    const session = await this.resolveSessionOwner(sessionId, req);
    const artifacts = await this.getArtifactsForSession(sessionId, session);
    return { session, artifacts };
  }

  async readArtifactBuffer(
    artifact: SessionArtifact,
    session?: SessionState,
  ): Promise<Buffer> {
    const parsedS3 = parseS3Uri(artifact.filePath);
    if (parsedS3 && this.ctx.s3Artifacts && parsedS3.bucket === this.ctx.s3Artifacts.getBucket()) {
      return this.ctx.s3Artifacts.getObjectBuffer(parsedS3.key);
    }

    const targetPath = this.resolveSafeLocalArtifactPath(artifact, session);
    return fs.promises.readFile(targetPath);
  }

  /**
   * GET /sessions/:sessionId/artifacts - List artifacts
   */
  async listArtifacts(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    const authedReq = req as AuthenticatedRequest;

    await this.resolveSessionOwner(sessionId, authedReq);
    res.status(200).json({ artifacts: [] });
  }

  /**
   * GET /sessions/:sessionId/artifacts/:artifactId/download - Download artifact
   */
  async downloadArtifact(req: Request, res: Response): Promise<void> {
    const { sessionId, artifactId } = req.params;
    const authedReq = req as AuthenticatedRequest;
    
    const session = await this.resolveSessionOwner(sessionId, authedReq);
    const artifacts = await this.getArtifactsForSession(sessionId, session);
    const artifact = artifacts.find((item) => item.id === artifactId);
    if (!artifact) {
      throw ErrorFactory.resource.notFound('artifact', artifactId, { context: { sessionId } });
    }

    const parsedS3 = parseS3Uri(artifact.filePath);
    if (parsedS3 && this.ctx.s3Artifacts && parsedS3.bucket === this.ctx.s3Artifacts.getBucket()) {
      try {
        const buffer = await this.ctx.s3Artifacts.getObjectBuffer(parsedS3.key);
        const filename = path.basename(artifact.originalName ?? artifact.id);
        res.setHeader('Content-Type', artifact.fileType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
        res.setHeader('Content-Length', String(buffer.length));
        res.status(200).send(buffer);
        return;
      } catch (error) {
        this.log.warn(
          { err: error, sessionId, artifactId, filePath: artifact.filePath },
          'Failed to stream S3 artifact via proxy; falling back to local storage',
        );
      }
    }

    const targetPath = this.resolveSafeLocalArtifactPath(artifact, session);
    res.download(targetPath, artifact.originalName ?? artifact.id);
  }

  /**
   * GET /sessions/:sessionId/artifacts/:artifactId/content - Get artifact content
   */
  async getArtifactContent(req: Request, _res: Response): Promise<void> {
    const { sessionId } = req.params;
    const authedReq = req as AuthenticatedRequest;

    await this.resolveSessionOwner(sessionId, authedReq);
    throw ErrorFactory.auth.insufficientPermissions('artifact raw content', {
      context: {
        sessionId,
        message: 'Raw artifact content is not exposed through the app API.',
      },
    });
  }

  /**
   * GET /sessions/:sessionId/report - Get report content
   */
  async getReport(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    const authedReq = req as AuthenticatedRequest;
    
    const { artifact: reportArtifact } = await this.findArtifactByName(
      sessionId,
      authedReq,
      'report.md',
    );
    
    if (!reportArtifact) {
      throw ErrorFactory.resource.notFound('report', sessionId, { 
        context: { sessionId, message: 'No report.md artifact found for this session' } 
      });
    }

    try {
      const { content } = await this.responseBuilder.readArtifactContent(sessionId, reportArtifact);
      res.status(200).json({ report: content });
    } catch {
      throw ErrorFactory.resource.notFound('report', sessionId, { context: { sessionId } });
    }
  }
}
