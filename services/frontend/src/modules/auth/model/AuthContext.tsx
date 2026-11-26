import { createContext, useContext, useEffect, useState } from 'react';
import { authClient } from '@modules/auth/api/authClient';
import { toApiError } from '@shared/lib/apiError';
import { OwnerDoor } from '@modules/auth/ui/OwnerDoor';

interface AuthUser {
  id: string;
  email: string | null;
  created_at?: string;
  role?: string | null;
}

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

/**
 * The person is the computer's local owner, read once from `GET /api/auth/me`; there is no sign-in.
 * A browser without the owner key gets a 401 there and sees the door instead of the app.
 */
export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsKey, setNeedsKey] = useState(false);

  useEffect(() => {
    let active = true;

    const fetchUser = async () => {
      try {
        const result = await authClient.getUser();
        if (!active) return;
        if (!result.error && result.data) {
          setUser({
            id: result.data.id,
            email: result.data.email,
            created_at: result.data.created_at,
            role: (result.data as { role?: string }).role ?? null,
          });
        } else {
          setUser(null);
          setNeedsKey(result.error?.status === 401);
        }
      } catch (error: unknown) {
        if (!active) return;
        const apiError = toApiError(error);
        console.error('Error fetching user:', apiError.message);
        setUser(null);
      } finally {
        if (active) setLoading(false);
      }
    };

    void fetchUser();

    return () => {
      active = false;
    };
  }, []);

  if (needsKey) return <OwnerDoor />;

  return (
    <AuthContext.Provider value={{ user, loading }}>
      {children}
    </AuthContext.Provider>
  );
};

export default AuthProvider;
