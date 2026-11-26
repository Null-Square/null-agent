import type {
  IngestSummary,
  ScannerAssetRef,
  ScannerEvidenceRef,
  ScannerIngestorParams,
  ScannerParsedInput,
  ScannerResolvedArtifact,
} from '../types';

type OpenApiParameter = {
  name: string;
  in?: string;
};

type OpenApiValidationLead = Record<string, unknown>;

export type OpenApiIngestorContext<TContext = unknown> = {
  createIngestSummary: (parser: 'openapi', artifactPath: string) => IngestSummary;
  resolveScannerArtifactPath: (
    workspaceDir: string,
    parsed: ScannerParsedInput,
  ) => Promise<ScannerResolvedArtifact>;
  readOpenApiDocument: (artifact: ScannerResolvedArtifact) => Promise<Record<string, unknown>>;
  isRecord: (value: unknown) => value is Record<string, unknown>;
  getString: (value: unknown) => string | undefined;
  resolveOpenApiBaseUrl: (
    document: Record<string, unknown>,
    rootAssetRef?: ScannerAssetRef,
  ) => string | undefined;
  extractOpenApiParameters: (value: unknown) => OpenApiParameter[];
  extractOpenApiBodyParams: (operation: Record<string, unknown>) => string[];
  buildOpenApiEndpointUrl: (baseUrl: string | undefined, routePath: string) => string;
  assetRefFromScannerValue: (
    value: unknown,
    fallback?: ScannerAssetRef,
  ) => ScannerAssetRef | undefined;
  extractOpenApiStringArray: (value: unknown) => string[];
  describeOpenApiAuthHint: (
    document: Record<string, unknown>,
    operation: Record<string, unknown>,
  ) => string;
  deriveOpenApiValidationLeads: (params: {
    document: Record<string, unknown>;
    operation: Record<string, unknown>;
    method: string;
    routePath: string;
    endpointUrl: string;
    parameters: OpenApiParameter[];
    bodyParams: string[];
    artifactPath: string;
  }) => OpenApiValidationLead[];
  validationLeadCap: number;
  reportNote: (params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: TContext;
    input: unknown;
  }) => Promise<{ created: boolean }>;
};

const OPENAPI_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

export const ingestOpenApiArtifact = async <TContext = unknown>(
  params: ScannerIngestorParams<ScannerParsedInput, TContext>,
  ctx: OpenApiIngestorContext<TContext>,
): Promise<IngestSummary> => {
  const artifact = await ctx.resolveScannerArtifactPath(params.workspaceDir, params.parsed);
  const summary = ctx.createIngestSummary('openapi', artifact.relativePath);
  const document = await ctx.readOpenApiDocument(artifact);
  const paths = ctx.isRecord(document) && ctx.isRecord(document['paths']) ? document['paths'] : null;
  if (!paths) {
    throw new Error('ingest_scan_artifact(parser=openapi) requires an OpenAPI document with a top-level paths object.');
  }

  const baseUrl = ctx.resolveOpenApiBaseUrl(document, params.parsed.rootAssetRef);
  const evidence: ScannerEvidenceRef[] = [{ path: artifact.relativePath, label: 'OpenAPI artifact' }];
  const seenEndpoints = new Set<string>();
  const seenLeads = new Set<string>();
  let skippedValidationLeadCount = 0;

  for (const [routePath, pathItem] of Object.entries(paths)) {
    if (!ctx.isRecord(pathItem)) {
      summary.skipped += 1;
      continue;
    }

    const pathParameters = ctx.extractOpenApiParameters(pathItem['parameters']);
    for (const method of OPENAPI_METHODS) {
      const operation = pathItem[method];
      if (!ctx.isRecord(operation)) {
        continue;
      }

      const endpointUrl = ctx.buildOpenApiEndpointUrl(baseUrl, routePath);
      const assetRef = ctx.assetRefFromScannerValue(endpointUrl, params.parsed.rootAssetRef);
      const methodUpper = method.toUpperCase();
      const operationParameters = ctx.extractOpenApiParameters(operation['parameters']);
      const allParameters = [...pathParameters, ...operationParameters];
      const bodyParams = ctx.extractOpenApiBodyParams(operation);
      const endpointKey = `${methodUpper}:${endpointUrl}`;

      if (!seenEndpoints.has(endpointKey)) {
        seenEndpoints.add(endpointKey);
        const endpointResult = await ctx.reportNote({
          userId: params.userId,
          workspaceDir: params.workspaceDir,
          sessionId: params.sessionId,
          context: params.context,
          input: {
            ...(assetRef ? { assetRef } : {}),
            ntype: 'http.endpoint',
            title:
              ctx.getString(operation['summary']) ??
              ctx.getString(operation['operationId']) ??
              `${methodUpper} ${routePath}`,
            data: {
              url: endpointUrl,
              method: methodUpper,
              source: 'openapi',
              sourceArtifact: artifact.relativePath,
              summary:
                ctx.getString(operation['summary']) ??
                ctx.getString(operation['description']) ??
                ctx.getString(operation['operationId']),
              tags: ctx.extractOpenApiStringArray(operation['tags']),
              urlTemplate: routePath,
              pathParams: allParameters
                .filter((parameter) => parameter.in === 'path')
                .map((parameter) => parameter.name),
              queryParams: allParameters
                .filter((parameter) => parameter.in === 'query')
                .map((parameter) => parameter.name),
              bodyParams,
              authHint: ctx.describeOpenApiAuthHint(document, operation),
              confidence: 0.9,
            },
            evidence,
          },
        });
        if (endpointResult.created) summary.endpointNotesCreated += 1; else summary.endpointNotesTouched += 1;
      }

      const leads = ctx.deriveOpenApiValidationLeads({
        document,
        operation,
        method: methodUpper,
        routePath,
        endpointUrl,
        parameters: allParameters,
        bodyParams,
        artifactPath: artifact.relativePath,
      });

      for (const lead of leads) {
        const riskFamily = ctx.getString(lead['riskFamily']) ?? 'openapi';
        const leadTarget = ctx.getString(lead['target']) ?? endpointUrl;
        const leadMethod = ctx.getString(lead['method']) ?? methodUpper;
        const leadPath = ctx.getString(lead['path']) ?? routePath;
        const leadParameter = ctx.getString(lead['parameter']);
        const leadKey = [
          riskFamily,
          leadTarget,
          leadMethod,
          leadPath,
          leadParameter ?? '',
        ].join(':');
        if (seenLeads.has(leadKey)) {
          continue;
        }
        if (seenLeads.size >= ctx.validationLeadCap) {
          skippedValidationLeadCount += 1;
          continue;
        }

        seenLeads.add(leadKey);
        const noteResult = await ctx.reportNote({
          userId: params.userId,
          workspaceDir: params.workspaceDir,
          sessionId: params.sessionId,
          context: params.context,
          input: {
            ...(assetRef ? { assetRef } : {}),
            ntype: 'validation.lead',
            title: `${riskFamily} lead for ${methodUpper} ${routePath}`,
            data: lead,
            evidence,
          },
        });
        if (noteResult.created) summary.observationsCreated += 1; else summary.observationsTouched += 1;
      }
    }
  }

  summary.skipped += skippedValidationLeadCount;
  return summary;
};
