import * as React from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { useAuthStore } from '@/stores/auth';
import { useLogout, useUpdateProfile } from '@/api/auth';
import { useOrchestratorInfo, useUpdateOrchestratorIdentity, useCheckHandle, useNotificationPreferences, useUpdateNotificationPreferences, useIdentityLinks, useCreateIdentityLink, useDeleteIdentityLink } from '@/api/orchestrator';
import { useAvailableModels } from '@/api/sessions';
import type { ProviderModels } from '@/api/sessions';
import type { QueueMode } from '@valet/shared';
import { Button } from '@/components/ui/button';
import { APIKeyList } from '@/components/settings/api-key-list';
import { useTheme } from '@/hooks/use-theme';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'agent', label: 'Agent' },
  { id: 'developer', label: 'Developer' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export const Route = createFileRoute('/settings/')({
  component: SettingsPage,
  validateSearch: (search: Record<string, unknown>) => ({
    tab: (TABS.some((t) => t.id === search.tab) ? search.tab : 'general') as TabId,
  }),
});

function SettingsPage() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate();

  function setTab(id: TabId) {
    navigate({ to: '/settings', search: { tab: id }, replace: true });
  }

  return (
    <PageContainer>
      <PageHeader
        title="Settings"
        description="Configure your account and preferences"
      />

      {/* Tab bar */}
      <div className="mb-6 border-b border-neutral-200 dark:border-neutral-700">
        <nav className="-mb-px flex gap-6" aria-label="Settings tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`whitespace-nowrap border-b-2 pb-3 text-sm font-medium transition-colors ${
                tab === t.id
                  ? 'border-neutral-900 text-neutral-900 dark:border-neutral-100 dark:text-neutral-100'
                  : 'border-transparent text-neutral-500 hover:border-neutral-300 hover:text-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:text-neutral-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'general' && <GeneralTab />}
      {tab === 'agent' && <AgentTab />}
      {tab === 'developer' && <DeveloperTab />}
    </PageContainer>
  );
}

// ─── Tabs ───────────────────────────────────────────────────────────────

function GeneralTab() {
  const user = useAuthStore((s) => s.user);
  const logoutMutation = useLogout();
  const { theme, setTheme } = useTheme();

  return (
    <div className="space-y-6">
      {user?.role === 'admin' && (
        <>
          <div className="rounded-lg border border-neutral-200 bg-white p-6 dark:border-neutral-700 dark:bg-neutral-800">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">Organization</h2>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  Manage members, API keys, access control, and invites.
                </p>
              </div>
              <Link
                to="/settings/admin"
                className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
              >
                Manage
              </Link>
            </div>
          </div>
          <div className="rounded-lg border border-neutral-200 bg-white p-6 dark:border-neutral-700 dark:bg-neutral-800">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">Usage & Cost</h2>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  Track LLM token usage and cost breakdown by user and model.
                </p>
              </div>
              <Link
                to="/settings/usage"
                className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
              >
                View
              </Link>
            </div>
          </div>
        </>
      )}

      <SettingsSection title="Account">
        <div className="space-y-4">
          {user && (
            <div>
              <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Email
              </label>
              <p className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">{user.email}</p>
            </div>
          )}
          <div>
            <Button variant="secondary" onClick={() => logoutMutation.mutate()}>
              Sign out
            </Button>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Appearance">
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Theme
            </label>
            <div className="mt-2 flex gap-2">
              <ThemeButton label="Light" active={theme === 'light'} onClick={() => setTheme('light')} />
              <ThemeButton label="Dark" active={theme === 'dark'} onClick={() => setTheme('dark')} />
              <ThemeButton label="System" active={theme === 'system'} onClick={() => setTheme('system')} />
            </div>
          </div>
        </div>
      </SettingsSection>

      <GitConfigSection />
      <IdentityLinksSection />
      <NotificationPreferencesSection />
    </div>
  );
}

function AgentTab() {
  return (
    <div className="space-y-6">
      <OrchestratorIdentitySection />

      <div className="rounded-lg border border-neutral-200 bg-white p-6 dark:border-neutral-700 dark:bg-neutral-800">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">Agent Personas</h2>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              Create and manage persona instruction files that customize agent behavior.
            </p>
          </div>
          <Link
            to="/settings/personas"
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Manage
          </Link>
        </div>
      </div>

      <ModelPreferencesSection />
      <TimezoneSection />
      <IdleTimeoutSection />
      <SandboxResourcesSection />
      <UiQueueModeSection />
    </div>
  );
}

