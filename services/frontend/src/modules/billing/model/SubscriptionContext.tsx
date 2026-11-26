import { createContext, useContext, ReactNode } from 'react';
import { useSubscriptionQuery, useRefreshSubscription, type SubscriptionRecord } from '@modules/billing/api/subscription';

type SubscriptionContextValue = {
  subscription: SubscriptionRecord | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

const SubscriptionContext = createContext<SubscriptionContextValue | null>(null);

export const useSubscription = (): SubscriptionContextValue => {
  const ctx = useContext(SubscriptionContext);
  if (!ctx) {
    throw new Error('useSubscription must be used within a SubscriptionProvider');
  }
  return ctx;
};

export const SubscriptionProvider = ({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) => {
  const { data, isLoading } = useSubscriptionQuery(enabled);
  const subscription = data ?? null;
  const refreshSubscription = useRefreshSubscription();

  return (
    <SubscriptionContext.Provider
      value={{
        subscription,
        loading: isLoading,
        refresh: async () => {
          await refreshSubscription();
        },
      }}
    >
      {children}
    </SubscriptionContext.Provider>
  );
};
