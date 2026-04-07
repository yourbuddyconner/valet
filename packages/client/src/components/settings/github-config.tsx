import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  useAdminGitHubConfig,
  useSetGitHubOAuth,
  useCreateGitHubAppManifest,
  useRefreshGitHubApp,
  useDeleteGitHubConfig,
} from '@/api/admin-github';
import { api } from '@/api/client';

const inputClass =
  'mt-1 block w-full max-w-md rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-400 dark:focus:ring-neutral-400';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-6 dark:border-neutral-700 dark:bg-neutral-800">
      <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">{title}</h2>
      <div className="mt-4">{children}</div>
    </div>
  );
}

export function GitHubConfigSection() {
  const { data: config, isLoading } = useAdminGitHubConfig();

  return (
    <Section title="GitHub">
      <div className="space-y-6">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Configure GitHub integration for your organization. A GitHub App provides read-only repository access for the agent. OAuth enables users to link their personal GitHub accounts.
        </p>

        {config?.source === 'env' && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-700 dark:bg-amber-900/20">
            <p className="text-sm text-amber-800 dark:text-amber-300">
              GitHub is configured via environment variables.
            </p>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-4">
            <div className="h-12 animate-pulse rounded-md bg-neutral-100 dark:bg-neutral-700" />
            <div className="h-12 animate-pulse rounded-md bg-neutral-100 dark:bg-neutral-700" />
          </div>
        ) : (
          <>
            <AppPanel config={config} />
            <OAuthPanel config={config} />
          </>
        )}
      </div>
    </Section>
  );
}

// ─── GitHub App Panel ───────────────────────────────────────────────────

