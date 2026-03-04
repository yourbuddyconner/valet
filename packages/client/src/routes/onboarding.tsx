import * as React from 'react';
import { createFileRoute, useNavigate, redirect } from '@tanstack/react-router';
import { useAuthStore } from '@/stores/auth';
import { useUpdateProfile } from '@/api/auth';
import { Button } from '@/components/ui/button';

export const Route = createFileRoute('/onboarding')({
  beforeLoad: () => {
    const { isAuthenticated, user } = useAuthStore.getState();
    if (!isAuthenticated) {
      throw redirect({ to: '/login' });
    }
    if (user?.onboardingCompleted) {
      throw redirect({ to: '/' });
    }
  },
  component: OnboardingPage,
});

function OnboardingPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const updateProfile = useUpdateProfile();

  const [displayName, setDisplayName] = React.useState(user?.name ?? '');
  const [useSameForGit, setUseSameForGit] = React.useState(true);
  const [gitName, setGitName] = React.useState(user?.gitName ?? user?.name ?? '');
  const [gitEmail, setGitEmail] = React.useState(user?.gitEmail ?? user?.email ?? '');

  const effectiveGitName = useSameForGit ? displayName : gitName;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    updateProfile.mutate(
      {
        name: displayName || undefined,
        gitName: effectiveGitName || undefined,
        gitEmail: gitEmail || undefined,
        onboardingCompleted: true,
      },
      {
        onSuccess: () => {
          navigate({ to: '/' });
        },
      }
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-neutral-50 p-4 dark:bg-neutral-900">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
            Welcome to Valet
          </h1>
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
            Set up your profile to get started.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-5 rounded-lg border border-neutral-200 bg-white p-6 dark:border-neutral-700 dark:bg-neutral-800"
        >
          <div>
            <label
              htmlFor="display-name"
              className="block text-sm font-medium text-neutral-700 dark:text-neutral-300"
            >
              Display Name
            </label>
            <input
              id="display-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your Name"
              className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-400 dark:focus:ring-neutral-400"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              id="same-for-git"
              type="checkbox"
              checked={useSameForGit}
              onChange={(e) => setUseSameForGit(e.target.checked)}
              className="h-4 w-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:focus:ring-neutral-400"
            />
            <label
              htmlFor="same-for-git"
              className="text-sm text-neutral-700 dark:text-neutral-300"
            >
              Use same name for git commits
            </label>
          </div>

          {!useSameForGit && (
            <div>
              <label
                htmlFor="git-name"
                className="block text-sm font-medium text-neutral-700 dark:text-neutral-300"
              >
                Git Name
              </label>
              <input
                id="git-name"
                type="text"
                value={gitName}
                onChange={(e) => setGitName(e.target.value)}
                placeholder="Name for git commits"
                className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-400 dark:focus:ring-neutral-400"
              />
            </div>
          )}

          <div>
            <label
              htmlFor="git-email"
              className="block text-sm font-medium text-neutral-700 dark:text-neutral-300"
            >
              Git Email
            </label>
            <input
              id="git-email"
              type="email"
              value={gitEmail}
              onChange={(e) => setGitEmail(e.target.value)}
              placeholder="you@example.com"
              className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-400 dark:focus:ring-neutral-400"
            />
            <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
              For GitHub private emails, use{' '}
              <code className="rounded bg-neutral-100 px-1 py-0.5 dark:bg-neutral-800">
                username@users.noreply.github.com
              </code>
            </p>
          </div>

          {updateProfile.isError && (
            <p className="text-sm text-red-600 dark:text-red-400">
              Something went wrong. Please try again.
            </p>
          )}

          <Button
            type="submit"
            disabled={updateProfile.isPending}
            className="w-full"
          >
            {updateProfile.isPending ? 'Saving...' : 'Continue'}
          </Button>
        </form>
      </div>
    </div>
  );
}
