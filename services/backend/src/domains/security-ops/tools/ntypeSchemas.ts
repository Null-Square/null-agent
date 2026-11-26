import { z } from 'zod';
import { COMPLIANCE_FRAMEWORK_KEYS } from '@/domains/security-ops/compliance/frameworks';

const stringArray = z.array(z.string().min(1));
const complianceClosureArray = z.array(z.object({
  frameworkKey: z.enum(COMPLIANCE_FRAMEWORK_KEYS),
  controlId: z.string().min(1),
}));
const immutableCommitSha = z.string().regex(
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu,
  'must be a full 40- or 64-character commit SHA',
);
const repositoryBlobSha = z.string().regex(
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu,
  'must be a full 40- or 64-character repository blob SHA',
);
const codeReviewMemoryObservationType = z.enum([
  'architecture',
  'entry_point',
  'trust_boundary',
  'authentication',
  'authorization',
  'data_flow',
  'security_control',
  'dependency',
  'configuration',
  'generated_or_vendored',
  'test_coverage',
  'review_limitation',
]);
const codeReviewMemoryAnchor = z.object({
  path: z.string().min(1),
  blobSha: repositoryBlobSha,
});
const codeReviewMemoryBase = z.object({
  workflowDiscipline: z.literal('code_review'),
  repositoryId: z.string().min(1),
  repositoryFullName: z.string().min(1),
  statement: z.string().min(8).max(1_200),
  anchors: z.array(codeReviewMemoryAnchor).min(1).max(8),
  observationType: codeReviewMemoryObservationType,
  confidence: z.coerce.number().min(0).max(1),
  firstSeenCommitSha: immutableCommitSha,
  lastConfirmedCommitSha: immutableCommitSha,
  sourceRunId: z.string().uuid(),
  memoryState: z.enum([
    'current',
    'needs_recheck',
    'superseded',
    'historical',
    'out_of_scope',
  ]).optional(),
  memoryStateReason: z.string().nullable().optional(),
  memoryStateUpdatedAt: z.string().datetime().optional(),
});
const scanCoverageFamily = z.enum([
  'broad-surface',
  'subfinder',
  'naabu',
  'httpx',
  'katana',
  'ffuf',
  'nmap',
  'nuclei',
  'openapi',
  'sqlmap',
  'dalfox',
  'semgrep',
  'trivy',
  'gitleaks',
  'trufflehog',
]);