function AppPanel({ config }: { config: ReturnType<typeof useAdminGitHubConfig>['data'] }) {
  const createManifest = useCreateGitHubAppManifest();
  const refreshApp = useRefreshGitHubApp();
  const deleteConfig = useDeleteGitHubConfig();
  const [githubOrg, setGithubOrg] = React.useState('');
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement>(null);

  const app = config?.app;
  const isConfigured = app?.configured;
  const isInstalled = !!app?.installationId;

  function handleCreateApp(e: React.FormEvent) {
    e.preventDefault();
    if (!githubOrg.trim()) return;
    createManifest.mutate(
      { githubOrg: githubOrg.trim() },
      {
        onSuccess: (data) => {
          // Submit hidden form to GitHub
          const form = formRef.current;
          if (form) {
            const input = form.querySelector<HTMLInputElement>('input[name="manifest"]');
            if (input) input.value = JSON.stringify(data.manifest);
            form.action = data.url;
            form.submit();
          }
        },
      },
    );
  }

  function handleDelete() {
    deleteConfig.mutate(undefined, {
      onSuccess: () => setConfirmDelete(false),
    });
  }

  // State 1: Not configured
  if (!isConfigured) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200">GitHub App</h3>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Create a GitHub App to give the agent read-only access to your repositories.
        </p>
        <form onSubmit={handleCreateApp} className="space-y-3">
          <div>
            <label className="block text-sm text-neutral-600 dark:text-neutral-400">GitHub Organization</label>
            <input
              type="text"
              className={inputClass}
              value={githubOrg}
              onChange={(e) => setGithubOrg(e.target.value)}
              placeholder="acme-corp"
            />
            <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
              The GitHub organization where the app will be created and installed.
            </p>
          </div>
          <Button type="submit" disabled={createManifest.isPending || !githubOrg.trim()}>
            {createManifest.isPending ? 'Preparing...' : 'Create GitHub App'}
          </Button>
          {createManifest.isError && (
            <p className="text-sm text-red-600 dark:text-red-400">Failed to create manifest. Try again.</p>
          )}
        </form>
        {/* Hidden form for GitHub manifest POST */}
        <form ref={formRef} method="post" className="hidden">
          <input type="hidden" name="manifest" />
        </form>
      </div>
    );
  }

  // State 2: App created, not installed
  if (!isInstalled) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200">GitHub App</h3>
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 dark:border-green-700 dark:bg-green-900/20">
          <p className="text-sm font-medium text-green-800 dark:text-green-300">
            {app.appName || app.appSlug || 'GitHub App'} created
          </p>
          <p className="mt-1 text-xs text-green-700 dark:text-green-400">
            Now install the app on your GitHub organization to grant repository access.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <InstallButton />
          {app.appOwner && app.appSlug && (
            <a
              href={`https://github.com/organizations/${app.appOwner}/settings/apps/${app.appSlug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-neutral-500 underline hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
            >
              App settings
            </a>
          )}
          <DeleteButton confirmDelete={confirmDelete} setConfirmDelete={setConfirmDelete} onDelete={handleDelete} isPending={deleteConfig.isPending} />
        </div>
      </div>
    );
  }

  // State 3: App created + installed
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200">GitHub App</h3>
      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-neutral-700 dark:bg-neutral-800/50">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {app.appName || app.appSlug || `App ${app.appId}`}
            </p>
            <p className="text-xs text-green-600 dark:text-green-400">
              Installed · {app.repositoryCount ?? '?'} repositories
            </p>
            {app.accessibleOwners && app.accessibleOwners.length > 0 && (
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                Owners: {app.accessibleOwners.join(', ')}
              </p>
            )}
          </div>
          <Button
            variant="secondary"
            onClick={() => refreshApp.mutate()}
            disabled={refreshApp.isPending}
          >
            {refreshApp.isPending ? 'Refreshing...' : 'Refresh'}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3 text-sm">
        {app.appOwner && app.installationId && (
          <a
            href={`https://github.com/organizations/${app.appOwner}/settings/installations/${app.installationId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-500 underline hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
          >
            Manage repositories
          </a>
        )}
        {app.appOwner && app.appSlug && (
          <a
            href={`https://github.com/organizations/${app.appOwner}/settings/apps/${app.appSlug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-500 underline hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
          >
            App settings
          </a>
        )}
        <DeleteButton confirmDelete={confirmDelete} setConfirmDelete={setConfirmDelete} onDelete={handleDelete} isPending={deleteConfig.isPending} />
      </div>

      {refreshApp.isError && (
        <p className="text-sm text-red-600 dark:text-red-400">Failed to refresh. Check that the app is still installed.</p>
      )}
    </div>
  );
}

function InstallButton() {
  const [loading, setLoading] = React.useState(false);

  async function handleInstall() {
    setLoading(true);
    try {
      const data = await api.get<{ url?: string; error?: string }>('/repo-providers/github/install?level=org');
      if (data.url) {
        window.location.href = data.url;
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={handleInstall} disabled={loading}>
      {loading ? 'Redirecting...' : 'Install on GitHub'}
    </Button>
  );
}

function DeleteButton({
  confirmDelete,
  setConfirmDelete,
  onDelete,
  isPending,
}: {
  confirmDelete: boolean;
  setConfirmDelete: (v: boolean) => void;
  onDelete: () => void;
  isPending: boolean;
}) {
  if (confirmDelete) {
    return (
      <span className="flex items-center gap-2">
        <span className="text-xs text-red-600 dark:text-red-400">Remove GitHub App config?</span>
        <Button variant="secondary" onClick={onDelete} disabled={isPending}>
          {isPending ? 'Removing...' : 'Confirm'}
        </Button>
        <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
          Cancel
        </Button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setConfirmDelete(true)}
      className="text-sm text-red-500 underline hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
    >
      Delete
    </button>
  );
}

// ─── OAuth App Panel ────────────────────────────────────────────────────

function OAuthPanel({ config }: { config: ReturnType<typeof useAdminGitHubConfig>['data'] }) {
  const setOAuth = useSetGitHubOAuth();
  const [editing, setEditing] = React.useState(false);
  const [clientId, setClientId] = React.useState('');
  const [clientSecret, setClientSecret] = React.useState('');

  const isConfigured = config?.oauth?.configured;
  const viaApp = config?.oauth?.viaApp;

  // OAuth managed by the GitHub App — read-only
  if (isConfigured && viaApp) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200">OAuth</h3>
        <div className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-neutral-700 dark:bg-neutral-800/50">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            OAuth credentials are managed by the GitHub App. Client ID: {config.oauth?.clientId || '***'}
          </p>
        </div>
      </div>
    );
  }

  // Standalone OAuth (no app, or env var fallback)
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200">OAuth</h3>
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        OAuth allows users to link their personal GitHub accounts for commit attribution.
      </p>

      {isConfigured && !editing ? (
        <div className="flex items-center gap-3 rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-neutral-700 dark:bg-neutral-800/50">
          <div className="flex-1">
            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              Client ID: {config.oauth?.clientId || '***'}
            </p>
            <p className="text-xs text-green-600 dark:text-green-400">Configured</p>
          </div>
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Update
          </Button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!clientId.trim() || !clientSecret.trim()) return;
            setOAuth.mutate(
              { clientId: clientId.trim(), clientSecret: clientSecret.trim() },
              {
                onSuccess: () => {
                  setClientId('');
                  setClientSecret('');
                  setEditing(false);
                },
              },
            );
          }}
          className="space-y-3"
        >
          <div>
            <label className="block text-sm text-neutral-600 dark:text-neutral-400">Client ID</label>
            <input
              type="text"
              className={inputClass}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Ov23li..."
            />
          </div>
          <div>
            <label className="block text-sm text-neutral-600 dark:text-neutral-400">Client Secret</label>
            <input
              type="password"
              className={inputClass}
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="secret"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={setOAuth.isPending || !clientId.trim() || !clientSecret.trim()}>
              {setOAuth.isPending ? 'Saving...' : 'Save'}
            </Button>
            {editing && (
              <Button
                variant="secondary"
                type="button"
                onClick={() => {
                  setEditing(false);
                  setClientId('');
                  setClientSecret('');
                }}
              >
                Cancel
              </Button>
            )}
          </div>
          {setOAuth.isError && (
            <p className="text-sm text-red-600 dark:text-red-400">Failed to save OAuth configuration.</p>
          )}
        </form>
      )}
    </div>
  );
}
