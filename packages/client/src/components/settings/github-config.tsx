import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  useAdminGitHubConfig,
  useCreateGitHubAppManifest,
  useRefreshGitHubApp,
  useDeleteGitHubConfig,
  useUpdateGitHubSettings,
  type GithubInstallation,
} from '@/api/admin-github';

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

/** Read and clear callback result params from the URL (e.g. ?created=true, ?error=...) */
function useCallbackResult() {
  const [result, setResult] = React.useState<{ type: 'success' | 'error'; message: string } | null>(null);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('created')) {
      setResult({ type: 'success', message: 'GitHub App created successfully. Now install it on your organization.' });
    } else if (params.has('installed')) {
      setResult({ type: 'success', message: 'GitHub App installed successfully.' });
    } else if (params.has('linked')) {
      setResult({ type: 'success', message: 'GitHub account linked successfully.' });
    } else if (params.has('error')) {
      const code = params.get('error');
      const messages: Record<string, string> = {
        missing_params: 'GitHub redirect was missing required parameters.',
        invalid_state: 'Invalid or expired session. Please try again.',
        invalid_or_replayed_state: 'This setup link has already been used. Please start again.',
        conversion_failed: 'Failed to exchange credentials with GitHub. The app may have been created — check your GitHub settings.',
        app_not_configured: 'GitHub App is not configured. Please set it up first.',
        unsupported_provider: 'Unsupported provider.',
        github_not_configured: 'GitHub OAuth is not configured.',
        token_exchange_failed: 'Failed to exchange OAuth token with GitHub.',
        missing_org: 'Organization context is missing. Please try again.',
      };
      setResult({ type: 'error', message: messages[code || ''] || `GitHub setup failed: ${code}` });
    }

    // Clear params from URL without triggering navigation
    if (params.has('created') || params.has('installed') || params.has('linked') || params.has('error')) {
      const url = new URL(window.location.href);
      url.search = '';
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  return { result, dismiss: () => setResult(null) };
}

export function GitHubConfigSection() {
  const { data: config, isLoading, isError } = useAdminGitHubConfig();
  const { result: callbackResult, dismiss: dismissResult } = useCallbackResult();

  return (
    <Section title="GitHub">
      <div className="space-y-6">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Configure GitHub integration for your organization. A GitHub App provides repository access for the agent and OAuth for user account linking.
        </p>

        {callbackResult && (
          <div
            className={`rounded-md border px-4 py-3 ${
              callbackResult.type === 'success'
                ? 'border-green-200 bg-green-50 dark:border-green-700 dark:bg-green-900/20'
                : 'border-red-200 bg-red-50 dark:border-red-700 dark:bg-red-900/20'
            }`}
          >
            <div className="flex items-start justify-between">
              <p
                className={`text-sm ${
                  callbackResult.type === 'success'
                    ? 'text-green-800 dark:text-green-300'
                    : 'text-red-800 dark:text-red-300'
                }`}
              >
                {callbackResult.message}
              </p>
              <button
                type="button"
                onClick={dismissResult}
                className="ml-4 text-sm text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-4">
            <div className="h-12 animate-pulse rounded-md bg-neutral-100 dark:bg-neutral-700" />
            <div className="h-12 animate-pulse rounded-md bg-neutral-100 dark:bg-neutral-700" />
          </div>
        ) : isError ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 dark:border-red-700 dark:bg-red-900/20">
            <p className="text-sm text-red-800 dark:text-red-300">
              Failed to load GitHub configuration. Please try refreshing the page.
            </p>
          </div>
        ) : config?.appStatus === 'configured' ? (
          <>
            <AppConfigured config={config} />
            <SettingsPanel config={config} />
            <InstallationsPanel config={config} />
            <DangerZone />
          </>
        ) : (
          <AppSetupForm />
        )}
      </div>
    </Section>
  );
}

// ─── GitHub App Setup (not configured) ─────────────────────────────────────

// Available GitHub App permissions with human-readable labels
const AVAILABLE_PERMISSIONS: { key: string; label: string; levels: string[] }[] = [
  { key: 'contents', label: 'Repository contents', levels: ['read', 'write'] },
  { key: 'metadata', label: 'Metadata', levels: ['read'] },
  { key: 'pull_requests', label: 'Pull requests', levels: ['read', 'write'] },
  { key: 'issues', label: 'Issues', levels: ['read', 'write'] },
  { key: 'actions', label: 'Actions', levels: ['read', 'write'] },
  { key: 'checks', label: 'Checks', levels: ['read', 'write'] },
  { key: 'deployments', label: 'Deployments', levels: ['read', 'write'] },
  { key: 'environments', label: 'Environments', levels: ['read', 'write'] },
  { key: 'pages', label: 'Pages', levels: ['read', 'write'] },
  { key: 'workflows', label: 'Workflows', levels: ['write'] },
  { key: 'members', label: 'Organization members', levels: ['read'] },
  { key: 'administration', label: 'Administration', levels: ['read', 'write'] },
];

