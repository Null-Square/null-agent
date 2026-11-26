import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@modules/auth';
import type { ProfileData } from '@modules/auth/api/authClient';
import { authenticatedFetch } from '@shared/api';
import { toApiError } from '@shared/lib/apiError';

interface Profile {
  id: string;
  user_id: string;
  full_name: string | null;
  preferences?: ProfileData['preferences'];
  created_at: string;
  updated_at: string;
}

export const useProfile = () => {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ['profile', user?.id ?? null],
    enabled: Boolean(user),
    queryFn: async (): Promise<Profile | null> => {
      const response = await authenticatedFetch<{ profile?: ProfileData | null }>('/api/profile');
      const data = response.profile;
      if (!data) return null;
      return {
        id: data.id || '',
        user_id: data.user_id,
        full_name: data.full_name || null,
        preferences: data.preferences,
        created_at: data.created_at || new Date().toISOString(),
        updated_at: data.updated_at || new Date().toISOString(),
      };
    },
    staleTime: 60_000,
  });

  const apiError = query.error ? toApiError(query.error) : null;

  return {
    profile: user ? (query.data ?? null) : null,
    loading: Boolean(user) && query.isLoading,
    error: apiError?.message ?? null,
    fetchProfile: async () => {
      await query.refetch();
    },
  };
};
