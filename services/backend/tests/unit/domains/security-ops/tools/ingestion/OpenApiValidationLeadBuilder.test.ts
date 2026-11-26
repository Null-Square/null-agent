import { describe, expect, it } from 'vitest';

import { OpenApiValidationLeadBuilder } from '@/domains/security-ops/tools/ingestion/OpenApiValidationLeadBuilder';

describe('OpenApiValidationLeadBuilder', () => {
  it('resolves base URLs from servers and root assets', () => {
    const builder = new OpenApiValidationLeadBuilder();

    expect(
      builder.resolveBaseUrl(
        { servers: [{ url: '/api' }] },
        { kind: 'domain', value: 'example.test' },
      ),
    ).toBe('https://example.test/api');
    expect(
      builder.resolveBaseUrl(
        { servers: [{ url: '{tenant}.example.test' }] },
        { kind: 'domain', value: 'api.example.test/' },
      ),
    ).toBe('https://api.example.test');
    expect(builder.buildEndpointUrl('https://api.example.test/', 'users')).toBe('https://api.example.test/users');
  });

  it('extracts parameters, tags, and nested body parameter names', () => {
    const builder = new OpenApiValidationLeadBuilder();

    expect(
      builder.extractParameters([
        { name: 'id', in: 'path' },
        { name: ' verbose ', in: 'query' },
        { in: 'query' },
      ]),
    ).toEqual([
      { name: 'id', in: 'path' },
      { name: 'verbose', in: 'query' },
    ]);
    expect(builder.extractStringArray(['beta', 'alpha', 'beta', 1])).toEqual(['alpha', 'beta']);
    expect(
      builder.extractBodyParams({
        requestBody: {
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { properties: { role: { type: 'string' } } },
                  { properties: { organizationId: { type: 'string' } } },
                ],
              },
            },
          },
        },
      }),
    ).toEqual(['organizationId', 'role']);
  });

  it('derives OpenAPI validation leads from route, auth, and body signals', () => {
    const builder = new OpenApiValidationLeadBuilder();

    const leads = builder.deriveValidationLeads({
      document: { security: [] },
      operation: { security: [] },
      method: 'POST',
      routePath: '/admin/users/{userId}',
      endpointUrl: 'https://api.example.test/admin/users/{userId}',
      parameters: [{ name: 'userId', in: 'path' }],
      bodyParams: ['role', 'organizationId'],
      artifactPath: '.artifacts/scans/openapi/openapi.json',
    });

    expect(leads.map((lead) => lead['riskFamily'])).toEqual([
      'idor',
      'admin-boundary',
      'sensitive-public-endpoint',
      'mass-assignment',
      'broken-auth',
    ]);
    expect(leads[0]).toMatchObject({
      priority: 'high',
      parameter: 'userId',
      target: 'https://api.example.test/admin/users/{userId}',
    });
    expect(leads.find((lead) => lead['riskFamily'] === 'mass-assignment')).toMatchObject({
      parameter: 'role,organizationId',
    });
  });
});
