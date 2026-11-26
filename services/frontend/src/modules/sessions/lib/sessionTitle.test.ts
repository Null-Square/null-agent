import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_DISPLAY,
  DEFAULT_SESSION_TITLE,
  deriveSessionTitle,
  getSessionDisplayTitle,
} from './sessionTitle';

describe('deriveSessionTitle', () => {
  it('prefers explicit title, then task title, then user prompt', () => {
    expect(
      deriveSessionTitle({
        title: 'Explicit',
        taskTitle: 'Task',
        userPrompt: 'Prompt',
      }),
    ).toBe('Explicit');

    expect(
      deriveSessionTitle({
        title: '   ',
        taskTitle: 'Task',
        userPrompt: 'Prompt',
      }),
    ).toBe('Task');

    expect(
      deriveSessionTitle({
        title: null,
        taskTitle: '',
        userPrompt: 'Prompt',
      }),
    ).toBe('Prompt');
  });

  it('falls back to the default title when no inputs exist', () => {
    expect(
      deriveSessionTitle({ title: '', taskTitle: null, userPrompt: undefined }),
    ).toBe(DEFAULT_SESSION_TITLE);
  });
});

describe('getSessionDisplayTitle', () => {
  it('uses the display fallback when session has no title or prompt', () => {
    expect(getSessionDisplayTitle({ title: null })).toBe(DEFAULT_SESSION_DISPLAY);
  });

  it('uses the last message when title and task are missing', () => {
    expect(getSessionDisplayTitle({ title: null, lastMessage: 'First prompt' })).toBe('First prompt');
  });
});
