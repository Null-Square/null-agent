/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { purgeLegacyChatStorage } from './legacyChatStorage';

describe('purgeLegacyChatStorage', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('removes the transcripts and the index the old build wrote', () => {
    localStorage.setItem('nullsquare.chatSessions', '[{"id":"s1"}]');
    localStorage.setItem('nullsquare.chatSession:s1', '[{"content":"hello"}]');
    localStorage.setItem('nullsquare.chatSession:s2', '[{"content":"world"}]');

    purgeLegacyChatStorage();

    expect(localStorage.getItem('nullsquare.chatSessions')).toBeNull();
    expect(localStorage.getItem('nullsquare.chatSession:s1')).toBeNull();
    expect(localStorage.getItem('nullsquare.chatSession:s2')).toBeNull();
  });

  it('leaves every other key alone', () => {
    localStorage.setItem('unrelated.key', 'kept');
    localStorage.setItem('nullsquare.theme', 'dark');
    localStorage.setItem('nullsquare.chatSession:s1', '[]');

    purgeLegacyChatStorage();

    expect(localStorage.getItem('unrelated.key')).toBe('kept');
    expect(localStorage.getItem('nullsquare.theme')).toBe('dark');
    expect(localStorage.getItem('nullsquare.chatSession:s1')).toBeNull();
  });

  it('is safe to run again once the keys are gone', () => {
    expect(() => {
      purgeLegacyChatStorage();
      purgeLegacyChatStorage();
    }).not.toThrow();
  });

  it('does not throw when the browser refuses to expose storage', () => {
    // Boot-time code: a private window that throws on access must not stop the
    // app from rendering.
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('The operation is insecure.');
    });

    expect(() => purgeLegacyChatStorage()).not.toThrow();
  });
});
