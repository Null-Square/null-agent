import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { DeadlockDetector } from '@/domains/agent-brain/application/services/DeadlockDetector';

describe('DeadlockDetector', () => {
  it('returns false for unique tool calls', () => {
    const detector = new DeadlockDetector();

    detector.record('write_file', '{"path":"/tmp/a.txt"}');

    expect(detector.isDeadlocked('read_file', '{"path":"/tmp/a.txt"}')).toBe(false);
  });

  it('detects repeated tool calls at the default limit', () => {
    const detector = new DeadlockDetector();

    expect(detector.isDeadlocked('shell_run', '{"cmd":"ls"}')).toBe(false);
    detector.record('shell_run', '{"cmd":"ls"}');
    expect(detector.isDeadlocked('shell_run', '{"cmd":"ls"}')).toBe(false);
    detector.record('shell_run', '{"cmd":"ls"}');

    expect(detector.isDeadlocked('shell_run', '{"cmd":"ls"}')).toBe(true);
  });

  it('supports custom detection thresholds', () => {
    const detector = new DeadlockDetector(2);

    detector.record('web_search', '{"query":"threat intel"}');
    expect(detector.isDeadlocked('web_search', '{"query":"threat intel"}')).toBe(true);
  });

  it('clears recorded calls between turns', () => {
    const detector = new DeadlockDetector(2);

    detector.record('file_read', '{"path":"/tmp/report.md"}');
    detector.clear();

    expect(detector.isDeadlocked('file_read', '{"path":"/tmp/report.md"}')).toBe(false);
  });

  it('REGRESSION: does not carry state across turns (prevents false deadlock)', () => {
    // This test ensures deadlock detection is per-turn, not per-session
    // Bug fixed in Dec 2025: same tool+args across 3 turns = false deadlock
    const detector = new DeadlockDetector(3);

    // Turn 1: call file_write once
    detector.record('file_write', '{"path":"summary.md"}');
    detector.clear(); // Simulates end of turn 1

    // Turn 2: call file_write once
    detector.record('file_write', '{"path":"summary.md"}');
    detector.clear(); // Simulates end of turn 2

    // Turn 3: call file_write TWICE (same args)
    detector.record('file_write', '{"path":"summary.md"}');
    // Second call in turn 3 should NOT be deadlock (only 1 recorded)
    expect(detector.isDeadlocked('file_write', '{"path":"summary.md"}')).toBe(false);
    detector.record('file_write', '{"path":"summary.md"}');
    // Third call in turn 3 SHOULD be deadlock (2 recorded, limit is 3-1=2)
    expect(detector.isDeadlocked('file_write', '{"path":"summary.md"}')).toBe(true);
  });
});