export const ntypeSchemas: Record<string, z.ZodTypeAny> = {
  'dns.subdomain': z.object({
    hostname: z.string().min(1),
    resolvedIps: stringArray.optional(),
  }),
  'dns.a': z.object({
    name: z.string().min(1),
    value: z.string().min(1),
    ttl: z.number().optional(),
  }),
  'dns.aaaa': z.object({
    name: z.string().min(1),
    value: z.string().min(1),
    ttl: z.number().optional(),
  }),
  'dns.cname': z.object({
    name: z.string().min(1),
    value: z.string().min(1),
    ttl: z.number().optional(),
  }),
  'dns.mx': z.object({
    name: z.string().min(1),
    value: z.string().min(1),
    priority: z.number().optional(),
    ttl: z.number().optional(),
  }),
  'dns.txt': z.object({
    name: z.string().min(1),
    value: z.string().min(1),
  }),
  'dns.ns': z.object({
    name: z.string().min(1),
    value: z.string().min(1),
  }),
  'http.endpoint': z.object({
    url: z.string().min(1),
    method: z.string().min(1).optional(),
    statusCode: z.number().int().optional(),
    title: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    sourceArtifact: z.string().min(1).optional(),
    signal: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    tags: stringArray.optional(),
    urlTemplate: z.string().min(1).optional(),
    pathParams: stringArray.optional(),
    queryParams: stringArray.optional(),
    bodyParams: stringArray.optional(),
    authHint: z.string().min(1).optional(),
    confidence: z.coerce.number().min(0).max(1).optional(),
  }),
  'http.headers': z.object({
    url: z.string().min(1),
    headers: z.record(z.string()).optional(),
    missing: stringArray.optional(),
  }),
  'http.parameters': z.object({
    url: z.string().min(1),
    params: z
      .array(
        z.object({
          name: z.string().min(1),
          type: z.string().min(1).optional(),
          example: z.string().min(1).optional(),
        }),
      )
      .optional(),
  }),
  'http.waf': z.object({
    product: z.string().min(1),
    version: z.string().min(1).optional(),
    bypasses: stringArray.optional(),
    detected: z.boolean().optional(),
  }),
  'http.robots': z.object({
    url: z.string().min(1),
    disallowed: stringArray.optional(),
    sitemaps: stringArray.optional(),
  }),
  'tech.fingerprint': z.object({
    product: z.string().min(1),
    version: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    confidence: z.coerce.number().optional(),
    versionReadMethod: z
      .enum([
        'http_banner',
        'service_probe',
        'application_fingerprint',
        'error_behavior',
        'tls_fingerprint',
      ])
      .optional(),
  }),
  'tls.certificate': z.object({
    subject: z.string().min(1),
    issuer: z.string().min(1).optional(),
    sans: stringArray.optional(),
    validFrom: z.string().min(1).optional(),
    validTo: z.string().min(1).optional(),
    keyType: z.string().min(1).optional(),
    keyBits: z.number().optional(),
    protocols: stringArray.optional(),
    selfSigned: z.boolean().optional(),
    serialNumber: z.string().min(1).optional(),
  }),
  whois: z.object({
    registrar: z.string().min(1).optional(),
    createdDate: z.string().min(1).optional(),
    expiresDate: z.string().min(1).optional(),
    registrant: z.string().min(1).optional(),
  }),
  'os.fingerprint': z.object({
    method: z.string().min(1),
    os: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
    confidence: z.coerce.number().optional(),
  }),
  'network.traceroute': z.object({
    hops: z
      .array(
        z.object({
          ttl: z.number().optional(),
          ip: z.string().min(1).optional(),
          rtt: z.number().optional(),
        }),
      )
      .optional(),
  }),
  'pentest.plan': z.object({
    recommended_next_task: z.string().min(1),
    rationale: z.string().min(1),
    priority_targets: stringArray.optional(),
    confidence: z.coerce.number().min(0).max(1).optional(),
    chain: stringArray.optional(),
  }),
  'credential.found': z.object({
    type: z.string().min(1),
    username: z.string().min(1).optional(),
    context: z.string().min(1).optional(),
    exposure: z.string().min(1).optional(),
  }),
  'approach.tried': z.object({
    technique: z.string().min(1),
    endpoint: z.string().url(),
    result: z.enum(['success', 'failed', 'blocked']),
    http_status: z.number().int().optional(),
    reason: z.string().min(1).optional(),
  }),
  'approach.blocker': z.object({
    blocker_type: z.string().min(1),
    target: z.string().min(1),
    blocker_reason: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    prerequisites: stringArray.optional(),
  }),
  'scan.coverage': z.object({
    family: scanCoverageFamily,
    status: z.enum(['completed', 'blocked']),
    profileVersion: z.string().min(1),
    phase: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
    targetHost: z.string().min(1).optional(),
    targetUrl: z.string().min(1).optional(),
    inventoryFingerprint: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    toolset: stringArray.optional(),
    stats: z
      .object({
        endpointsDiscovered: z.coerce.number().int().min(0).optional(),
        findingsCreated: z.coerce.number().int().min(0).optional(),
        techsDetected: z.coerce.number().int().min(0).optional(),
        rowsParsed: z.coerce.number().int().min(0).optional(),
        rowsKept: z.coerce.number().int().min(0).optional(),
        suppressed: z.coerce.number().int().min(0).optional(),
        duplicates: z.coerce.number().int().min(0).optional(),
      })
      .optional(),
  }),
  'run.digest': z
    .object({
      workflowDiscipline: z.enum(['pentest', 'compliance', 'code_review']).optional(),
      frameworkKey: z.enum(COMPLIANCE_FRAMEWORK_KEYS).optional(),
      repositoryId: z.string().min(1).optional(),
      immutableCommitSha: immutableCommitSha.optional(),
      goal: z.string().min(1),
      outcome: z.string().min(1),
      blocker_summary: z.string().min(1).optional(),
      completed_tasks: stringArray.optional(),
      blocked_tasks: stringArray.optional(),
      blocked_prerequisite_work: stringArray.optional(),
      next_prerequisites: stringArray.optional(),
      closesCompliance: complianceClosureArray.optional(),
    })
    .superRefine((value, context) => {
      if (value.workflowDiscipline !== 'code_review') return;
      if (!value.repositoryId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['repositoryId'],
          message: 'repositoryId is required for code_review run.digest',
        });
      }
      if (!value.immutableCommitSha) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['immutableCommitSha'],
          message: 'immutableCommitSha is required for code_review run.digest',
        });
      }
    }),
  'review.map': codeReviewMemoryBase,
  'review.disposition': codeReviewMemoryBase.extend({
    findingFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    outcome: z.enum(['rejected', 'validated', 'blocked', 'deferred']),
    rationale: z.string().min(8).max(1_200),
  }),
  'review.coverage': codeReviewMemoryBase.extend({
    coverage: z.object({
      reviewedPathPrefixes: z.array(z.string().min(1)).max(50),
      techniquesAttempted: z.array(z.string().min(1)).max(50),
      skippedPaths: z.array(z.object({
        path: z.string().min(1),
        reason: z.string().min(1),
      })).max(50),
      result: z.enum(['complete', 'partial', 'blocked']),
    }),
  }),
  'validation.lead': z
    .object({
      source: z.string().min(1),
      id: z.string().uuid().optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      riskFamily: z.string().min(1),
      target: z.string().min(1).optional(),
      method: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      parameter: z.string().min(1).optional(),
      hypothesis: z.string().min(1),
      requiredControls: stringArray.optional(),
      requiredPrerequisites: stringArray.optional(),
      evidenceRefs: stringArray.optional(),
      // observations record probe outcomes against the hypothesis. Required at
      // close-time for false_positive/deferred so validation cannot silently
      // dispose a lead without recording the probe(s) it ran.
      observations: z
        .array(
          z.object({
            technique: z.string().min(1),
            probe: z.string().min(1).optional(),
            result: z.enum(['confirmed', 'contradicted', 'partial', 'inconclusive']),
            evidenceRef: z.string().min(1).optional(),
            note: z.string().min(1).optional(),
          }),
        )
        .optional(),
      candidateFindingIds: stringArray.optional(),
      supersedesLeadId: z.string().uuid().optional(),
      supersedesLeadIds: stringArray.optional(),
      attempts: z.coerce.number().int().min(0).optional(),
      lastBlockerCode: z.string().min(1).optional(),
      lastCanonicalBlockerCode: z.string().min(1).optional(),
      blockerRepeatCount: z.coerce.number().int().min(0).optional(),
      generatedAt: z.string().min(1).optional(),
      promptSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
      promptPath: z.string().min(1).optional(),
      promptRenderedAt: z.string().min(1).optional(),
      nextPrerequisite: z.string().min(1).optional(),
      replacementLead: z.record(z.unknown()).optional(),
      enumerationTaskId: z.string().uuid().optional(),
      enumerationResultHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
      enumerationLeadFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
      enumerationLeadLocalId: z.string().min(1).optional(),
      techniqueId: z.string().min(1).optional(),
      surfaceRef: z.string().min(1).optional(),
      skillRefs: z.array(z.object({
        slug: z.string().min(1),
        versionHash: z.string().regex(/^[a-f0-9]{64}$/u),
        role: z.enum(['primary', 'supporting']),
      })).max(3).optional(),
      validationGoal: z.string().min(1).optional(),
      observation: z.string().min(1).optional(),
      authContextClass: z.string().min(1).optional(),
      status: z.enum(['open', 'validated', 'false_positive', 'blocked', 'deferred', 'superseded']).optional(),
    })
    .refine(
      (lead) =>
        lead.status !== 'false_positive' && lead.status !== 'deferred'
          ? true
          : Array.isArray(lead.observations) && lead.observations.length > 0,
      {
        message:
          'validation.lead with status="false_positive" or "deferred" must include at least one observations entry recording the probe(s) that disproved or deferred the lead. Filing the close without an observation is a misuse — record the probe even if the conclusion is "inconclusive after bounded retries".',
        path: ['observations'],
      },
    ),
  'enumeration.disposition': z.object({
    taskId: z.string().uuid(),
    missionFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    resultHash: z.string().regex(/^[a-f0-9]{64}$/u),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
    coverageAcknowledged: z.literal(true),
    negativeResultsAcknowledged: z.literal(true),
    leadDispositions: z.array(z.object({
      leadLocalId: z.string().min(1),
      action: z.enum(['accept', 'merge_duplicate', 'defer', 'reject']),
      existingLeadId: z.string().uuid().optional(),
      reason: z.string().min(1).optional(),
      nextPrerequisite: z.string().min(1).optional(),
    })),
    canonicalLeadIds: stringArray,
    validatorEligibleLeadIds: stringArray,
    coverage: z.record(z.unknown()),
    negativeResults: z.array(z.record(z.unknown())),
    attempts: z.array(z.record(z.unknown())),
    blockers: z.array(z.record(z.unknown())),
  }),
  'report.section': z.object({
    section: z.string().min(1),
    heading: z.string().min(1).optional(),
    content: z.string().min(1),
    evidence_refs: stringArray.optional(),
    status: z.enum(['draft', 'final']).optional(),
  }),
};

