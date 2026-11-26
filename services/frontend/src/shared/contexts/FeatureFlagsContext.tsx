import { createContext, useContext, useMemo, type ReactNode } from 'react';

type FeatureFlagMap = Record<string, boolean>;

interface FeatureFlagsContextValue {
  flags: FeatureFlagMap;
}

const FeatureFlagsContext = createContext<FeatureFlagsContextValue | undefined>(undefined);

export const parseEnvFlags = (): FeatureFlagMap => {
  const raw = (import.meta.env.VITE_FEATURE_FLAGS as string | undefined) ?? '';
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as FeatureFlagMap) : {};
  } catch {
    return {};
  }
};

interface FeatureFlagsProviderProps {
  children: ReactNode;
  initialFlags?: FeatureFlagMap;
}

export const FeatureFlagsProvider = ({ children, initialFlags }: FeatureFlagsProviderProps) => {
  const envFlags = useMemo(parseEnvFlags, []);
  const merged = useMemo(() => ({ ...envFlags, ...(initialFlags ?? {}) }), [envFlags, initialFlags]);

  return <FeatureFlagsContext.Provider value={{ flags: merged }}>{children}</FeatureFlagsContext.Provider>;
};

export const useFeatureFlags = () => {
  const ctx = useContext(FeatureFlagsContext);
  if (!ctx) throw new Error('useFeatureFlags must be used within a FeatureFlagsProvider');
  return ctx.flags;
};

export const useFeatureFlag = (key: string, defaultValue = false) => {
  const flags = useFeatureFlags();
  return key in flags ? flags[key] : defaultValue;
};
