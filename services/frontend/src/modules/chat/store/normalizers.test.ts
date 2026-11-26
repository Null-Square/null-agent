import { describe, expect, it } from 'vitest';
import {
  normalizePlanItem,
  normalizePlanItems,
  normalizePlanStatus,
  normalizePlanStepUpdatePayload,
  normalizeSandboxPolicy,
  normalizeStringArray,
  normalizeTaskSummary,
  normalizeToolStreams,
  toNumber,
} from './normalizers';

describe('chat normalizers', () => {
  it('coerces numbers and string arrays', () => {
    expect(toNumber(12)).toBe(12);
    expect(toNumber('5.5')).toBe(5.5);
    expect(toNumber('nope')).toBeUndefined();

    expect(normalizeStringArray([' a ', 'a', '', 'b '])).toEqual(['a', 'b']);
    expect(normalizeStringArray(' lone ')).toEqual(['lone']);
    expect(normalizeStringArray(42)).toBeUndefined();
  });

  it('normalizes plan status and items', () => {
    expect(normalizePlanStatus('in-progress')).toBe('running');
    expect(normalizePlanStatus('COMPLETED')).toBe('completed');
    expect(normalizePlanStatus(123)).toBe('pending');

    const item = normalizePlanItem(
      {
        title: '  Recon  ',
        status: 'running',
        notes: 'notes',
        startedAt: '100',
        artifactLinks: ['one', 'one', 'two '],
      },
      0,
    );

    expect(item).toMatchObject({
      title: 'Recon',
      status: 'running',
      notes: 'notes',
      startedAt: 100,
      artifactLinks: ['one', 'two'],
    });

    expect(normalizePlanItems([null, { title: 'A', id: 'step-1' }])).toEqual([
      expect.objectContaining({ id: 'step-1', title: 'A' }),
    ]);
  });

  it('normalizes plan updates and task summaries', () => {
    expect(normalizePlanStepUpdatePayload({})).toBeNull();
    expect(normalizePlanStepUpdatePayload({ stepId: ' s1 ', status: 'blocked' })).toMatchObject({
      id: 's1',
      status: 'blocked',
    });

    expect(normalizeTaskSummary({ id: '', title: 'Missing' })).toBeUndefined();
    expect(
      normalizeTaskSummary({
        id: 't1',
        title: 'Task',
        category: 'Security',
        summary: 'Summary',
        creditsEstimate: 2,
        vars: { a: 1 },
      }),
    ).toMatchObject({
      id: 't1',
      title: 'Task',
      category: 'Security',
      summary: 'Summary',
      creditsEstimate: 2,
    });
  });

  it('normalizes sandbox policy with defaults', () => {
    expect(normalizeSandboxPolicy(undefined)).toBeUndefined();
    const policy = normalizeSandboxPolicy({
      profile: ' docker ',
      capDrop: [' NET_RAW ', ''],
      network: 'container:abc',
      seccomp: null,
    });
    expect(policy).toMatchObject({
      profile: 'docker',
      capDrop: ['NET_RAW'],
      capAdd: [],
      readonlyRootfs: false,
      network: 'container:abc',
      seccomp: null,
    });
  });

  it('normalizes live tool stream snapshots', () => {
    const streams = normalizeToolStreams({
      shell_run: {
        name: 'shell_run',
        chunks: ['one', 2, 'two'],
        status: 'RUNNING',
        command: 'ls',
        result: { exitCode: 0 },
        lastUpdated: '123',
      },
      bad: null,
    });

    expect(streams).toEqual({
      shell_run: {
        name: 'shell_run',
        chunks: ['one', 'two'],
        status: 'running',
        command: 'ls',
        result: { exitCode: 0 },
        lastUpdated: 123,
      },
    });
  });
});
