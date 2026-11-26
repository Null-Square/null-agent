/**
 * SessionEventBus - Global real-time session updates
 * 
 * Provides app-wide session state synchronization by:
 * 1. Enabling shorter staleTime on session queries
 * 2. Exposing refetch utilities for manual triggers
 * 3. Future: SSE subscription when global events endpoint exists
 */

import React, { createContext, useContext, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

interface SessionEventBusContextValue {
    /** Manually invalidate all session queries (triggers refetch) */
    invalidateSessions: () => void;
    /** Manually invalidate a specific session */
    invalidateSession: (sessionId: string) => void;
}

const SessionEventBusContext = createContext<SessionEventBusContextValue | null>(null);

export const SessionEventBusProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const queryClient = useQueryClient();

    const invalidateSessions = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ['ai-agent-sessions'] });
    }, [queryClient]);

    const invalidateSession = useCallback((sessionId: string) => {
        queryClient.invalidateQueries({ queryKey: ['ai-agent-session', sessionId] });
        queryClient.invalidateQueries({ queryKey: ['ai-agent-sessions'] });
    }, [queryClient]);

    const value: SessionEventBusContextValue = {
        invalidateSessions,
        invalidateSession,
    };

    return (
        <SessionEventBusContext.Provider value={value}>
            {children}
        </SessionEventBusContext.Provider>
    );
};

/**
 * Hook to access session invalidation utilities
 */
// eslint-disable-next-line react-refresh/only-export-components
export const useSessionEventBus = (): SessionEventBusContextValue => {
    const context = useContext(SessionEventBusContext);
    if (!context) {
        throw new Error('useSessionEventBus must be used within SessionEventBusProvider');
    }
    return context;
};
