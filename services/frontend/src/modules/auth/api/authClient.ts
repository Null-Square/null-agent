// The local owner and their profile, read from the backend API. There is no sign-in: a browser is the
// owner once it holds the owner cookie from the link Null AI prints at start (see ownerLink.ts).
import { api, authenticatedFetch } from '@shared/api';
import { parseApiError } from '@shared/lib/apiError';

interface User {
  id: string;
  email: string | null;
  created_at: string;
}

export interface ProfileData {
  id?: string;
  user_id: string;
  full_name?: string;
  preferences?: UserPreferences;
  created_at?: string;
  updated_at?: string;
}

export interface UserPreferences {
  theme?: 'light' | 'dark' | 'system';
  language?: string;
  onboardingCompletedAt?: string;
  onboardingProgress?: {
    version: 1;
    lastCompletedStep: number;
    formData: Record<string, unknown>;
    scopeId: string | null;
    targetId: string | null;
    targetSnapshot: string;
    updatedAt: string;
  };
}

export interface SetupStatusData {
  setup_required: boolean;
}

// Typed API response shapes
interface UserResponse { user?: User | null }
interface ProfileResponse { profile?: ProfileData | null; message?: string }
interface ScopeSummary {
  id: string;
  targetCount?: number;
}

interface AuthError {
  message: string;
  status?: number;
}

class AuthClient {
  async getUser(): Promise<{ error: AuthError | null; data?: User | null }> {
    try {
      const { data, error, response } = await api.GET('/api/auth/me');
      if (error) {
        return { error: { message: parseApiError(error).message, status: response?.status }, data: null };
      }
      return { error: null, data: (data as UserResponse)?.user ?? null };
    } catch (error: unknown) {
      const apiError = parseApiError(error);
      return { error: { message: apiError.message, status: apiError.status }, data: null };
    }
  }

  // Get user's profile
  async getProfile(): Promise<{ error: AuthError | null; data?: ProfileData | null }> {
    try {
      const data = await authenticatedFetch<ProfileResponse>('/api/profile');
      return { error: null, data: data?.profile ?? null };
    } catch (error: unknown) {
      const apiError = parseApiError(error);
      return { error: { message: apiError.message }, data: null };
    }
  }

  // Update user's profile (PUT request)
  async updateProfile(profileData: Partial<Omit<ProfileData, 'user_id'>>): Promise<{ error: AuthError | null; data?: ProfileData | null }> {
    try {
      const data = await authenticatedFetch<ProfileResponse>('/api/profile', {
        method: 'PUT',
        body: JSON.stringify(profileData),
      });
      return { error: null, data: data?.profile ?? null };
    } catch (error: unknown) {
      const apiError = parseApiError(error);
      return { error: { message: apiError.message }, data: null };
    }
  }

  // New onboarding sessions use an explicit completion marker. Accounts created
  // before that marker existed retain the legacy "has a usable scope" behavior.
  async getSetupStatus(): Promise<{ error: AuthError | null; data?: SetupStatusData | null }> {
    try {
      const profileResponse = await authenticatedFetch<ProfileResponse>('/api/profile');
      const preferences = profileResponse?.profile?.preferences;
      const explicitlyCompleted = Boolean(preferences?.onboardingCompletedAt);
      let setupRequired = false;
      if (!explicitlyCompleted) {
        const scopes = await authenticatedFetch<ScopeSummary[]>('/api/app/scopes');
        const scopeList = Array.isArray(scopes) ? scopes : [];
        const hasLegacyUsableScope = scopeList.some(
          (scope) => scope.targetCount === undefined || scope.targetCount > 0,
        );
        setupRequired = !hasLegacyUsableScope || Boolean(preferences?.onboardingProgress);
      }
      return { error: null, data: { setup_required: setupRequired } };
    } catch (error: unknown) {
      const apiError = parseApiError(error);
      return { error: { message: apiError.message }, data: null };
    }
  }
}

// Export a singleton instance
export const authClient = new AuthClient();

export default authClient;
