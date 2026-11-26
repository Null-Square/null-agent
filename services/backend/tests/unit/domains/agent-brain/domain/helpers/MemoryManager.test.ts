import { describe, expect, it } from 'vitest';

import {
  MemoryManager,
  type StrategicMemorySeedNote,
} from '@/domains/agent-brain/domain/helpers/MemoryManager';
import { createAttemptKey } from '@/domains/agent-brain/domain/types/memory';

describe('MemoryManager.seedFromNotes', () => {
  it('seeds attempts and tested endpoints from approach.tried notes', () => {
    const notes: StrategicMemorySeedNote[] = [
      {
        ntype: 'approach.tried',
        data: {
          endpoint: '/login',
          technique: 'broken-auth',
          result: 'blocked',
          reason: '401 on all probes',
        },
        lastSeenAt: '2026-03-01T10:00:00.000Z',
      },
      {
        ntype: 'approach.tried',
        data: {
          endpoint: '/users',
          technique: 'sqli',
          result: 'failed',
          reason: 'Input validation blocked payload',
        },
        lastSeenAt: '2026-03-01T10:05:00.000Z',
      },
      {
        ntype: 'run.digest',
        data: { goal: 'ignored for attempt seeding' },
        lastSeenAt: '2026-03-01T10:10:00.000Z',
      },
    ];

    const seeded = MemoryManager.seedFromNotes(notes);

    expect(seeded.testedEndpoints).toEqual(expect.arrayContaining(['/login', '/users']));
    expect(seeded.attemptedTechniques[createAttemptKey('/login', 'broken-auth')]).toEqual(
      expect.objectContaining({
        count: 1,
        result: 'blocked',
        lastAttemptTurn: 0,
      }),
    );
    expect(seeded.attemptedTechniques[createAttemptKey('/users', 'sqli')]).toEqual(
      expect.objectContaining({
        count: 1,
        result: 'failed',
        lastAttemptTurn: 0,
      }),
    );
    expect(seeded.failedApproaches).toEqual([
      expect.objectContaining({
        endpoint: '/users',
        technique: 'sqli',
        reason: 'Input validation blocked payload',
        toolCallId: 'seed:approach.tried',
      }),
    ]);
  });

  it('accumulates counts for repeated notes and infers result from http_status', () => {
    const notes: StrategicMemorySeedNote[] = [
      {
        ntype: 'approach.tried',
        data: {
          endpoint: '/auth',
          technique: 'jwt-attacks',
          http_status: 401,
        },
        lastSeenAt: '2026-03-01T10:00:00.000Z',
      },
      {
        ntype: 'approach.tried',
        data: {
          endpoint: '/auth',
          technique: 'jwt-attacks',
          http_status: 200,
          attempt_count: 2,
        },
        lastSeenAt: '2026-03-01T10:03:00.000Z',
      },
      {
        ntype: 'approach.tried',
        data: {
          endpoint: '',
          technique: 'invalid',
        },
      },
    ];

    const seeded = MemoryManager.seedFromNotes(notes);
    const attempt = seeded.attemptedTechniques[createAttemptKey('/auth', 'jwt-attacks')];

    expect(attempt).toBeDefined();
    expect(attempt?.count).toBe(3);
    expect(attempt?.result).toBe('success');
    expect(seeded.failedApproaches).toHaveLength(0);
  });

  it('keeps same-path attempts on different hosts distinct when notes carry full URLs', () => {
    const notes: StrategicMemorySeedNote[] = [
      {
        ntype: 'approach.tried',
        data: {
          endpoint: 'https://api.example.com/login',
          technique: 'broken-auth',
          result: 'blocked',
        },
        lastSeenAt: '2026-03-01T10:00:00.000Z',
      },
      {
        ntype: 'approach.tried',
        data: {
          endpoint: 'https://admin.example.com/login',
          technique: 'broken-auth',
          result: 'blocked',
        },
        lastSeenAt: '2026-03-01T10:01:00.000Z',
      },
    ];

    const seeded = MemoryManager.seedFromNotes(notes);

    expect(seeded.attemptedTechniques[createAttemptKey('https://api.example.com/login', 'broken-auth')]).toBeDefined();
    expect(seeded.attemptedTechniques[createAttemptKey('https://admin.example.com/login', 'broken-auth')]).toBeDefined();
    expect(Object.keys(seeded.attemptedTechniques)).toHaveLength(2);
  });
});
