import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
/**
 * Notification Types Unit Tests
 */

import { NotificationType } from '@/domains/platform/notifications/types';

describe('NotificationType enum', () => {
  it('has all expected types', () => {
    expect(NotificationType.TASK_COMPLETED).toBe('task_completed');
    expect(NotificationType.ACTION_REQUIRED).toBe('action_required');
    expect(NotificationType.CREDITS_LOW).toBe('credits_low');
    expect(NotificationType.SESSION_ERROR).toBe('session_error');
    expect(NotificationType.SYSTEM).toBe('system');
    expect(NotificationType.SUPPORT).toBe('support');
    expect(NotificationType.PAYMENT_FAILED).toBe('payment_failed');
    expect(NotificationType.USER_SIGNUP).toBe('user_signup');
    expect(NotificationType.WARNING).toBe('warning');
    expect(NotificationType.ALERT).toBe('alert');
  });

  it('has 10 notification types', () => {
    const types = Object.values(NotificationType).filter(
      (value) => typeof value === 'string' && value === value.toLowerCase(),
    );
    expect(types).toHaveLength(10);
  });
});







