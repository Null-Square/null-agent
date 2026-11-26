import { z } from 'zod';

import { ASSEMBLED_BEHAVIOR_EVIDENCE_SCHEMA } from './types';

const toolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.unknown()),
});

const assertionSchema = z.object({
  id: z.string().min(1),
  passed: z.boolean(),
  expected: z.unknown(),
  actual: z.unknown(),
  authoritativeSource: z.string().min(1),
  detail: z.string().min(1),
});

const toolExecutionSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  status: z.enum(['pending', 'completed', 'failed']),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
  args: z.record(z.unknown()).optional(),
  result: z.unknown().optional(),
});

const fixtureSchema = z.object({
  fixture: z.enum(['corrected', 'broken-authoritative-omission']),
  legacyFirstToolAssertionPassed: z.boolean(),
  newGatePassed: z.boolean(),
  namedFaultPoint: z.string().min(1),
  coldRestartPerformed: z.literal(true),
  firstRunError: z.string().optional(),
  recoveryRunError: z.string().optional(),
  authoritativeBeforeRestart: z.array(toolExecutionSchema),
  authoritativeAtColdStart: z.array(toolExecutionSchema),
  durable: z.object({
    messages: z.array(z.object({
      id: z.string().min(1),
      role: z.enum(['user', 'assistant', 'tool']),
      content: z.string().optional(),
      toolCallId: z.string().optional(),
      toolCalls: z.array(toolCallSchema).optional(),
      recordedAt: z.string().datetime(),
    })),
    modelRequests: z.array(z.object({
      requestId: z.string().min(1),
      sessionId: z.string().min(1),
      turn: z.number().int().positive(),
      provider: z.string().min(1),
      model: z.string().min(1),
      messages: z.array(z.object({ role: z.string(), content: z.string() })),
      tools: z.array(z.object({ name: z.string().min(1), schema: z.record(z.unknown()) })),
      recordedAt: z.string().datetime(),
    })),
    providerAttempts: z.array(z.object({
      attemptId: z.string().min(1),
      requestId: z.string().min(1),
      provider: z.string().min(1),
      model: z.string().min(1),
      ordinal: z.number().int().positive(),
      status: z.enum(['completed', 'failed']),
      toolCalls: z.array(toolCallSchema),
      usage: z.object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      }),
      recordedAt: z.string().datetime(),
    })),
    toolExecutions: z.array(toolExecutionSchema),
    terminalStates: z.array(z.object({
      sessionId: z.string().min(1),
      state: z.enum(['interrupted', 'recovered_unknown', 'completed', 'failed']),
      reason: z.string().optional(),
      recordedAt: z.string().datetime(),
    })),
    deliberateCorruptions: z.array(z.object({
      kind: z.literal('omit_tool_execution_records'),
      toolCallId: z.string().min(1),
      reason: z.string().min(1),
      recordedAt: z.string().datetime(),
    })),
  }),
  trace: z.array(z.object({
    id: z.string().min(1),
    event: z.string().min(1),
    turn: z.number().int().nonnegative(),
    severity: z.string().min(1),
    toolCallId: z.string().optional(),
    payloadMode: z.enum(['inline', 'artifact']),
    inlinePayload: z.unknown(),
    hydratedPayload: z.unknown().optional(),
    artifactPath: z.string().optional(),
  })),
  artifacts: z.array(z.object({
    path: z.string().min(1),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    compressed: z.boolean(),
    hydratedForEventIds: z.array(z.string().min(1)).min(1),
  })),
  externalState: z.object({
    count: z.number().int().nonnegative(),
    effects: z.array(z.object({
      toolCallId: z.string().min(1),
      recordedAt: z.string().datetime(),
    })),
  }),
  assertions: z.array(assertionSchema).min(1),
});

export const assembledBehaviorEvidenceSchema = z.object({
  schema: z.literal(ASSEMBLED_BEHAVIOR_EVIDENCE_SCHEMA),
  scenarioId: z.string().min(1),
  generatedAt: z.string().datetime(),
  commit: z.string().min(1),
  claim: z.object({
    text: z.string().min(1),
    affectedRuntimeSurfaces: z.array(z.string().min(1)).min(1),
    terminalExpressions: z.array(z.string().min(1)).min(1),
    authoritativeRecords: z.array(z.string().min(1)).min(1),
    weakerProjections: z.array(z.string().min(1)).min(1),
  }),
  configuration: z.object({
    deterministicProvider: z.literal(true),
    liveCanaryRequired: z.boolean(),
    artifactInlineLimit: z.number().int().positive(),
    faultPoint: z.string().min(1),
    toolCallId: z.string().min(1),
  }),
  host: z.object({
    kind: z.literal('behavior_lab_assembled'),
    capabilities: z.object({
      hostKind: z.literal('test'),
      modelRequests: z.object({ owner: z.string().min(1), durability: z.literal('durable'), schemaVersion: z.number().int().positive() }),
      toolExecutions: z.object({ owner: z.string().min(1), durability: z.literal('durable'), schemaVersion: z.number().int().positive() }),
      traceEvents: z.object({ owner: z.string().min(1), durability: z.literal('durable'), schemaVersion: z.number().int().positive() }),
      artifacts: z.object({ owner: z.string().min(1), durability: z.literal('durable'), schemaVersion: z.number().int().positive() }),
      restartRecovery: z.object({ owner: z.string().min(1), durability: z.literal('durable'), schemaVersion: z.number().int().positive() }),
      terminalState: z.object({ owner: z.string().min(1), durability: z.literal('durable'), schemaVersion: z.number().int().positive() }),
    }),
    factoryBindings: z.array(z.string().min(1)).min(1),
  }),
  fixtures: z.object({
    corrected: fixtureSchema,
    negativeControl: fixtureSchema,
  }),
  verdict: z.object({
    correctedFixturePassed: z.boolean(),
    negativeControlDetected: z.boolean(),
    legacyAssertionPassedOnBrokenFixture: z.boolean(),
    namedMismatches: z.array(z.string().min(1)),
  }),
});
