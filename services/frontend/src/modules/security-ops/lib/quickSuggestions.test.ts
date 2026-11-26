import { describe, expect, it } from 'vitest';

import { buildQuickSuggestions, type QuickSuggestionContext } from './quickSuggestions';

const baseContext: QuickSuggestionContext = {
  scopeId: 'scope-1',
  hasScope: true,
  targetCount: 1,
  verifiedTargetCount: 1,
  assetsCount: 5,
  openRisksCount: 0,
  resolvedRisksCount: 0,
  criticalCount: 0,
  highCount: 0,
  activeAutomationsCount: 0,
  runnersTotal: 1,
  runnersOnline: 1,
  activeRunsCount: 0,
  canAccessPrivateRunners: true,
  canAccessAutomations: true,
};

describe('buildQuickSuggestions', () => {
  it('does not surface setup automation as a Home operational suggestion', () => {
    const suggestions = buildQuickSuggestions(
      {
        ...baseContext,
        activeAutomationsCount: 0,
        canAccessAutomations: true,
      },
      5,
    );

    expect(suggestions.map((suggestion) => suggestion.id)).not.toContain('setup_automations');
  });
});
