import { z } from 'zod';

export const FindingIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
});

const FindingEndpointContextSchema = z.object({
  id: z.string().uuid(),
  url: z.string(),
  method: z.string(),
});

const FindingServiceContextSchema = z.object({
  id: z.string().uuid(),
  protocol: z.string(),
  port: z.number(),
  serviceName: z.string().nullable(),
  product: z.string().nullable(),
  version: z.string().nullable(),
});

const FindingCodeLocationSchema = z.object({
  pathKind: z.enum(['repository', 'workspace']),
  repository: z.string().nullable(),
  ref: z.string().nullable(),
  filePath: z.string(),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  label: z.string().nullable(),
  fixBefore: z.string(),
  fixAfter: z.string(),
});

const HttpHeaderSchema = z.object({
  name: z.string(),
  value: z.string(),
  redacted: z.boolean().optional(),
});

const HttpBodyPreviewSchema = z.object({
  text: z.string(),
  truncated: z.boolean(),
});

const FindingHttpExchangeSchema = z.object({
  source: z.enum(['browser', 'request_tool', 'manual', 'unknown']).optional(),
  durationMs: z.number().nullable().optional(),
  request: z.object({
    method: z.string(),
    url: z.string(),
    contentType: z.string().nullable().optional(),
    headers: z.array(HttpHeaderSchema).optional(),
    body: HttpBodyPreviewSchema.nullable().optional(),
  }),
  response: z.object({
    statusCode: z.number().int(),
    contentType: z.string().nullable().optional(),
    headers: z.array(HttpHeaderSchema).optional(),
    body: HttpBodyPreviewSchema.nullable().optional(),
  }),
});

const ArtifactFindingEvidenceSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('artifact'),
  path: z.string(),
  displayPath: z.string(),
  label: z.string().optional(),
  excerpt: z.string().optional(),
  fileMissing: z.boolean(),
  sessionId: z.string().uuid().optional(),
  artifactId: z.string().uuid().optional(),
  downloadPath: z.string().optional(),
  createdAt: z.string().nullable().optional(),
});

const HttpExchangeFindingEvidenceSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('http_exchange'),
  path: z.string(),
  displayPath: z.string(),
  label: z.string().optional(),
  createdAt: z.string().nullable().optional(),
  http: FindingHttpExchangeSchema,
});

export const FindingEvidenceResponseSchema = z.union([
  ArtifactFindingEvidenceSchema,
  HttpExchangeFindingEvidenceSchema,
]);

export const FindingReviewMetaSchema = z.object({
  codeLocationCount: z.number().int().min(0),
  copyFixPromptReady: z.boolean(),
  evidenceSummary: z.object({
    total: z.number().int().min(0),
    artifactCount: z.number().int().min(0),
    downloadableArtifactCount: z.number().int().min(0),
    structuredHttpCount: z.number().int().min(0),
    excerptCount: z.number().int().min(0),
    fileMissingCount: z.number().int().min(0),
  }),
});

export const FindingDetailSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    severity: z.string(),
    state: z.enum(['potential', 'verifying', 'confirmed', 'not_reproduced', 'dismissed', 'resolved', 'accepted']),
    assignedTo: z.string().uuid().nullable().optional(),
    assetId: z.string().uuid().nullable(),
    assetValue: z.string(),
    assetKind: z.string(),
    scopeId: z.string().uuid().nullable(),
    scopeName: z.string(),
    summary: z.string().nullable(),
    businessImpact: z.string().nullable(),
    technicalAnalysis: z.string().nullable().optional(),
    pocDescription: z.string().nullable().optional(),
    pocScriptCode: z.string().nullable().optional(),
    remediation: z.string().nullable(),
    assumptions: z.string().nullable().optional(),
    fixEffort: z.enum(['trivial', 'low', 'medium', 'high']).nullable().optional(),
    confidence: z.number().nullable().optional(),
    evidenceCount: z.number().int().min(0).optional(),
    cvssVector: z.string().nullable().optional(),
    cvssScore: z.number().nullable().optional(),
    cweId: z.string().nullable(),
    cveId: z.string().nullable(),
    cweIds: z.array(z.string()).nullable().optional(),
    cveIds: z.array(z.string()).nullable().optional(),
    owaspCategory: z.string().nullable().optional(),
    endpoint: FindingEndpointContextSchema.nullable().optional(),
    service: FindingServiceContextSchema.nullable().optional(),
    codeLocations: z.array(FindingCodeLocationSchema),
    reviewMeta: FindingReviewMetaSchema,
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
    createdAt: z.string(),
  })
  .passthrough();
