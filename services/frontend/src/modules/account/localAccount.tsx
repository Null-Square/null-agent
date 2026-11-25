import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AuthSplitShell, authSurfaceClasses, useTheme } from '@null-ai/design-tokens/ui';
import { AuthBrandPanel } from './AuthBrandPanel';

export type LocalOwner = {
  email: string; company: string | null; website: string | null; createdAt: string;
  scopeFolders: Record<string, string>;
  setupScopeId: string | null;
};
type LocalAccountState =
  | { stage: 'signup' | 'signin' }
  | { stage: 'onboarding' | 'ready'; owner: LocalOwner };

const routes = { signup: '/auth', signin: '/auth', onboarding: '/onboarding', ready: '/scopes' };
const minimumPasswordLength = 8;

export function useLocalAccount() {
  return useQuery<LocalAccountState>({
    queryKey: ['local-owner'],
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/local-owner/state', { signal });
      if (!response.ok) throw new Error('Local account is unavailable.');
      return response.json();
    },
  });
}

export async function changeAccount(action: string, body: Record<string, string | null> = {}) {
  const response = await fetch('/api/local-owner/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error ?? 'The local account request failed. Try again.');
  }
}

export async function localSignOut() {
  await changeAccount('signout');
  window.location.replace('/auth');
}

export function setScopeFolder(scopeId: string, selection: 'choose' | 'clear') {
  return changeAccount('scope-folder', { scopeId, selection });
}

export function LocalAuthPage() {
  const { data, isError } = useLocalAccount();
  const { theme } = useTheme();
  const classes = authSurfaceClasses();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const signup = data?.stage === 'signup';

  useEffect(() => {
    if (data && routes[data.stage] !== '/auth') window.location.replace(routes[data.stage]);
  }, [data]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || (data.stage !== 'signup' && data.stage !== 'signin') || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await changeAccount(data.stage, { email, password });
      window.location.replace('/');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Try again.');
      setSubmitting(false);
    }
  }

  return (
    <AuthSplitShell
      homeHref="/"
      panelLabel="What NullSquare does"
      panel={<AuthBrandPanel theme={theme === 'light' ? 'light' : 'dark'} />}
    >
      {data && routes[data.stage] === '/auth' ? (
        <>
          <div className="mb-7 text-center lg:text-start">
            <h2 className={'text-2xl font-semibold tracking-tight ' + classes.title}>{signup ? 'Sign up' : 'Sign in'}</h2>
            <p className={'mt-1.5 text-sm ' + classes.muted}>
              {signup ? 'Create the owner account for this installation' : 'Welcome back to your operator console'}
            </p>
          </div>
          <form onSubmit={submit} className="space-y-4">
            <div className="flex flex-col gap-1.5 text-[13px]">
              <label htmlFor="email" className={'font-medium ' + classes.label}>Email</label>
              <input id="email" name="email" type="email" autoComplete="username" required maxLength={254}
                value={email} onChange={event => setEmail(event.target.value)}
                className={'h-10 px-3 border focus:outline-none focus:ring-1 transition-all ' + classes.input}
              />
            </div>
            <div className="flex flex-col gap-1.5 text-[13px]">
              <label htmlFor="password" className={'font-medium ' + classes.label}>Password</label>
              <input id="password" name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'}
                required minLength={signup ? minimumPasswordLength : undefined} maxLength={256}
                value={password} onChange={event => setPassword(event.target.value)}
                className={'h-10 px-3 border focus:outline-none focus:ring-1 transition-all ' + classes.input}
                aria-describedby={signup ? 'local-password-length' : undefined}
              />
              {signup && <p id="local-password-length" className={'text-xs ' + classes.subtle}>At least {minimumPasswordLength} characters.</p>}
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <button type="submit" disabled={submitting}
              className="w-full h-10 mt-2 bg-primary hover:bg-primary/90 text-primary-foreground font-medium text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {submitting ? 'Processing...' : 'Continue'}
            </button>
          </form>
        </>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {isError ? 'The local account could not be loaded. Refresh to try again.' : 'Reading the local account'}
        </p>
      )}
    </AuthSplitShell>
  );
}
