import { useEffect, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuthStore } from '@/stores/auth';
import { useJoinSession } from '@/api/sessions';

export const Route = createFileRoute('/sessions/join/$token')({
  component: JoinSessionPage,
});

function JoinSessionPage() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isHydrated = useAuthStore((s) => s.isHydrated);
  const joinSession = useJoinSession();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isHydrated) return;

    if (!isAuthenticated) {
      // Store the join URL so the user can return after login
      sessionStorage.setItem('valet:return-url', `/sessions/join/${token}`);
      navigate({ to: '/login' });
      return;
    }

    joinSession.mutate(token, {
      onSuccess: (data) => {
        navigate({ to: '/sessions/$sessionId', params: { sessionId: data.sessionId } });
      },
      onError: () => {
        setError('This share link is invalid, expired, or has reached its usage limit.');
      },
    });
  }, [isHydrated, isAuthenticated, token]);

  if (!isHydrated || (!error && !joinSession.isError)) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-neutral-50 p-4 dark:bg-neutral-950">
        <div className="text-center">
          <div className="animate-spin h-8 w-8 border-2 border-neutral-300 border-t-neutral-900 rounded-full mx-auto mb-4 dark:border-neutral-600 dark:border-t-neutral-100" />
          <p className="text-sm text-neutral-600 dark:text-neutral-400">Joining session...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-neutral-50 p-4 dark:bg-neutral-950">
      <Card className="w-full max-w-md dark:border-neutral-800 dark:bg-neutral-900">
        <CardHeader className="text-center">
          <CardTitle className="text-xl dark:text-neutral-100">Unable to Join</CardTitle>
          <CardDescription className="dark:text-neutral-400">
            {error}
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center">
          <a href="/sessions" className="text-sm text-neutral-500 underline dark:text-neutral-400">
            Go to sessions
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
