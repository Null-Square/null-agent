import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
/**
 * @null-ai/contracts Validator Tests
 *
 * Comprehensive tests for all validator functions in the contracts package.
 * These tests prevent schema drift between frontend and backend.
 */

import {
  // Task validators
  validateTaskSummaries,
  validateTaskManifest,
  normalizeTaskInputDefinitions,
  normalizeTaskInputDefinition,
  normalizeTaskInputOptions,
  taskSummarySchema,
  taskManifestSchema,
  taskInputDefinitionSchema,

  // Message validators
  validateMessages,
  chatMessageSchema,

  // Artifact validators
  validateArtifacts,
  sessionArtifactSchema,

  // Session utilities
  deriveStatus,
  SESSION_STATUSES,
  BLOCKED_REASONS,
} from '@null-ai/contracts';

describe('@null-ai/contracts validators', () => {
  // ===========================================================================
  // Task Input Normalization
  // ===========================================================================
  describe('normalizeTaskInputOptions', () => {
    it('returns undefined for undefined input', () => {
      expect(normalizeTaskInputOptions(undefined)).toBeUndefined();
    });

    it('converts string array to option objects', () => {
      const result = normalizeTaskInputOptions(['a', 'b', 'c']);
      expect(result).toEqual([
        { value: 'a', label: 'a' },
        { value: 'b', label: 'b' },
        { value: 'c', label: 'c' },
      ]);
    });

    it('normalizes option objects with missing labels', () => {
      const result = normalizeTaskInputOptions([
        { value: 'x' },
        { value: 'y', label: 'Y Label' },
      ]);
      expect(result).toEqual([
        { value: 'x', label: 'x' },
        { value: 'y', label: 'Y Label' },
      ]);
    });
  });

  describe('normalizeTaskInputDefinition', () => {
    it('adds name from key', () => {
      const result = normalizeTaskInputDefinition('target_url', { label: 'URL' });
      expect(result.name).toBe('target_url');
      expect(result.label).toBe('URL');
    });

    it('defaults component to text when missing', () => {
      const result = normalizeTaskInputDefinition('email', { label: 'Email' });
      expect(result.component).toBe('text');
    });

    it('preserves explicit component', () => {
      const result = normalizeTaskInputDefinition('scan_depth', {
        component: 'radio',
      });
      expect(result.component).toBe('radio');
    });
  });

  describe('normalizeTaskInputDefinitions', () => {
    it('returns empty array for undefined', () => {
      expect(normalizeTaskInputDefinitions(undefined)).toEqual([]);
    });

    it('normalizes object format to array', () => {
      const result = normalizeTaskInputDefinitions({
        target: { label: 'Target', required: true },
        depth: { label: 'Depth', component: 'select' },
      });
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('target');
      expect(result[1].name).toBe('depth');
    });

    it('normalizes array format', () => {
      const result = normalizeTaskInputDefinitions([
        { name: 'url', label: 'URL' },
        { name: 'timeout', component: 'text' },
      ]);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('url');
    });

    it('filters out items without names', () => {
      const result = normalizeTaskInputDefinitions([
        { name: 'valid', label: 'Valid' },
        { label: 'No Name' } as any,
        { name: '', label: 'Empty Name' },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('valid');
    });
  });

  // ===========================================================================
  // Task Summary Validation
  // ===========================================================================
  describe('validateTaskSummaries', () => {
    it('returns empty array for non-array input', () => {
      expect(validateTaskSummaries(null)).toEqual([]);
      expect(validateTaskSummaries(undefined)).toEqual([]);
      expect(validateTaskSummaries('string')).toEqual([]);
      expect(validateTaskSummaries(123)).toEqual([]);
    });

    it('validates array of task summaries', () => {
      const input = [
        { id: 'task-1', title: 'Task One' },
        { id: 'task-2', title: 'Task Two', creditsEstimate: 100 },
      ];
      const result = validateTaskSummaries(input);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('task-1');
      expect(result[1].creditsEstimate).toBe(100);
    });

    it('filters out invalid items', () => {
      const input = [
        { id: 'valid', title: 'Valid Task' },
        { id: '', title: 'Empty ID' }, // Invalid: empty id
        { title: 'No ID' }, // Invalid: missing id
      ];
      const result = validateTaskSummaries(input);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('valid');
    });

    it('normalizes inputs from object to array', () => {
      const input = [{
        id: 'task',
        title: 'Task',
        inputs: { file: { label: 'File', component: 'file' } },
      }];
      const result = validateTaskSummaries(input);
      expect(result[0].inputs).toEqual([
        expect.objectContaining({ name: 'file', label: 'File' }),
      ]);
    });
  });

  describe('validateTaskManifest', () => {
    const validManifest = {
      id: 'scan-task',
      title: 'Security Scan',
      goal: 'Perform security scan',
      inputs: {
        target: { label: 'Target URL', required: true },
      },
    };

    it('validates a valid manifest', () => {
      const result = validateTaskManifest(validManifest);
      expect(result).not.toBeNull();
      expect(result?.id).toBe('scan-task');
    });

    it('returns null for invalid manifest', () => {
      expect(validateTaskManifest(null)).toBeNull();
      expect(validateTaskManifest({})).toBeNull();
      expect(validateTaskManifest({ id: 'x' })).toBeNull(); // Missing title & goal
    });

    it('preserves creditsEstimate', () => {
      const result = validateTaskManifest({
        ...validManifest,
        creditsEstimate: 250,
      });
      expect(result?.creditsEstimate).toBe(250);
    });
  });

  // ===========================================================================
  // Message Validation
  // ===========================================================================
  describe('validateMessages', () => {
    it('returns empty array for non-array input', () => {
      expect(validateMessages(null)).toEqual([]);
      expect(validateMessages(undefined)).toEqual([]);
      expect(validateMessages('string')).toEqual([]);
    });

    it('validates array of messages', () => {
      const input = [
        { id: 'msg-1', role: 'user', content: 'Hello' },
        { id: 'msg-2', role: 'assistant', content: 'Hi there' },
      ];
      const result = validateMessages(input);
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('user');
      expect(result[1].role).toBe('assistant');
    });

    it('converts system role to assistant', () => {
      const result = validateMessages([
        { id: 'sys', role: 'system', content: 'System prompt' },
      ]);
      expect(result[0].role).toBe('assistant');
    });

    it('adds timestamp from createdAt', () => {
      const now = Date.now();
      const result = validateMessages([
        { id: 'msg', role: 'user', createdAt: now },
      ]);
      expect(result[0].timestamp).toBeInstanceOf(Date);
      expect(result[0].createdAt).toBe(now);
    });
  });

  // ===========================================================================
  // Artifact Validation
  // ===========================================================================
  describe('validateArtifacts', () => {
    const validArtifact = {
      id: 'art-1',
      filePath: '/path/to/file.md',
      originalName: 'report.md',
      sizeBytes: 1024,
      createdAt: Date.now(),
    };

    it('validates array of artifacts', () => {
      const result = validateArtifacts([validArtifact]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('art-1');
    });

    it('returns empty array for non-array input', () => {
      expect(validateArtifacts(null)).toEqual([]);
      expect(validateArtifacts(undefined)).toEqual([]);
    });

    it('accepts optional storage type', () => {
      const result = validateArtifacts([
        { ...validArtifact, storage: 's3', bucket: 'my-bucket' },
      ]);
      expect(result[0].storage).toBe('s3');
      expect(result[0].bucket).toBe('my-bucket');
    });
  });

  // ===========================================================================
  // Session Status Derivation
  // ===========================================================================
  describe('deriveStatus', () => {
    it('prioritizes blockedReason over other fields', () => {
      expect(deriveStatus({
        blockedReason: 'credits_exhausted',
        isProcessing: true,
      })).toBe('paused');
    });

    it('returns running for isProcessing=true', () => {
      expect(deriveStatus({ isProcessing: true })).toBe('running');
    });

    it('defaults to idle for unknown state', () => {
      expect(deriveStatus({})).toBe('idle');
      expect(deriveStatus(undefined)).toBe('idle');
    });
  });

  // ===========================================================================
  // Constants
  // ===========================================================================
  describe('constants', () => {
    it('exports SESSION_STATUSES', () => {
      expect(SESSION_STATUSES).toContain('running');
      expect(SESSION_STATUSES).toContain('idle');
      expect(SESSION_STATUSES).toContain('completed');
      expect(SESSION_STATUSES).toContain('paused');
    });

    it('exports BLOCKED_REASONS', () => {
      expect(BLOCKED_REASONS).toContain('credits_exhausted');
      expect(BLOCKED_REASONS).toContain('user_paused');
      expect(BLOCKED_REASONS).toContain('system_paused');
      expect(BLOCKED_REASONS).toContain('error');
    });
  });

  // ===========================================================================
  // Schema Validation (Zod)
  // ===========================================================================
  describe('zod schemas', () => {
    it('taskSummarySchema requires id and title', () => {
      const valid = taskSummarySchema.safeParse({ id: 'x', title: 'X' });
      expect(valid.success).toBe(true);

      const invalid = taskSummarySchema.safeParse({ id: 'x' });
      expect(invalid.success).toBe(false);
    });

    it('taskManifestSchema requires id, title, goal, and inputs', () => {
      const valid = taskManifestSchema.safeParse({
        id: 'x',
        title: 'X',
        goal: 'Do X',
        inputs: {},
      });
      expect(valid.success).toBe(true);
    });

    it('chatMessageSchema requires id and role', () => {
      const valid = chatMessageSchema.safeParse({ id: 'x', role: 'user' });
      expect(valid.success).toBe(true);

      const invalid = chatMessageSchema.safeParse({ id: 'x', role: 'invalid' });
      expect(invalid.success).toBe(false);
    });

    it('sessionArtifactSchema requires all fields', () => {
      const valid = sessionArtifactSchema.safeParse({
        id: 'x',
        filePath: '/path',
        originalName: 'file.txt',
        sizeBytes: 100,
        createdAt: Date.now(),
      });
      expect(valid.success).toBe(true);
    });
  });
});