export const reportNoteTemplates: Record<string, Record<string, unknown>> = {
  'dns.subdomain': {
    assetRef: { kind: 'domain', value: 'example.com' },
    ntype: 'dns.subdomain',
    data: {
      hostname: 'api.example.com',
      resolvedIps: ['10.0.0.10'],
    },
  },
  'http.endpoint': {
    assetRef: { kind: 'domain', value: 'api.example.com' },
    ntype: 'http.endpoint',
    data: {
      url: 'https://api.example.com/login',
      method: 'GET',
      statusCode: 200,
      title: 'Login',
    },
  },
  'tech.fingerprint': {
    assetRef: { kind: 'domain', value: 'example.com' },
    ntype: 'tech.fingerprint',
    data: {
      product: 'nginx',
      version: '1.25.0',
      category: 'web-server',
      confidence: 0.9,
      versionReadMethod: 'http_banner',
    },
  },
  'approach.tried': {
    assetRef: { kind: 'domain', value: 'app.example.com' },
    ntype: 'approach.tried',
    title: 'Broken-auth probe on login',
    data: {
      technique: 'broken-auth',
      endpoint: 'https://app.example.com/login',
      result: 'blocked',
      http_status: 401,
      reason: '401 on all probes',
    },
  },
  'approach.blocker': {
    assetRef: { kind: 'domain', value: 'app.example.com' },
    ntype: 'approach.blocker',
    title: 'Auth validation blocked by missing credential',
    data: {
      blocker_type: 'missing-prerequisite',
      target: 'https://app.example.com/admin',
      blocker_reason: 'Saved credentials were unavailable in this run.',
      prerequisites: ['Valid credential for administrator account'],
    },
  },
  'scan.coverage': {
    assetRef: { kind: 'domain', value: 'api.example.com' },
    ntype: 'scan.coverage',
    title: 'Broad surface scan completed for api.example.com',
    data: {
      family: 'broad-surface',
      status: 'completed',
      profileVersion: 'broad-surface-scan/v1',
      phase: 'enumeration',
      target: 'https://api.example.com',
      toolset: ['httpx', 'katana', 'ffuf'],
      stats: {
        endpointsDiscovered: 4,
        findingsCreated: 1,
        techsDetected: 2,
      },
    },
  },
  'run.digest': {
    ntype: 'run.digest',
    title: 'Run digest for api.example.com',
    data: {
      goal: 'Validate the approved auth and JS tasks for api.example.com.',
      outcome: 'partially_completed',
      completed_tasks: ['task1', 'task2'],
      blocked_tasks: ['task3'],
      blocked_prerequisite_work: ['Authenticated admin workflow validation'],
      next_prerequisites: ['Administrator credential for protected workflow'],
      closesCompliance: [{ frameworkKey: 'soc2', controlId: 'CC6.7' }],
    },
  },
  'validation.lead': {
    assetRef: { kind: 'domain', value: 'api.example.com' },
    ntype: 'validation.lead',
    title: 'IDOR lead for GET /api/runs/{runId}',
    data: {
      source: 'openapi',
      priority: 'high',
      riskFamily: 'idor',
      target: 'https://api.example.com',
      method: 'GET',
      path: '/api/runs/{runId}',
      parameter: 'runId',
      hypothesis: 'Path parameter runId may expose another user run without proper authorization checks.',
      requiredControls: ['unauthenticated probe', 'authenticated same-user baseline if credentials exist'],
      requiredPrerequisites: ['valid session for cross-user proof'],
      evidenceRefs: ['/workspace/.artifacts/phases/enumeration/openapi.json'],
      status: 'open',
    },
  },
  'enumeration.disposition': {
    ntype: 'enumeration.disposition',
    title: 'Enumeration worker disposition',
    data: {
      taskId: '00000000-0000-4000-8000-000000000000',
      missionFingerprint: '0'.repeat(64),
      resultHash: '0'.repeat(64),
      payloadHash: '0'.repeat(64),
      coverageAcknowledged: true,
      negativeResultsAcknowledged: true,
      leadDispositions: [],
      canonicalLeadIds: [],
      validatorEligibleLeadIds: [],
      coverage: {},
      negativeResults: [],
      attempts: [],
      blockers: [],
    },
  },
  'report.section': {
    ntype: 'report.section',
    title: 'Management summary draft',
    data: {
      section: 'executive-summary',
      heading: 'Executive Summary',
      content: 'The run confirmed the externally reachable web surface and found one reportable issue with durable evidence.',
      evidence_refs: ['finding:123e4567-e89b-12d3-a456-426614174000'],
      status: 'draft',
    },
  },
};
