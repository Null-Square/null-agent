import type { ScannerAssetRef } from '@/domains/security-ops/tools/ingestion/types';

export type OpenApiParameter = {
  name: string;
  in?: string;
};

export type OpenApiValidationLeadParams = {
  document: Record<string, unknown>;
  operation: Record<string, unknown>;
  method: string;
  routePath: string;
  endpointUrl: string;
  parameters: OpenApiParameter[];
  bodyParams: string[];
  artifactPath: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const normalizeOptionalText = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

export class OpenApiValidationLeadBuilder {
  resolveBaseUrl(
    document: Record<string, unknown>,
    rootAssetRef?: ScannerAssetRef,
  ): string | undefined {
    const servers = Array.isArray(document['servers']) ? document['servers'] : [];
    for (const server of servers) {
      if (!isRecord(server)) {
        continue;
      }
      const rawUrl = normalizeOptionalText(getString(server['url']));
      if (!rawUrl || rawUrl.includes('{')) {
        continue;
      }
      try {
        return new URL(rawUrl).toString().replace(/\/$/u, '');
      } catch {
        if (rootAssetRef?.value) {
          try {
            return new URL(rawUrl, `https://${rootAssetRef.value}`).toString().replace(/\/$/u, '');
          } catch {
            continue;
          }
        }
      }
    }

    const fallbackValue = normalizeOptionalText(rootAssetRef?.value);
    if (!fallbackValue) {
      return undefined;
    }
    if (/^https?:\/\//iu.test(fallbackValue)) {
      return fallbackValue.replace(/\/$/u, '');
    }
    return `https://${fallbackValue.replace(/\/$/u, '')}`;
  }

  buildEndpointUrl(baseUrl: string | undefined, routePath: string): string {
    const normalizedPath = routePath.startsWith('/') ? routePath : `/${routePath}`;
    if (!baseUrl) {
      return normalizedPath;
    }
    return `${baseUrl.replace(/\/$/u, '')}${normalizedPath}`;
  }

  extractParameters(value: unknown): OpenApiParameter[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .filter(isRecord)
      .map((parameter) => {
        const name = normalizeOptionalText(getString(parameter['name']));
        if (!name) {
          return null;
        }
        return {
          name,
          ...(getString(parameter['in']) ? { in: normalizeOptionalText(getString(parameter['in'])) } : {}),
        };
      })
      .filter((parameter): parameter is OpenApiParameter => parameter !== null);
  }

  extractStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return Array.from(
      new Set(
        value
          .map((entry) => normalizeOptionalText(getString(entry)))
          .filter((entry): entry is string => Boolean(entry)),
      ),
    ).sort();
  }

  extractBodyParams(operation: Record<string, unknown>): string[] {
    const requestBody = isRecord(operation['requestBody']) ? operation['requestBody'] : undefined;
    const content = isRecord(requestBody?.['content']) ? requestBody.content : undefined;
    if (!content) {
      return [];
    }
    const names = new Set<string>();
    for (const mediaType of Object.values(content)) {
      if (!isRecord(mediaType)) {
        continue;
      }
      const schema = isRecord(mediaType['schema']) ? mediaType.schema : undefined;
      for (const name of this.extractSchemaPropertyNames(schema)) {
        names.add(name);
      }
    }
    return Array.from(names).sort();
  }

  describeAuthHint(
    document: Record<string, unknown>,
    operation: Record<string, unknown>,
  ): string {
    if (Array.isArray(operation['security'])) {
      return operation['security'].length === 0 ? 'anonymous' : 'operation-security';
    }
    if (Array.isArray(document['security'])) {
      return document['security'].length === 0 ? 'anonymous' : 'global-security';
    }
    return 'unspecified';
  }

  deriveValidationLeads(params: OpenApiValidationLeadParams): Array<Record<string, unknown>> {
    const leads: Array<Record<string, unknown>> = [];
    const target = params.endpointUrl;
    const pathParameters = [
      ...params.parameters.filter((parameter) => parameter.in === 'path').map((parameter) => parameter.name),
      ...(params.routePath.match(/\{([^}]+)\}/gu) ?? []).map((match) => match.slice(1, -1)),
    ];
    const uniquePathParameters = Array.from(
      new Set(pathParameters.map((parameter) => parameter.trim()).filter(Boolean)),
    );
    const authHint = this.describeAuthHint(params.document, params.operation);
    const allowsAnonymous = this.operationAllowsAnonymous(params.document, params.operation);

    for (const parameter of uniquePathParameters) {
      if (/^(version|v)$/iu.test(parameter)) {
        continue;
      }
      leads.push({
        source: 'openapi',
        priority: 'high',
        riskFamily: 'idor',
        target,
        method: params.method,
        path: params.routePath,
        parameter,
        hypothesis:
          `${params.method} ${params.routePath} exposes object identifier "${parameter}" and needs authorization-boundary validation for cross-tenant or cross-user access.`,
        requiredControls: [
          'unauthenticated baseline',
          'same-user authorized baseline when credentials exist',
          'different-user or different-tenant object access attempt when credentials exist',
        ],
        requiredPrerequisites: ['two comparable authorized principals for promotion beyond unauthenticated/access-wall evidence'],
        evidenceRefs: [params.artifactPath],
        status: 'open',
      });
    }

    const adminBoundaryPath = /\/(?:admin|internal|private)(?:\/|$|\{)/iu.test(params.routePath);
    if (adminBoundaryPath) {
      leads.push({
        source: 'openapi',
        priority: 'high',
        riskFamily: 'admin-boundary',
        target,
        method: params.method,
        path: params.routePath,
        hypothesis:
          `${params.method} ${params.routePath} appears to cross an admin/internal boundary and needs privilege-boundary validation.`,
        requiredControls: ['unauthenticated baseline', 'low-privilege role check', 'admin-privileged baseline when credentials exist'],
        requiredPrerequisites: ['credentialed low-privilege and privileged principals for promotion beyond access-wall evidence'],
        evidenceRefs: [params.artifactPath],
        status: 'open',
      });
    }

    const sensitivePath =
      /\/(?:users?|accounts?|organizations?|orgs?|projects?|runs?|sessions?|tokens?|keys?|billing|invoices?|settings)(?:\/|$|\{)/iu
        .test(params.routePath);
    if (sensitivePath) {
      leads.push({
        source: 'openapi',
        priority: allowsAnonymous ? 'high' : 'medium',
        riskFamily: 'sensitive-public-endpoint',
        target,
        method: params.method,
        path: params.routePath,
        hypothesis:
          `${params.method} ${params.routePath} handles sensitive objects with authHint=${authHint}; validate public exposure and least-privilege access.`,
        requiredControls: ['unauthenticated baseline', 'least-privilege role check when credentials exist', 'sensitive field exposure review'],
        requiredPrerequisites: ['credentialed role material for role-boundary proof'],
        evidenceRefs: [params.artifactPath],
        status: 'open',
      });
    }

    const disclosurePath =
      /\/(?:debug|metrics|logs?|exports?|downloads?|files?|documents?|reports?|backups?|configs?|secrets?)(?:\/|$|\{)/iu
        .test(params.routePath);
    if (params.method === 'GET' && (disclosurePath || (allowsAnonymous && sensitivePath))) {
      leads.push({
        source: 'openapi',
        priority: allowsAnonymous ? 'high' : 'medium',
        riskFamily: 'information-disclosure',
        target,
        method: params.method,
        path: params.routePath,
        hypothesis:
          `${params.method} ${params.routePath} may expose sensitive data with authHint=${authHint}; validate unauthenticated and least-privilege response contents.`,
        requiredControls: ['unauthenticated baseline', 'authorized baseline when credentials exist', 'sensitive-field response review'],
        requiredPrerequisites: ['credentialed role material for role-boundary proof when the endpoint requires authentication'],
        evidenceRefs: [params.artifactPath],
        status: 'open',
      });
    }

    if (['POST', 'PUT', 'PATCH'].includes(params.method) && params.bodyParams.length > 0) {
      leads.push({
        source: 'openapi',
        priority: 'medium',
        riskFamily: 'mass-assignment',
        target,
        method: params.method,
        path: params.routePath,
        parameter: params.bodyParams.slice(0, 8).join(','),
        hypothesis:
          `${params.method} ${params.routePath} accepts writable body fields (${params.bodyParams.slice(0, 8).join(', ')}) and needs over-posting/mass-assignment validation.`,
        requiredControls: ['authorized baseline with documented body', 'extra privileged or ownership field mutation attempt'],
        requiredPrerequisites: ['safe writable test object and credentials for promotion beyond schema-only evidence'],
        evidenceRefs: [params.artifactPath],
        status: 'open',
      });
    }

    if (allowsAnonymous && params.method !== 'GET') {
      leads.push({
        source: 'openapi',
        priority: 'high',
        riskFamily: 'broken-auth',
        target,
        method: params.method,
        path: params.routePath,
        hypothesis:
          `${params.method} ${params.routePath} is documented without a security requirement and may allow unauthenticated state-changing access.`,
        requiredControls: ['unauthenticated request with harmless payload', 'verify response side effect or authorization denial'],
        evidenceRefs: [params.artifactPath],
        status: 'open',
      });
    }

    return leads;
  }

  private extractSchemaPropertyNames(schema: unknown, seen = new Set<unknown>()): string[] {
    if (!isRecord(schema) || seen.has(schema)) {
      return [];
    }
    seen.add(schema);
    const names = new Set<string>();
    const properties = isRecord(schema['properties']) ? schema['properties'] : undefined;
    if (properties) {
      for (const name of Object.keys(properties)) {
        const normalized = normalizeOptionalText(name);
        if (normalized) {
          names.add(normalized);
        }
      }
    }
    for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
      const variants = schema[key];
      if (!Array.isArray(variants)) {
        continue;
      }
      for (const variant of variants) {
        for (const name of this.extractSchemaPropertyNames(variant, seen)) {
          names.add(name);
        }
      }
    }
    if (schema['items']) {
      for (const name of this.extractSchemaPropertyNames(schema['items'], seen)) {
        names.add(name);
      }
    }
    if (names.size === 0 && typeof schema['$ref'] === 'string') {
      const refName = schema['$ref'].split('/').pop();
      const normalized = normalizeOptionalText(refName);
      if (normalized) {
        names.add(normalized);
      }
    }
    return Array.from(names).sort();
  }

  private operationAllowsAnonymous(
    document: Record<string, unknown>,
    operation: Record<string, unknown>,
  ): boolean {
    if (Array.isArray(operation['security'])) {
      return operation['security'].length === 0;
    }
    return Array.isArray(document['security']) && document['security'].length === 0;
  }
}
