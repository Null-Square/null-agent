import { describe, expect, it } from 'vitest';
import { APP_NAV_ITEMS } from './SidebarLayout';
import { shouldRenderAssistantPanel } from './sidebarLayoutVisibility';

describe('APP_NAV_ITEMS', () => {
  it('keeps chat out of the primary sidebar', () => {
    // The assistant panel is the way into a conversation — it holds recent
    // conversations, setup actions and the composer. A nav item beside it was a
    // second door to the same room.
    expect(APP_NAV_ITEMS.some((item) => item.id === 'chat')).toBe(false);
  });

  it('includes the compliance page in the primary sidebar', () => {
    const complianceItem = APP_NAV_ITEMS.find((item) => item.id === 'compliance');

    expect(complianceItem?.label).toBe('Compliance');
    expect(complianceItem?.path).toBe('/compliance');
    expect(complianceItem?.matcher('/compliance/soc2')).toBe(true);
  });

  it('does not duplicate Code Review as a standalone sidebar destination', () => {
    expect(APP_NAV_ITEMS.some((item) => item.id === 'code-review')).toBe(false);
  });

});

describe('shouldRenderAssistantPanel', () => {
  it('hides the assistant launcher on the Chat page', () => {
    expect(shouldRenderAssistantPanel('/chat', true, false)).toBe(false);
    expect(shouldRenderAssistantPanel('/chat?prompt=hello', true, false)).toBe(false);
  });

  it('shows the assistant launcher on desktop app pages outside chat', () => {
    expect(shouldRenderAssistantPanel('/dashboard', true, false)).toBe(true);
  });

  it('does not show the assistant launcher on lockout or mobile layouts', () => {
    expect(shouldRenderAssistantPanel('/dashboard', false, false)).toBe(false);
    expect(shouldRenderAssistantPanel('/dashboard', true, true)).toBe(false);
  });
});
