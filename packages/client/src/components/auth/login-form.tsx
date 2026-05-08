import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { authKeys, fetchAuthProviders, type AuthProviderInfo } from '@/api/auth';
import { useAuthStore } from '@/stores/auth';

function getWorkerBaseUrl(): string {
  const apiUrl = import.meta.env.VITE_API_URL;
  if (apiUrl) {
    // Production: strip /api suffix to get worker base
    return apiUrl.replace(/\/api$/, '');
  }
  // Development: worker runs on :8787
  return 'http://localhost:8787';
}

// SVG icons for known providers
const providerIcons: Record<string, React.ReactNode> = {
  github: (
    <svg className="mr-2 h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  ),
  google: (
    <svg className="mr-2 h-5 w-5" viewBox="0 0 24 24">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  ),
};

// Fallback icon for unknown providers
function DefaultProviderIcon({ provider }: { provider: AuthProviderInfo }) {
  if (provider.protocol === 'credentials') {
    return (
      <svg className="mr-2 h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0110 0v4" />
      </svg>
    );
  }
  // Shield icon for SSO/SAML/OIDC
  return (
    <svg className="mr-2 h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function getProviderIcon(provider: AuthProviderInfo): React.ReactNode {
  return providerIcons[provider.icon] ?? providerIcons[provider.id] ?? <DefaultProviderIcon provider={provider} />;
}

function CredentialsForm({ workerUrl }: { workerUrl: string }) {
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const setAuth = useAuthStore((s) => s.setAuth);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const endpoint = isRegister ? '/auth/email/register' : '/auth/email/login';
      const body = isRegister ? { email, password, name: name || undefined } : { email, password };
      const res = await fetch(`${workerUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { sessionToken?: string; error?: string; retryAfterSeconds?: number };
      if (!res.ok) {
        if (data.error === 'too_many_attempts') {
          const mins = Math.ceil((data.retryAfterSeconds || 900) / 60);
          setError(`Too many login attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
        } else {
          setError(data.error || 'Authentication failed');
        }
        return;
      }
      if (data.sessionToken) {
        // Validate the session token to get user info
        const meRes = await fetch(`${workerUrl}/api/auth/me`, {
          headers: { Authorization: `Bearer ${data.sessionToken}` },
        });
        if (meRes.ok) {
          const meData = await meRes.json() as { user: import('@valet/shared').User };
          setAuth(data.sessionToken, meData.user);
        }
        window.location.href = '/';
      }
    } catch {
      setError('An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-2">
        {isRegister && (
          <Input
            type="text"
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
        <Input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? 'Please wait...' : isRegister ? 'Create account' : 'Sign in'}
      </Button>
      <p className="text-center text-xs text-neutral-500">
        {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
        <button
          type="button"
          className="underline hover:text-neutral-700"
          onClick={() => { setIsRegister(!isRegister); setError(null); }}
        >
          {isRegister ? 'Sign in' : 'Register'}
        </button>
      </p>
    </form>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-10 w-full rounded-md" />
      <Skeleton className="h-10 w-full rounded-md" />
    </div>
  );
}

export function LoginForm() {
  const workerUrl = getWorkerBaseUrl();
  const error = new URLSearchParams(window.location.search).get('error');

  const { data: providers, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: authKeys.providers,
    queryFn: fetchAuthProviders,
    staleTime: 60_000,
    retry: 3,
  });

  const redirectProviders = providers?.filter(p => p.protocol !== 'credentials') ?? [];
  const hasCredentials = providers?.some(p => p.protocol === 'credentials') ?? false;

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-neutral-900">
          <svg
            className="h-6 w-6 text-white"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
            />
          </svg>
        </div>
        <CardTitle className="text-2xl">Valet</CardTitle>
        <CardDescription>Sign in to continue</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <p className="text-sm text-red-600 text-center">
            {error === 'missing_params' && 'OAuth callback missing parameters.'}
            {error === 'invalid_state' && 'Invalid OAuth state. Please try again.'}
            {error === 'token_exchange_failed' && 'Failed to exchange token. Please try again.'}
            {error === 'no_email' && 'Could not retrieve email from provider.'}
            {error === 'not_allowed' && 'Access restricted. Contact the administrator.'}
            {error === 'oauth_error' && 'An error occurred during sign in. Please try again.'}
            {error === 'validation_failed' && 'Session validation failed. Please sign in again.'}
            {!['missing_params', 'invalid_state', 'token_exchange_failed', 'no_email', 'not_allowed', 'oauth_error', 'validation_failed'].includes(error) && 'An unexpected error occurred.'}
          </p>
        )}

        {isLoading ? (
          <LoadingSkeleton />
        ) : isError ? (
          <div className="space-y-2 text-center">
            <p className="text-sm text-red-600">
              Couldn't load sign-in options. Please try again.
            </p>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => { refetch(); }}
              disabled={isFetching}
            >
              {isFetching ? 'Retrying...' : 'Retry'}
            </Button>
          </div>
        ) : (
          <>
            {redirectProviders.map((provider, idx) => (
              <Button
                key={provider.id}
                variant={idx === 0 ? 'primary' : 'outline'}
                className="w-full"
                style={provider.brandColor ? { '--brand-color': provider.brandColor } as React.CSSProperties : undefined}
                onClick={() => { window.location.href = `${workerUrl}/auth/${provider.id}`; }}
              >
                {getProviderIcon(provider)}
                Sign in with {provider.displayName}
              </Button>
            ))}

            {hasCredentials && redirectProviders.length > 0 && (
              <div className="relative my-2">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-white px-2 text-neutral-500">or</span>
                </div>
              </div>
            )}

            {hasCredentials && <CredentialsForm workerUrl={workerUrl} />}

            {redirectProviders.some(p => p.id === 'github') && (
              <p className="text-center text-xs text-neutral-500 pt-2">
                Repo access is configured separately via GitHub App installation
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
