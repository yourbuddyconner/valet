import { useGitHubStatus, useGitHubLink, useGitHubDisconnect } from '@/api/github';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export function GitHubCard() {
  const { data: status } = useGitHubStatus();
  const linkGitHub = useGitHubLink();
  const disconnectGitHub = useGitHubDisconnect();

  if (!status) return null;

  // State 1: GitHub not configured at all
  if (!status.oauthConfigured) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-3">
            <GitHubIcon />
            <div>
              <CardTitle className="text-base">GitHub</CardTitle>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">Not configured</p>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Ask your admin to configure GitHub OAuth in organization settings.
          </p>
        </CardContent>
      </Card>
    );
  }

  const hasRepo = status.personal.scopes?.includes('repo') ?? false;

  // State 5: Fully connected (identity + repo scope)
  if (status.personal.linked && hasRepo) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-3">
            <GitHubIcon />
            <div>
              <CardTitle className="text-base">GitHub</CardTitle>
              <p className="text-xs text-green-600 dark:text-green-400">
                Connected as {status.personal.githubUsername}
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <span className="text-green-600 dark:text-green-400">&#10003;</span> Actions & notifications
          </div>
          <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <span className="text-green-600 dark:text-green-400">&#10003;</span> Commits as {status.personal.githubUsername}
          </div>
          {status.orgApp.installed && (
            <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
              <span className="text-green-600 dark:text-green-400">&#10003;</span> Org app covers {status.orgApp.accessibleOwners.join(', ')}
            </div>
          )}
          <div className="flex justify-end pt-1">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => disconnectGitHub.mutate()}
              disabled={disconnectGitHub.isPending}
            >
              {disconnectGitHub.isPending ? 'Disconnecting...' : 'Disconnect'}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // State 4: Connected but no repo scope
  if (status.personal.linked && !hasRepo) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-3">
            <GitHubIcon />
            <div>
              <CardTitle className="text-base">GitHub</CardTitle>
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Linked as {status.personal.githubUsername} — repo access not enabled
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <span className="text-green-600 dark:text-green-400">&#10003;</span> Actions & notifications
          </div>
          <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <span className="text-amber-600 dark:text-amber-400">!</span> Commits will be attributed to valet[bot]
          </div>
          <div className="flex items-center justify-between pt-1">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => linkGitHub.mutate({ scopes: ['repo', 'read:user', 'user:email'] })}
              disabled={linkGitHub.isPending}
            >
              {linkGitHub.isPending ? 'Redirecting...' : 'Enable Repo Access'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => disconnectGitHub.mutate()}
              disabled={disconnectGitHub.isPending}
            >
              {disconnectGitHub.isPending ? 'Disconnecting...' : 'Disconnect'}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // State 3: Org app only (not personally linked)
  if (status.orgApp.installed && !status.personal.linked) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-3">
            <GitHubIcon />
            <div>
              <CardTitle className="text-base">GitHub</CardTitle>
              <p className="text-xs text-amber-600 dark:text-amber-400">Org app installed — personal account not linked</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            The org app covers {status.orgApp.accessibleOwners.join(', ')}. Link your personal account to enable commits under your name.
          </p>
          <div className="flex justify-end">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => linkGitHub.mutate({ scopes: ['repo', 'read:user', 'user:email'] })}
              disabled={linkGitHub.isPending}
            >
              {linkGitHub.isPending ? 'Redirecting...' : 'Connect GitHub'}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // State 2: OAuth configured but not linked at all
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-3">
          <GitHubIcon />
          <div>
            <CardTitle className="text-base">GitHub</CardTitle>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">Not connected</p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Connect your GitHub account for actions, notifications, and commit attribution
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => linkGitHub.mutate({ scopes: ['repo', 'read:user', 'user:email'] })}
            disabled={linkGitHub.isPending}
          >
            {linkGitHub.isPending ? 'Redirecting...' : 'Connect'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function GitHubIcon() {
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
      </svg>
    </div>
  );
}
