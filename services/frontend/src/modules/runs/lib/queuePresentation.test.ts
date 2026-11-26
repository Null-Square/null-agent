import { describe, expect, it } from 'vitest';

import { queuedReasonLabel } from './queuePresentation';

describe('queuedReasonLabel', () => {
  it.each([
    ['waiting_for_plan_slot', 'Waiting for an available run slot.'],
    [
      'preparing_secure_environment',
      'Capacity is reserved and this assessment is being prepared.',
    ],
    ['launch_recovered', 'Safely re-queued after launch recovery.'],
    [
      'unable_to_schedule_safely',
      'This assessment cannot be scheduled safely with the available capacity.',
    ],
    ['waiting_for_capacity', 'Waiting for available capacity. It will start automatically.'],
    [null, 'Waiting for available capacity. It will start automatically.'],
  ] as const)('renders the public queue reason %s', (reason, expected) => {
    expect(queuedReasonLabel(reason)).toBe(expected);
  });
});
