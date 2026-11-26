export const shouldRenderAssistantPanel = (
  pathname: string,
  isDesktop: boolean,
  showLockout: boolean,
): boolean => isDesktop && !showLockout && !pathname.startsWith('/chat');
