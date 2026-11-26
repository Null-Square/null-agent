import { describe, expect, it } from 'vitest';
import { getSessionSnapshotVersion, shouldPreferSessionSnapshot } from './sessionSnapshot';

describe('sessionSnapshot utilities', () => {
  it('prefers higher-version snapshots even when the older snapshot is richer', () => {
    const current = {
      id: 's1',
      version: 2,
      messages: [{ id: 'm1' }, { id: 'm2' }],
      plan: [{ id: 'p1' }],
      artifacts: [{ id: 'a1' }],
      liveToolStreams: { shell: { name: 'shell', chunks: ['ls'], status: 'running', lastUpdated: 10 } },
    };
    const next = {
      id: 's1',
      version: 3,
      messages: [{ id: 'm1' }],
      plan: [],
      artifacts: [],
      liveToolStreams: {},
    };

    expect(shouldPreferSessionSnapshot(current as never, next as never)).toBe(true);
  });

  it('prefers richer snapshots when versions are equal', () => {
    const current = {
      id: 's1',
      version: 0,
      messages: [],
      plan: [],
      artifacts: [],
      liveToolStreams: {},
    };
    const next = {
      id: 's1',
      version: 0,
      messages: [{ id: 'm1' }],
      plan: [{ id: 'p1' }],
      artifacts: [{ id: 'a1' }],
      liveToolStreams: { shell: { name: 'shell', chunks: ['npm test'], status: 'running', lastUpdated: 25 } },
    };

    expect(shouldPreferSessionSnapshot(current as never, next as never)).toBe(true);
  });

  it('reads missing versions as zero', () => {
    expect(getSessionSnapshotVersion(undefined)).toBe(0);
    expect(getSessionSnapshotVersion({ id: 's1' } as never)).toBe(0);
  });
});