function DeveloperTab() {
  return (
    <div className="space-y-6">
      <SettingsSection title="API Keys">
        <APIKeyList />
      </SettingsSection>
    </div>
  );
}

// ─── Section Components ─────────────────────────────────────────────────

function GitConfigSection() {
  const user = useAuthStore((s) => s.user);
  const updateProfile = useUpdateProfile();
  const [gitName, setGitName] = React.useState(user?.gitName ?? '');
  const [gitEmail, setGitEmail] = React.useState(user?.gitEmail ?? '');
  const [noReply, setNoReply] = React.useState(
    () => !!user?.gitEmail?.endsWith('@users.noreply.github.com')
  );
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    setGitName(user?.gitName ?? '');
    setGitEmail(user?.gitEmail ?? '');
    setNoReply(!!user?.gitEmail?.endsWith('@users.noreply.github.com'));
  }, [user?.gitName, user?.gitEmail]);

  const hasChanges =
    gitName !== (user?.gitName ?? '') || gitEmail !== (user?.gitEmail ?? '');

  function handleSave() {
    updateProfile.mutate(
      {
        gitName: gitName || undefined,
        gitEmail: gitEmail || undefined,
      },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        },
      }
    );
  }

  return (
    <SettingsSection title="Git Configuration">
      <div className="space-y-4">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Configure the name and email used for git commits in your sandboxes.
        </p>
        <div>
          <label
            htmlFor="git-name"
            className="text-sm font-medium text-neutral-700 dark:text-neutral-300"
          >
            Name
          </label>
          <input
            id="git-name"
            type="text"
            value={gitName}
            onChange={(e) => setGitName(e.target.value)}
            placeholder={user?.name || 'Your Name'}
            className="mt-1 block w-full max-w-md rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-400 dark:focus:ring-neutral-400"
          />
        </div>
        <div>
          <label
            htmlFor="git-email"
            className="text-sm font-medium text-neutral-700 dark:text-neutral-300"
          >
            Email
          </label>
          <input
            id="git-email"
            type="email"
            value={gitEmail}
            onChange={(e) => setGitEmail(e.target.value)}
            disabled={noReply}
            placeholder={user?.email || 'you@example.com'}
            className="mt-1 block w-full max-w-md rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-400 dark:focus:ring-neutral-400"
          />
          {user?.githubUsername && (() => {
            const noReplyAddr = user.githubId
              ? `${user.githubId}+${user.githubUsername}@users.noreply.github.com`
              : `${user.githubUsername}@users.noreply.github.com`;
            return (
              <label className="mt-2 flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
                <input
                  type="checkbox"
                  checked={noReply}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setNoReply(checked);
                    if (checked) {
                      setGitEmail(noReplyAddr);
                    } else {
                      setGitEmail(user.gitEmail?.endsWith('@users.noreply.github.com') ? (user.email ?? '') : user.gitEmail ?? '');
                    }
                  }}
                  className="h-4 w-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:ring-neutral-400"
                />
                Use noreply email
                <code className="rounded bg-neutral-100 px-1 py-0.5 text-xs dark:bg-neutral-800">
                  {noReplyAddr}
                </code>
              </label>
            );
          })()}
        </div>
        <div className="flex items-center gap-3">
          <Button
            onClick={handleSave}
            disabled={!hasChanges || updateProfile.isPending}
          >
            {updateProfile.isPending ? 'Saving...' : 'Save'}
          </Button>
          {saved && (
            <span className="text-sm text-green-600 dark:text-green-400">Saved</span>
          )}
          {updateProfile.isError && (
            <span className="text-sm text-red-600 dark:text-red-400">
              Failed to save. Check that the email is valid.
            </span>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

const IDENTITY_PROVIDERS = [
  { value: 'slack', label: 'Slack' },
  { value: 'github', label: 'GitHub' },
  { value: 'linear', label: 'Linear' },
] as const;

function IdentityLinksSection() {
  const { data: links, isLoading } = useIdentityLinks();
  const createLink = useCreateIdentityLink();
  const deleteLink = useDeleteIdentityLink();
  const [provider, setProvider] = React.useState('slack');
  const [externalId, setExternalId] = React.useState('');
  const [externalName, setExternalName] = React.useState('');
  const [teamId, setTeamId] = React.useState('');

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!externalId.trim()) return;
    createLink.mutate(
      {
        provider,
        externalId: externalId.trim(),
        externalName: externalName.trim() || undefined,
        teamId: teamId.trim() || undefined,
      },
      {
        onSuccess: () => {
          setExternalId('');
          setExternalName('');
          setTeamId('');
        },
      },
    );
  }

  return (
    <SettingsSection title="Linked Identities">
      <div className="space-y-4">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Link your external identities (Slack, GitHub, etc.) so prompts from those platforms can be routed to your orchestrator.
        </p>

        {/* Existing links */}
        {isLoading ? (
          <div className="text-sm text-neutral-400 dark:text-neutral-500">Loading...</div>
        ) : links && links.length > 0 ? (
          <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800/50">
                  <th className="px-4 py-2.5 text-left font-medium text-neutral-500 dark:text-neutral-400">Provider</th>
                  <th className="px-4 py-2.5 text-left font-medium text-neutral-500 dark:text-neutral-400">External ID</th>
                  <th className="px-4 py-2.5 text-left font-medium text-neutral-500 dark:text-neutral-400">Name</th>
                  <th className="px-4 py-2.5 text-left font-medium text-neutral-500 dark:text-neutral-400">Team</th>
                  <th className="px-4 py-2.5 text-right font-medium text-neutral-500 dark:text-neutral-400" />
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200 dark:divide-neutral-700">
                {links.map((link) => (
                  <tr key={link.id} className="bg-white dark:bg-neutral-900">
                    <td className="px-4 py-3 font-medium text-neutral-900 dark:text-neutral-100 capitalize">
                      {link.provider}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-neutral-600 dark:text-neutral-300">
                      {link.externalId}
                    </td>
                    <td className="px-4 py-3 text-neutral-600 dark:text-neutral-300">
                      {link.externalName || '\u2014'}
                    </td>
                    <td className="px-4 py-3 text-neutral-600 dark:text-neutral-300">
                      {link.teamId || '\u2014'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => deleteLink.mutate(link.id)}
                        className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-neutral-400 dark:text-neutral-500">No linked identities yet.</p>
        )}

        {/* Add form */}
        <form onSubmit={handleCreate} className="space-y-3">
          <div className="grid grid-cols-2 gap-3 max-w-lg">
            <div>
              <label htmlFor="identity-provider" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Provider
              </label>
              <select
                id="identity-provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-400 dark:focus:ring-neutral-400"
              >
                {IDENTITY_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="identity-external-id" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                External ID
              </label>
              <input
                id="identity-external-id"
                type="text"
                value={externalId}
                onChange={(e) => setExternalId(e.target.value)}
                placeholder="U0123456789"
                className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-400 dark:focus:ring-neutral-400"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 max-w-lg">
            <div>
              <label htmlFor="identity-name" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Display Name
                <span className="ml-1 text-xs text-neutral-400">(optional)</span>
              </label>
              <input
                id="identity-name"
                type="text"
                value={externalName}
                onChange={(e) => setExternalName(e.target.value)}
                placeholder="@johndoe"
                className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-400 dark:focus:ring-neutral-400"
              />
            </div>
            {provider === 'slack' && (
              <div>
                <label htmlFor="identity-team" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  Team/Workspace ID
                  <span className="ml-1 text-xs text-neutral-400">(optional)</span>
                </label>
                <input
                  id="identity-team"
                  type="text"
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                  placeholder="T0123456789"
                  className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-400 dark:focus:ring-neutral-400"
                />
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              disabled={!externalId.trim() || createLink.isPending}
            >
              {createLink.isPending ? 'Linking...' : 'Link Identity'}
            </Button>
            {createLink.isError && (
              <span className="text-sm text-red-600 dark:text-red-400">
                {(createLink.error as any)?.message?.includes('409')
                  ? 'This identity is already linked'
                  : 'Failed to link identity'}
              </span>
            )}
          </div>
        </form>
      </div>
    </SettingsSection>
  );
}

const IDLE_TIMEOUT_OPTIONS = [
  { label: '5 minutes', value: 300 },
  { label: '10 minutes', value: 600 },
  { label: '15 minutes', value: 900 },
  { label: '30 minutes', value: 1800 },
  { label: '1 hour', value: 3600 },
];

const SANDBOX_CPU_OPTIONS = [
  { label: '0.5 cores', value: 0.5 },
  { label: '1 core', value: 1 },
  { label: '1.5 cores (default)', value: 1.5 },
  { label: '2 cores', value: 2 },
  { label: '4 cores', value: 4 },
];

const SANDBOX_MEMORY_OPTIONS = [
  { label: '512 MiB', value: 512 },
  { label: '1 GiB (default)', value: 1024 },
  { label: '2 GiB', value: 2048 },
  { label: '4 GiB', value: 4096 },
];

const UI_QUEUE_MODE_OPTIONS: Array<{ value: QueueMode; label: string; description: string }> = [
  {
    value: 'followup',
    label: 'Queue (Follow-up)',
    description: 'Keep current work running and queue your new message.',
  },
  {
    value: 'collect',
    label: 'Collect',
    description: 'Briefly collect rapid messages, then send them as one prompt.',
  },
  {
    value: 'steer',
    label: 'Steer (Interrupt)',
    description: 'Abort current work and immediately redirect to your latest message.',
  },
];

function TimezoneSection() {
  const user = useAuthStore((s) => s.user);
  const updateProfile = useUpdateProfile();
  const [saved, setSaved] = React.useState(false);
  const browserTz = React.useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const currentValue = user?.timezone ?? '';

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    updateProfile.mutate(
      { timezone: value || undefined },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        },
      },
    );
  }

  // Auto-detect: if no timezone is saved yet, set it from the browser
  React.useEffect(() => {
    if (!user?.timezone && browserTz) {
      updateProfile.mutate({ timezone: browserTz });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SettingsSection title="Timezone">
      <div className="space-y-4">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Sets the <code className="rounded bg-neutral-100 px-1 py-0.5 text-xs dark:bg-neutral-700">TZ</code> environment variable in new sandboxes so the agent reports your local time.
        </p>
        <div>
          <label
            htmlFor="timezone"
            className="text-sm font-medium text-neutral-700 dark:text-neutral-300"
          >
            Timezone
          </label>
          <select
            id="timezone"
            value={currentValue}
            onChange={handleChange}
            disabled={updateProfile.isPending}
            className="mt-1 block w-full max-w-md rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-400 dark:focus:ring-neutral-400"
          >
            <option value="">Auto-detect ({browserTz})</option>
            {Intl.supportedValuesOf('timeZone').map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
            Applies to new sessions and orchestrator restarts.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {saved && (
            <span className="text-sm text-green-600 dark:text-green-400">Saved</span>
          )}
          {updateProfile.isError && (
            <span className="text-sm text-red-600 dark:text-red-400">Failed to save.</span>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

function IdleTimeoutSection() {
  const user = useAuthStore((s) => s.user);
  const updateProfile = useUpdateProfile();
  const [saved, setSaved] = React.useState(false);
  const currentValue = user?.idleTimeoutSeconds ?? 900;

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = parseInt(e.target.value);
    updateProfile.mutate(
      { idleTimeoutSeconds: value },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        },
      }
    );
  }

  return (
    <SettingsSection title="Session">
      <div className="space-y-4">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Sessions automatically hibernate after a period of inactivity to save resources. They restore transparently when you return.
        </p>
        <div>
          <label
            htmlFor="idle-timeout"
            className="text-sm font-medium text-neutral-700 dark:text-neutral-300"
          >
            Idle timeout
          </label>
          <select
            id="idle-timeout"
            value={currentValue}
            onChange={handleChange}
            disabled={updateProfile.isPending}
            className="mt-1 block w-full max-w-md rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-400 dark:focus:ring-neutral-400"
          >
            {IDLE_TIMEOUT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
            Time before an idle session is hibernated. New sessions will use this setting.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {saved && (
            <span className="text-sm text-green-600 dark:text-green-400">Saved</span>
          )}
          {updateProfile.isError && (
            <span className="text-sm text-red-600 dark:text-red-400">Failed to save.</span>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

function SandboxResourcesSection() {
  const user = useAuthStore((s) => s.user);
  const updateProfile = useUpdateProfile();
  const [saved, setSaved] = React.useState(false);
  const currentCpu = user?.sandboxCpuCores ?? 1.5;
  const currentMemory = user?.sandboxMemoryMib ?? 1024;

  function handleCpuChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = parseFloat(e.target.value);
    updateProfile.mutate(
      { sandboxCpuCores: value },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        },
      }
    );
  }

  function handleMemoryChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = parseInt(e.target.value);
    updateProfile.mutate(
      { sandboxMemoryMib: value },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        },
      }
    );
  }

  const selectClass = "mt-1 block w-full max-w-md rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-400 dark:focus:ring-neutral-400";

  return (
    <SettingsSection title="Sandbox Resources">
      <div className="space-y-4">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Configure CPU and memory allocated to new sandbox sessions. Higher resources improve agent performance but increase compute costs.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 max-w-2xl">
          <div>
            <label
              htmlFor="sandbox-cpu"
              className="text-sm font-medium text-neutral-700 dark:text-neutral-300"
            >
              CPU
            </label>
            <select
              id="sandbox-cpu"
              value={currentCpu}
              onChange={handleCpuChange}
              disabled={updateProfile.isPending}
              className={selectClass}
            >
              {SANDBOX_CPU_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="sandbox-memory"
              className="text-sm font-medium text-neutral-700 dark:text-neutral-300"
            >
              Memory
            </label>
            <select
              id="sandbox-memory"
              value={currentMemory}
              onChange={handleMemoryChange}
              disabled={updateProfile.isPending}
              className={selectClass}
            >
              {SANDBOX_MEMORY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          Only applies to new sessions. Existing sessions keep their current allocation.
        </p>
        <div className="flex items-center gap-3">
          {saved && (
            <span className="text-sm text-green-600 dark:text-green-400">Saved</span>
          )}
          {updateProfile.isError && (
            <span className="text-sm text-red-600 dark:text-red-400">Failed to save.</span>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

function UiQueueModeSection() {
  const user = useAuthStore((s) => s.user);
  const updateProfile = useUpdateProfile();
  const [saved, setSaved] = React.useState(false);
  const currentValue = (user?.uiQueueMode ?? 'followup') as QueueMode;

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value as QueueMode;
    updateProfile.mutate(
      { uiQueueMode: value },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        },
      },
    );
  }

  return (
    <SettingsSection title="UI Message Dispatch">
      <div className="space-y-4">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Choose how new chat messages behave when the agent is already working.
        </p>
        <div>
          <label
            htmlFor="ui-queue-mode"
            className="text-sm font-medium text-neutral-700 dark:text-neutral-300"
          >
            Busy-message behavior
          </label>
          <select
            id="ui-queue-mode"
            value={currentValue}
            onChange={handleChange}
            disabled={updateProfile.isPending}
            className="mt-1 block w-full max-w-md rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-400 dark:focus:ring-neutral-400"
          >
            {UI_QUEUE_MODE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
            {UI_QUEUE_MODE_OPTIONS.find((opt) => opt.value === currentValue)?.description}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {saved && (
            <span className="text-sm text-green-600 dark:text-green-400">Saved</span>
          )}
          {updateProfile.isError && (
            <span className="text-sm text-red-600 dark:text-red-400">Failed to save.</span>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

function useDebounced(value: string, delayMs: number) {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

function OrchestratorIdentitySection() {
  const { data: orchInfo, isLoading } = useOrchestratorInfo();
  const updateIdentity = useUpdateOrchestratorIdentity();
  const [name, setName] = React.useState('');
  const [handle, setHandle] = React.useState('');
  const [customInstructions, setCustomInstructions] = React.useState('');
  const [saved, setSaved] = React.useState(false);

  const debouncedHandle = useDebounced(handle, 400);
  const handleChanged = handle !== (orchInfo?.identity?.handle ?? '');
  const handleCheck = useCheckHandle(handleChanged ? debouncedHandle : '');
  const handleTaken = handleChanged && debouncedHandle.length >= 2 && handleCheck.data?.available === false;

  React.useEffect(() => {
    if (orchInfo?.identity) {
      setName(orchInfo.identity.name);
      setHandle(orchInfo.identity.handle);
      setCustomInstructions(orchInfo.identity.customInstructions ?? '');
    }
  }, [orchInfo?.identity]);

  if (isLoading || !orchInfo?.exists) return null;

  const hasChanges =
    name !== orchInfo.identity?.name ||
    handle !== orchInfo.identity?.handle ||
    customInstructions !== (orchInfo.identity?.customInstructions ?? '');

  function handleSave() {
    if (handleTaken) return;
    updateIdentity.mutate(
      {
        name: name || undefined,
        handle: handle || undefined,
        customInstructions,
      },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        },
      }
    );
  }

  return (
    <SettingsSection title="Orchestrator Identity">
      <div className="space-y-4">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Configure your personal orchestrator's name, handle, and instructions.
        </p>
        <div>
          <label htmlFor="orch-name" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Name
          </label>
          <input
            id="orch-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 block w-full max-w-md rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-400 dark:focus:ring-neutral-400"
          />
        </div>
        <div>
          <label htmlFor="orch-handle" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Handle
          </label>
          <input
            id="orch-handle"
            type="text"
            value={handle}
            onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
            className={`mt-1 block w-full max-w-md rounded-md border bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-1 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 ${
              handleTaken
                ? 'border-red-400 focus:border-red-500 focus:ring-red-500 dark:border-red-500 dark:focus:border-red-400 dark:focus:ring-red-400'
                : 'border-neutral-300 focus:border-neutral-500 focus:ring-neutral-500 dark:border-neutral-600 dark:focus:border-neutral-400 dark:focus:ring-neutral-400'
            }`}
          />
          {handleTaken && (
            <p className="mt-1 text-xs text-red-500 dark:text-red-400">
              Handle @{debouncedHandle} is already taken
            </p>
          )}
        </div>
        <div>
          <label htmlFor="orch-instructions" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Custom Instructions
          </label>
          <textarea
            id="orch-instructions"
            rows={4}
            value={customInstructions}
            onChange={(e) => setCustomInstructions(e.target.value)}
            placeholder="Special instructions for your orchestrator..."
            className="mt-1 block w-full max-w-md rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-400 dark:focus:ring-neutral-400"
          />
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={handleSave} disabled={!hasChanges || handleTaken || updateIdentity.isPending}>
            {updateIdentity.isPending ? 'Saving...' : 'Save'}
          </Button>
          {saved && <span className="text-sm text-green-600 dark:text-green-400">Saved</span>}
          {updateIdentity.isError && (
            <span className="text-sm text-red-600 dark:text-red-400">Failed to save</span>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

const NOTIFICATION_TYPES = [
  { type: 'message', label: 'Messages', description: 'Direct messages from agents or other users' },
  { type: 'notification', label: 'Notifications', description: 'Status updates and informational alerts' },
  { type: 'approval', label: 'Approvals', description: 'Approval requests that need your response' },
  { type: 'question', label: 'Questions', description: 'Questions that require your response' },
  { type: 'escalation', label: 'Escalations', description: 'Urgent items that need your attention' },
] as const;

const NOTIFICATION_EVENT_TYPES_BY_MESSAGE_TYPE: Record<string, Array<{
  eventType: string;
  label: string;
  description: string;
}>> = {
  notification: [
    {
      eventType: 'session.lifecycle',
      label: 'Session lifecycle',
      description: 'Session started/completed status updates',
    },
  ],
};

function NotificationPreferencesSection() {
  const { data: orchInfo, isLoading: orchLoading } = useOrchestratorInfo();
  const { data: preferences } = useNotificationPreferences();
  const updatePrefs = useUpdateNotificationPreferences();

  if (orchLoading || !orchInfo?.exists) return null;

  function getPreference(messageType: string, eventType: string = '*') {
    return preferences?.find(
      (p) => p.messageType === messageType && (p.eventType ?? '*') === eventType,
    );
  }

  function handleToggle(messageType: string, field: 'webEnabled', value: boolean, eventType?: string) {
    updatePrefs.mutate({
      messageType,
      eventType,
      [field]: value,
    });
  }

  return (
    <SettingsSection title="Notification Preferences">
      <div className="space-y-4">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Choose how you receive notifications by message type and event category.
        </p>

        <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-700">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800/50">
                <th className="px-4 py-2.5 text-left font-medium text-neutral-500 dark:text-neutral-400">
                  Type
                </th>
                <th className="px-4 py-2.5 text-center font-medium text-neutral-500 dark:text-neutral-400">
                  Web
                </th>
                <th className="px-4 py-2.5 text-center font-medium text-neutral-500 dark:text-neutral-400">
                  <span className="text-neutral-300 dark:text-neutral-600">Slack</span>
                </th>
                <th className="px-4 py-2.5 text-center font-medium text-neutral-500 dark:text-neutral-400">
                  <span className="text-neutral-300 dark:text-neutral-600">Email</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-700">
              {NOTIFICATION_TYPES.map((nt) => {
                const pref = getPreference(nt.type);
                const webEnabled = pref?.webEnabled ?? true;
                const eventTypes = NOTIFICATION_EVENT_TYPES_BY_MESSAGE_TYPE[nt.type] ?? [];

                return (
                  <React.Fragment key={nt.type}>
                    <tr className="bg-white dark:bg-neutral-900">
                      <td className="px-4 py-3">
                        <div className="font-medium text-neutral-900 dark:text-neutral-100">
                          {nt.label}
                        </div>
                        <div className="text-xs text-neutral-400 dark:text-neutral-500">
                          {nt.description}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <ToggleSwitch
                          checked={webEnabled}
                          onChange={(v) => handleToggle(nt.type, 'webEnabled', v)}
                        />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <ToggleSwitch checked={false} onChange={() => {}} disabled />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <ToggleSwitch checked={false} onChange={() => {}} disabled />
                      </td>
                    </tr>

                    {eventTypes.map((eventPref) => {
                      const eventTypePref = getPreference(nt.type, eventPref.eventType);
                      const eventWebEnabled = eventTypePref?.webEnabled ?? pref?.webEnabled ?? true;

                      return (
                        <tr
                          key={`${nt.type}:${eventPref.eventType}`}
                          className="bg-neutral-50/60 dark:bg-neutral-800/30"
                        >
                          <td className="px-4 py-3">
                            <div className="pl-5">
                              <div className="font-medium text-neutral-800 dark:text-neutral-200">
                                {eventPref.label}
                              </div>
                              <div className="text-xs text-neutral-400 dark:text-neutral-500">
                                {eventPref.description}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <ToggleSwitch
                              checked={eventWebEnabled}
                              onChange={(v) => handleToggle(nt.type, 'webEnabled', v, eventPref.eventType)}
                            />
                          </td>
                          <td className="px-4 py-3 text-center">
                            <ToggleSwitch checked={false} onChange={() => {}} disabled />
                          </td>
                          <td className="px-4 py-3 text-center">
                            <ToggleSwitch checked={false} onChange={() => {}} disabled />
                          </td>
                        </tr>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          Slack and email notifications will be available after integration setup.
        </p>
      </div>
    </SettingsSection>
  );
}

function ToggleSwitch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-neutral-500 focus:ring-offset-2 dark:focus:ring-offset-neutral-900 ${
        disabled
          ? 'cursor-not-allowed opacity-40'
          : ''
      } ${
        checked
          ? 'bg-accent'
          : 'bg-neutral-200 dark:bg-neutral-700'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  );
}

interface FlatModel {
  id: string;
  name: string;
  provider: string;
}

function flattenModels(providers: ProviderModels[]): FlatModel[] {
  return (providers ?? []).flatMap((p) =>
    (p.models ?? []).map((m) => ({ id: m.id, name: m.name, provider: p.provider }))
  );
}

function ModelPreferencesSection() {
  const user = useAuthStore((s) => s.user);
  const updateProfile = useUpdateProfile();
  const { data: availableModels } = useAvailableModels();
  const [models, setModels] = React.useState<string[]>([]);
  const [newModel, setNewModel] = React.useState('');
  const [saved, setSaved] = React.useState(false);
  const [dragIndex, setDragIndex] = React.useState<number | null>(null);
  const [showDropdown, setShowDropdown] = React.useState(false);
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setModels(user?.modelPreferences ?? []);
  }, [user?.modelPreferences]);

  const allModels = React.useMemo(() => flattenModels(availableModels ?? []), [availableModels]);

  const filteredModels = React.useMemo(() => {
    const query = newModel.toLowerCase().trim();
    const candidates = allModels.filter((m) => !models.includes(m.id));
    if (!query) return candidates;
    return candidates.filter(
      (m) =>
        m.name.toLowerCase().includes(query) ||
        m.id.toLowerCase().includes(query) ||
        m.provider.toLowerCase().includes(query)
    );
  }, [newModel, allModels, models]);

  // Close dropdown on outside click
  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current && !inputRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Reset highlight when filtered list changes
  React.useEffect(() => {
    setHighlightedIndex(0);
  }, [filteredModels.length]);

  // Scroll highlighted item into view
  React.useEffect(() => {
    if (!showDropdown || !dropdownRef.current) return;
    const item = dropdownRef.current.children[highlightedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, showDropdown]);

  const hasChanges = JSON.stringify(models) !== JSON.stringify(user?.modelPreferences ?? []);

  function handleSave() {
    updateProfile.mutate(
      { modelPreferences: models },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        },
      }
    );
  }

  function addModel(modelId?: string) {
    const trimmed = (modelId ?? newModel).trim();
    if (trimmed && !models.includes(trimmed)) {
      setModels([...models, trimmed]);
      setNewModel('');
      setShowDropdown(false);
    }
  }

  function removeModel(index: number) {
    setModels(models.filter((_, i) => i !== index));
  }

  function moveModel(from: number, to: number) {
    if (to < 0 || to >= models.length) return;
    const updated = [...models];
    const [item] = updated.splice(from, 1);
    updated.splice(to, 0, item);
    setModels(updated);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!showDropdown || filteredModels.length === 0) {
      if (e.key === 'Enter') {
        e.preventDefault();
        addModel();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex((i) => Math.min(i + 1, filteredModels.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (filteredModels[highlightedIndex]) {
          addModel(filteredModels[highlightedIndex].id);
        } else {
          addModel();
        }
        break;
      case 'Escape':
        setShowDropdown(false);
        break;
    }
  }

  // Determine display name for a model ID
  function getModelDisplay(modelId: string) {
    const flat = allModels.find((m) => m.id === modelId);
    if (flat) return { name: flat.name, provider: flat.provider };
    // Fallback: parse provider from ID
    const slash = modelId.indexOf('/');
    if (slash > 0) return { name: modelId.slice(slash + 1), provider: modelId.slice(0, slash) };
    return { name: modelId, provider: '' };
  }

  return (
    <SettingsSection title="Model Preferences">
      <div className="space-y-4">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Set your preferred model order. When a model encounters a billing, rate limit, or auth error,
          the system will automatically failover to the next model in this list.
        </p>

        {models.length > 0 && (
          <div className="space-y-1.5">
            {models.map((model, index) => {
              const display = getModelDisplay(model);
              return (
                <div
                  key={model}
                  draggable
                  onDragStart={() => setDragIndex(index)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragIndex !== null && dragIndex !== index) {
                      moveModel(dragIndex, index);
                      setDragIndex(index);
                    }
                  }}
                  onDragEnd={() => setDragIndex(null)}
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                    dragIndex === index
                      ? 'border-neutral-400 bg-neutral-50 dark:border-neutral-500 dark:bg-neutral-900'
                      : 'border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-800'
                  } cursor-grab active:cursor-grabbing`}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-neutral-100 font-mono text-[10px] font-semibold text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="truncate text-sm text-neutral-800 dark:text-neutral-200">
                      {display.name}
                    </span>
                    {display.provider && (
                      <span className="ml-2 text-xs text-neutral-400 dark:text-neutral-500">
                        {display.provider}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => moveModel(index, index - 1)}
                      disabled={index === 0}
                      className="rounded p-0.5 text-neutral-400 hover:text-neutral-600 disabled:opacity-30 dark:text-neutral-500 dark:hover:text-neutral-300"
                      title="Move up"
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveModel(index, index + 1)}
                      disabled={index === models.length - 1}
                      className="rounded p-0.5 text-neutral-400 hover:text-neutral-600 disabled:opacity-30 dark:text-neutral-500 dark:hover:text-neutral-300"
                      title="Move down"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeModel(index)}
                      className="rounded p-0.5 text-neutral-400 hover:text-red-500 dark:text-neutral-500 dark:hover:text-red-400"
                      title="Remove"
                    >
                      <XIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="relative max-w-lg">
          <input
            ref={inputRef}
            type="text"
            value={newModel}
            onChange={(e) => {
              setNewModel(e.target.value);
              setShowDropdown(true);
            }}
            onFocus={() => setShowDropdown(true)}
            onKeyDown={handleKeyDown}
            placeholder={allModels.length > 0 ? 'Search models...' : 'provider/model-id'}
            className="block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-400 dark:focus:ring-neutral-400"
          />
          {showDropdown && filteredModels.length > 0 && (
            <div
              ref={dropdownRef}
              className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
            >
              {filteredModels.map((model, i) => (
                <button
                  key={model.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addModel(model.id);
                  }}
                  onMouseEnter={() => setHighlightedIndex(i)}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm ${
                    i === highlightedIndex
                      ? 'bg-neutral-100 dark:bg-neutral-700'
                      : 'hover:bg-neutral-50 dark:hover:bg-neutral-750'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-neutral-900 dark:text-neutral-100">
                      {model.name}
                    </div>
                    <div className="truncate font-mono text-xs text-neutral-400 dark:text-neutral-500">
                      {model.id}
                    </div>
                  </div>
                  <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400">
                    {model.provider}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {allModels.length === 0 && (
          <p className="text-xs text-neutral-400 dark:text-neutral-500">
            Start a session to discover available models, or type a model ID manually (e.g. provider/model-id).
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button
            onClick={handleSave}
            disabled={!hasChanges || updateProfile.isPending}
          >
            {updateProfile.isPending ? 'Saving...' : 'Save'}
          </Button>
          {saved && (
            <span className="text-sm text-green-600 dark:text-green-400">Saved</span>
          )}
          {updateProfile.isError && (
            <span className="text-sm text-red-600 dark:text-red-400">Failed to save</span>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

// ─── Shared Components ──────────────────────────────────────────────────

function ChevronUp({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m18 15-6-6-6 6" />
    </svg>
  );
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function ThemeButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
          : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700'
      }`}
    >
      {label}
    </button>
  );
}

function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-6 dark:border-neutral-700 dark:bg-neutral-800">
      <h2 className="text-lg font-medium text-neutral-900 text-balance dark:text-neutral-100">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </div>
  );
}
