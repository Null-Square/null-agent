import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ComplianceFrameworkKey } from '@null-ai/contracts';
import { fetchApi, type paths } from '@shared/api';

/* The scope's code source, as GET /api/app/scopes carries it. */
type ScopeCodeSource = NonNullable<
  paths['/api/app/scopes/{id}/code-source']['get']['responses'][200]['content']['application/json']['codeSource']
>;

export interface ScopeAttachedRunnerSummary {
  id: string;
  name: string;
  status: string;
  type: string;
}

export interface Scope {
  id: string;
  name: string;
  description: string | null;
  attachedRunner?: ScopeAttachedRunnerSummary | null;
  complianceFrameworks?: ComplianceFrameworkKey[];
  targetCount?: number;
  lastRunAt?: string | null;
  status: string;
  /** Where Code Review reads this scope's code from: a folder or a git URL. */
  codeSource?: ScopeCodeSource | null;
}

const fetchScopes = async (): Promise<Scope[]> => {
  const response = await fetchApi.get<Scope[]>('/app/scopes');
  return response.data;
};

export interface ScopeContextValue {
  /** null = "All Scopes" */
  activeScopeId: string | null;
  setActiveScopeId: (id: string | null) => void;
  scopes: Scope[];
  isLoading: boolean;
}

const ScopeContext = createContext<ScopeContextValue>({
  activeScopeId: null,
  setActiveScopeId: () => {},
  scopes: [],
  isLoading: false,
});

const SCOPE_STORAGE_KEY = 'nullsquare.activeScopeId';

export function ScopeContextProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: ScopeContextValue;
}) {
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function ScopeProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const [activeScopeId, setActiveScopeId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const saved = window.localStorage.getItem(SCOPE_STORAGE_KEY);
    return saved && saved.trim().length > 0 ? saved : null;
  });
  const { data: scopes, isLoading } = useQuery({
    queryKey: ['scopes'],
    queryFn: fetchScopes,
    enabled,
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (activeScopeId) {
      window.localStorage.setItem(SCOPE_STORAGE_KEY, activeScopeId);
    } else {
      window.localStorage.removeItem(SCOPE_STORAGE_KEY);
    }
  }, [activeScopeId]);

  useEffect(() => {
    if (!enabled || !scopes || scopes.length === 0) return;

    // If no active scope, or active scope not in list, select first
    const currentIsValid = activeScopeId && scopes.some((s) => s.id === activeScopeId);
    
    if (!currentIsValid) {
      setActiveScopeId(scopes[0].id);
    }
  }, [activeScopeId, enabled, scopes]);

  return (
    <ScopeContext.Provider value={{ activeScopeId, setActiveScopeId, scopes: scopes ?? [], isLoading }}>
      {children}
    </ScopeContext.Provider>
  );
}

export function useScope() {
  return useContext(ScopeContext);
}