const AVAILABLE_EVENTS = [
  'push', 'pull_request', 'issues', 'issue_comment',
  'create', 'delete', 'release', 'workflow_run',
  'check_run', 'check_suite', 'status',
];

const DEFAULT_PERMISSIONS: Record<string, string> = {
  contents: 'write',
  metadata: 'read',
  pull_requests: 'write',
  issues: 'write',
  actions: 'write',
  checks: 'read',
};

const DEFAULT_EVENTS = ['push', 'pull_request'];

function AppSetupForm() {
  const createManifest = useCreateGitHubAppManifest();
  const [githubOrg, setGithubOrg] = React.useState('');
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const [permissions, setPermissions] = React.useState<Record<string, string>>(DEFAULT_PERMISSIONS);
  const [events, setEvents] = React.useState<string[]>(DEFAULT_EVENTS);
  const formRef = React.useRef<HTMLFormElement>(null);

  function handleCreateApp(e: React.FormEvent) {
    e.preventDefault();
    if (!githubOrg.trim()) return;
    createManifest.mutate(
      {
        githubOrg: githubOrg.trim(),
        ...(showAdvanced ? { permissions, events } : {}),
      },
      {
        onSuccess: (data) => {
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

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200">GitHub App</h3>
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        Create a GitHub App to give the agent access to your repositories and enable user account linking.
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
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-xs text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
        >
          {showAdvanced ? '\u25BE Hide permissions' : '\u25B8 Configure permissions'}
        </button>
        {showAdvanced && (
          <div className="space-y-3 rounded-md border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-800/50">
            <div>
              <p className="mb-2 text-xs font-medium text-neutral-600 dark:text-neutral-400">Permissions</p>
              <div className="grid grid-cols-2 gap-1.5">
                {AVAILABLE_PERMISSIONS.map((perm) => {
                  const current = permissions[perm.key];
                  return (
                    <label key={perm.key} className="flex items-center gap-2 text-xs text-neutral-700 dark:text-neutral-300">
                      <select
                        value={current || ''}
                        onChange={(e) => {
                          setPermissions((prev) => {
                            const next = { ...prev };
                            if (e.target.value) {
                              next[perm.key] = e.target.value;
                            } else {
                              delete next[perm.key];
                            }
                            return next;
                          });
                        }}
                        className="rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-xs dark:border-neutral-600 dark:bg-neutral-800"
                      >
                        <option value="">none</option>
                        {perm.levels.map((level) => (
                          <option key={level} value={level}>{level}</option>
                        ))}
                      </select>
                      {perm.label}
                    </label>
                  );
                })}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-neutral-600 dark:text-neutral-400">Events</p>
              <div className="grid grid-cols-3 gap-1.5">
                {AVAILABLE_EVENTS.map((event) => (
                  <label key={event} className="flex items-center gap-1.5 text-xs text-neutral-700 dark:text-neutral-300">
                    <input
                      type="checkbox"
                      checked={events.includes(event)}
                      onChange={(e) => {
                        setEvents((prev) =>
                          e.target.checked ? [...prev, event] : prev.filter((ev) => ev !== event)
                        );
                      }}
                      className="rounded border-neutral-300 dark:border-neutral-600"
                    />
                    {event}
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
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

// ─── Configured App ────────────────────────────────────────────────────────

function AppConfigured({ config }: { config: NonNullable<ReturnType<typeof useAdminGitHubConfig>['data']> }) {
  const refreshApp = useRefreshGitHubApp();
  const app = config.app;
  if (!app) return null;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200">GitHub App</h3>
      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-neutral-700 dark:bg-neutral-800/50">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {app.appName || app.appSlug || `App ${app.appId}`}
            </p>
            <p className="text-xs text-green-600 dark:text-green-400">Configured</p>
            {app.appOwner && (
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                Owner: {app.appOwner} ({app.appOwnerType})
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
      </div>

      {refreshApp.isError && (
        <p className="text-sm text-red-600 dark:text-red-400">Failed to refresh. Check that the app is still installed.</p>
      )}
    </div>
  );
}

// ─── Settings Panel ────────────────────────────────────────────────────────

function SettingsPanel({ config }: { config: NonNullable<ReturnType<typeof useAdminGitHubConfig>['data']> }) {
  const updateSettings = useUpdateGitHubSettings();
  const settings = config.settings;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200">Settings</h3>
      <div className="space-y-4 rounded-md border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-800/50">
        <ToggleRow
          label="Allow personal installations"
          description="Allow users to install the GitHub App on their personal accounts."
          checked={settings.allowPersonalInstallations}
          disabled={updateSettings.isPending}
          onChange={(value) => updateSettings.mutate({ allowPersonalInstallations: value })}
        />
        <ToggleRow
          label="Allow anonymous GitHub access"
          description="Allow the agent to use the org installation for users who haven't linked their GitHub accounts."
          checked={settings.allowAnonymousGitHubAccess}
          disabled={updateSettings.isPending}
          onChange={(value) => updateSettings.mutate({ allowAnonymousGitHubAccess: value })}
        />
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{label}</p>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          checked ? 'bg-neutral-900 dark:bg-neutral-100' : 'bg-neutral-300 dark:bg-neutral-600'
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform dark:bg-neutral-900 ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}

// ─── Installations Panel ───────────────────────────────────────────────────

function InstallationsPanel({ config }: { config: NonNullable<ReturnType<typeof useAdminGitHubConfig>['data']> }) {
  const [personalOpen, setPersonalOpen] = React.useState(false);
  const { organizations, personal } = config.installations;
  const appSlug = config.app?.appSlug;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200">Installations</h3>

      {/* Organization installations — always visible */}
      <div>
        <p className="mb-2 text-xs font-medium text-neutral-600 dark:text-neutral-400">Organizations</p>
        {organizations.length === 0 ? (
          <p className="text-xs text-neutral-400 dark:text-neutral-500">
            No organization installations yet.
            {appSlug && (
              <>
                {' '}
                <a
                  href={`https://github.com/apps/${appSlug}/installations/new`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-neutral-500 underline hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
                >
                  Install now
                </a>
              </>
            )}
          </p>
        ) : (
          <InstallationTable installations={organizations} />
        )}
      </div>

      {/* Personal installations — collapsible */}
      <div>
        <button
          type="button"
          onClick={() => setPersonalOpen(!personalOpen)}
          className="mb-2 flex items-center gap-1 text-xs font-medium text-neutral-600 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
        >
          {personalOpen ? '\u25BE' : '\u25B8'} Personal ({personal.length})
        </button>
        {personalOpen && (
          personal.length === 0 ? (
            <p className="text-xs text-neutral-400 dark:text-neutral-500">No personal installations.</p>
          ) : (
            <InstallationTable installations={personal} />
          )
        )}
      </div>
    </div>
  );
}

function InstallationTable({ installations }: { installations: GithubInstallation[] }) {
  return (
    <div className="overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-700">
      <table className="w-full text-xs">
        <thead className="bg-neutral-50 dark:bg-neutral-800/50">
          <tr>
            <th className="px-3 py-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Account</th>
            <th className="px-3 py-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Type</th>
            <th className="px-3 py-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Status</th>
            <th className="px-3 py-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Created</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200 dark:divide-neutral-700">
          {installations.map((inst) => (
            <tr key={inst.id} className="text-neutral-700 dark:text-neutral-300">
              <td className="px-3 py-2 font-medium">{inst.accountLogin}</td>
              <td className="px-3 py-2">{inst.accountType}</td>
              <td className="px-3 py-2">
                <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-xs ${
                  inst.status === 'active'
                    ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
                    : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-400'
                }`}>
                  {inst.status}
                </span>
              </td>
              <td className="px-3 py-2 text-neutral-500 dark:text-neutral-400">
                {new Date(inst.createdAt).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Danger Zone ───────────────────────────────────────────────────────────

function DangerZone() {
  const deleteConfig = useDeleteGitHubConfig();
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  function handleDelete() {
    deleteConfig.mutate(undefined, {
      onSuccess: () => setConfirmDelete(false),
    });
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-red-600 dark:text-red-400">Danger Zone</h3>
      <div className="rounded-md border border-red-200 bg-red-50/50 p-4 dark:border-red-800 dark:bg-red-900/10">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">Remove App configuration</p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Deletes the GitHub App config, all installations, and all GitHub credentials. This cannot be undone.
            </p>
          </div>
          {confirmDelete ? (
            <span className="flex items-center gap-2">
              <span className="text-xs text-red-600 dark:text-red-400">Are you sure?</span>
              <Button variant="secondary" onClick={handleDelete} disabled={deleteConfig.isPending}>
                {deleteConfig.isPending ? 'Removing...' : 'Confirm'}
              </Button>
              <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button variant="secondary" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          )}
        </div>
        {deleteConfig.isError && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400">Failed to remove configuration.</p>
        )}
      </div>
    </div>
  );
}
