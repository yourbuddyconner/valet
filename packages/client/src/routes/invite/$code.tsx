import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth';
import { api } from '@/api/client';
import { buildAuthRedirectUrl } from '@/lib/auth-redirect';

export const Route = createFileRoute('/invite/$code')({
  component: InvitePage,
});

function getWorkerBaseUrl(): string {
  const apiUrl = import.meta.env.VITE_API_URL;
  if (apiUrl) {
    return apiUrl.replace(/\/api$/, '');
  }
  return 'http://localhost:8787';
}

interface InviteInfo {
  code: string;
  role: string;
  orgName: string;
  status: 'valid' | 'accepted' | 'expired';
}

function InvitePage() {
  const { code } = Route.useParams();
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);
  const [invite, setInvite] = React.useState<InviteInfo | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [accepting, setAccepting] = React.useState(false);

  React.useEffect(() => {
    const workerUrl = getWorkerBaseUrl();
    fetch(`${workerUrl}/invites/${encodeURIComponent(code)}`)
      .then(async (res) => {
        if (!res.ok) {
          setError('This invite link is invalid.');
          return;
        }
        const data = await res.json();
        setInvite(data as InviteInfo);
      })
      .catch(() => {
        setError('Failed to load invite. Please try again.');
      })
      .finally(() => setLoading(false));
  }, [code]);

  async function handleAccept() {
    setAccepting(true);
    try {
      await api.post(`/invites/${encodeURIComponent(code)}/accept`);
      // Refresh user data to pick up new role
      const res = await api.get<{ user: { id: string; email: string; name?: string; avatarUrl?: string; role?: string } }>('/auth/me');
      if (res.user.role) {
        useAuthStore.setState((s) => ({
          user: s.user ? { ...s.user, role: res.user.role as 'admin' | 'member' } : s.user,
        }));
      }
      navigate({ to: '/' });
    } catch {
      setError('Failed to accept invite. It may have already been used.');
      setAccepting(false);
    }
  }

  const workerUrl = getWorkerBaseUrl();

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-neutral-50 p-4 dark:bg-neutral-950">
        <div className="text-center">
          <div className="animate-spin h-8 w-8 border-2 border-neutral-300 border-t-neutral-900 rounded-full mx-auto mb-4 dark:border-neutral-600 dark:border-t-neutral-100" />
          <p className="text-sm text-neutral-600 dark:text-neutral-400">Loading invite...</p>
        </div>
      </div>
    );
  }

  if (error || !invite) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-neutral-50 p-4 dark:bg-neutral-950">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Invalid Invite</CardTitle>
            <CardDescription>{error || 'This invite link is not valid.'}</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <a href={isAuthenticated ? '/' : '/login'} className="text-sm text-neutral-500 underline">
              {isAuthenticated ? 'Go to dashboard' : 'Go to login'}
            </a>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (invite.status === 'accepted') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-neutral-50 p-4 dark:bg-neutral-950">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Invite Already Used</CardTitle>
            <CardDescription>This invite has already been accepted.</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <a href={isAuthenticated ? '/' : '/login'} className="text-sm text-neutral-500 underline">
              {isAuthenticated ? 'Go to dashboard' : 'Go to login'}
            </a>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (invite.status === 'expired') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-neutral-50 p-4 dark:bg-neutral-950">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Invite Expired</CardTitle>
            <CardDescription>This invite link has expired. Ask an admin for a new one.</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <a href={isAuthenticated ? '/' : '/login'} className="text-sm text-neutral-500 underline">
              {isAuthenticated ? 'Go to dashboard' : 'Go to login'}
            </a>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Logged-in user: show accept button directly
  if (isAuthenticated && user) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-neutral-50 p-4 dark:bg-neutral-950">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-neutral-900 dark:bg-neutral-100">
              <svg
                className="h-6 w-6 text-white dark:text-neutral-900"
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
            <CardTitle className="text-2xl">Join {invite.orgName}</CardTitle>
            <CardDescription>
              You've been invited to join as a <span className="font-medium capitalize">{invite.role}</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-800">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                Signed in as <span className="font-medium text-neutral-900 dark:text-neutral-100">{user.email}</span>
              </p>
            </div>
            <Button className="w-full" onClick={handleAccept} disabled={accepting}>
              {accepting ? 'Accepting...' : 'Accept Invite'}
            </Button>
            <p className="text-center text-xs text-neutral-500 pt-1">
              <a href="/" className="underline">Go to dashboard</a>
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Not logged in: show OAuth buttons
  return (
    <div className="flex min-h-dvh items-center justify-center bg-neutral-50 p-4 dark:bg-neutral-950">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-neutral-900 dark:bg-neutral-100">
            <svg
              className="h-6 w-6 text-white dark:text-neutral-900"
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
          <CardTitle className="text-2xl">Join {invite.orgName}</CardTitle>
          <CardDescription>
            You've been invited to join as a <span className="font-medium capitalize">{invite.role}</span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            className="w-full"
            onClick={() => {
              window.location.href = buildAuthRedirectUrl({
                workerUrl,
                providerId: 'github',
                inviteCode: code,
                origin: window.location.origin,
              });
            }}
          >
            <svg className="mr-2 h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
            Join with GitHub
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              window.location.href = buildAuthRedirectUrl({
                workerUrl,
                providerId: 'google',
                inviteCode: code,
                origin: window.location.origin,
              });
            }}
          >
            <svg className="mr-2 h-5 w-5" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            Join with Google
          </Button>
          <p className="text-center text-xs text-neutral-500 pt-2">
            Already have an account? <a href="/login" className="underline">Sign in</a>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
