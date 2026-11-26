/* @vitest-environment jsdom */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  FeatureFlagsProvider,
  parseEnvFlags,
  useFeatureFlag,
  useFeatureFlags,
} from './FeatureFlagsContext';

const setEnvFlags = (value: string | undefined) => {
  const env = import.meta.env as Record<string, string | undefined>;
  env.VITE_FEATURE_FLAGS = value;
};

const FlagsReader = ({ flagKey, defaultValue }: { flagKey: string; defaultValue?: boolean }) => {
  const flags = useFeatureFlags();
  const flag = useFeatureFlag(flagKey, defaultValue);
  return (
    <>
      <div data-testid="flags">{JSON.stringify(flags)}</div>
      <div data-testid="flag">{String(flag)}</div>
    </>
  );
};

describe('FeatureFlagsContext', () => {
  const originalEnv = (import.meta.env as Record<string, string | undefined>).VITE_FEATURE_FLAGS;

  afterEach(() => {
    setEnvFlags(originalEnv);
  });

  it('parses valid JSON from env', () => {
    setEnvFlags('{"reports.newLayout":true,"chat.newComposer":false}');
    expect(parseEnvFlags()).toEqual({
      'reports.newLayout': true,
      'chat.newComposer': false,
    });
  });

  it('returns empty map on invalid JSON', () => {
    setEnvFlags('not-json');
    expect(parseEnvFlags()).toEqual({});
  });

  it('merges env flags with initial flags (initial overrides)', () => {
    setEnvFlags('{"reports.newLayout":true,"chat.newComposer":false}');
    render(
      <FeatureFlagsProvider initialFlags={{ 'chat.newComposer': true, 'extra.flag': true }}>
        <FlagsReader flagKey="chat.newComposer" defaultValue={false} />
      </FeatureFlagsProvider>,
    );

    expect(screen.getByTestId('flags').textContent).toContain('"reports.newLayout":true');
    expect(screen.getByTestId('flags').textContent).toContain('"chat.newComposer":true');
    expect(screen.getByTestId('flags').textContent).toContain('"extra.flag":true');
    expect(screen.getByTestId('flag').textContent).toBe('true');
  });

  it('uses default value when flag missing', () => {
    setEnvFlags('{}');
    render(
      <FeatureFlagsProvider>
        <FlagsReader flagKey="missing.flag" defaultValue />
      </FeatureFlagsProvider>,
    );

    expect(screen.getByTestId('flag').textContent).toBe('true');
  });
});
