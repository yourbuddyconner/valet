import * as React from 'react';
import { useIntegrations } from '@/api/integrations';
import { useUserCredentials, useDeleteUserCredential } from '@/api/auth';
import { useTelegramConfig, useDisconnectTelegram, useUpdateTelegramConfig } from '@/api/orchestrator';
import {
  useSlackUserStatus,
  useSlackWorkspaceUsers,
  useInitiateSlackLink,
  useVerifySlackLink,
  useUnlinkSlack,
} from '@/api/slack';
import { useGitHubStatus } from '@/api/github';
import { usePlugins } from '@/api/plugins';
import { IntegrationCard } from './integration-card';
import { GitHubCard } from './github-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SearchInput } from '@/components/ui/search-input';
import type { Integration } from '@/api/types';

type StatusFilter = Integration['status'] | 'all';

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'error', label: 'Error' },
  { value: 'pending', label: 'Pending' },
  { value: 'disconnected', label: 'Disconnected' },
];

export function IntegrationList() {
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('all');
  const { data, isLoading: integrationsLoading, error } = useIntegrations();
  const { data: credentials, isLoading: credentialsLoading } = useUserCredentials();
  const { data: telegramConfig, isLoading: telegramLoading } = useTelegramConfig();
  const { data: slackStatus, isLoading: slackLoading } = useSlackUserStatus();
  const { data: githubStatus, isLoading: githubLoading } = useGitHubStatus();
  const { data: plugins } = usePlugins();

  const hasOnePassword = credentials?.some((c) => c.provider === '1password');
  const hasTelegram = !!telegramConfig;
  const hasSlackInstalled = slackStatus?.installed;

  const isLoading = integrationsLoading || credentialsLoading || telegramLoading || slackLoading || githubLoading;

  // Build a unified list of items to render
  const allItems = React.useMemo(() => {
    const items: { key: string; type: '1password' | 'telegram' | 'slack' | 'github' | 'api' | 'auto'; service: string; status: 'active' | 'pending' | 'error' | 'disconnected'; integration?: Integration; icon?: string; description?: string }[] = [];

    if (hasOnePassword) {
      items.push({ key: '1password', type: '1password', service: '1password', status: 'active' });
    }
    if (hasTelegram) {
      items.push({ key: 'telegram', type: 'telegram', service: 'telegram', status: 'active' });
    }
    if (hasSlackInstalled) {
      items.push({
        key: 'slack',
        type: 'slack',
        service: 'slack',
        status: slackStatus?.linked ? 'active' : 'pending',
      });
    }
    // Always show GitHub card if OAuth is configured
    if (githubStatus?.oauthConfigured) {
      items.push({
        key: 'github',
        type: 'github',
        service: 'github',
        status: githubStatus.personal.linked ? 'active' : 'pending',
      });
    }
    if (data?.integrations) {
      const dedicatedServices = new Set(items.map((i) => i.service));
      for (const integration of data.integrations) {
        if (dedicatedServices.has(integration.service)) continue;
        items.push({ key: integration.id, type: 'api', service: integration.service, status: integration.status, integration });
      }
    }

    // Add auto-enabled plugins (no auth required) that aren't already represented
    const existingServices = new Set(items.map((i) => i.service));
    if (plugins) {
      for (const plugin of plugins) {
        if (!plugin.authRequired && plugin.status === 'active' && !existingServices.has(plugin.name)) {
          items.push({
            key: `auto:${plugin.name}`,
            type: 'auto',
            service: plugin.name,
            status: 'active',
            icon: plugin.icon,
            description: plugin.description,
          });
        }
      }
    }

    return items;
  }, [hasOnePassword, hasTelegram, hasSlackInstalled, slackStatus?.linked, githubStatus?.oauthConfigured, githubStatus?.personal.linked, data?.integrations, plugins]);

  const filteredItems = React.useMemo(() => {
    return allItems.filter((item) => {
      if (statusFilter !== 'all' && item.status !== statusFilter) {
        return false;
      }
      if (search) {
        return item.service.toLowerCase().includes(search.toLowerCase());
      }
      return true;
    });
  }, [allItems, search, statusFilter]);

  if (isLoading) {
    return <IntegrationListSkeleton />;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
        <p className="text-sm text-red-600 text-pretty dark:text-red-400">
          Failed to load integrations. Please try again.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="w-full sm:max-w-xs">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search integrations..."
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {STATUS_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => setStatusFilter(option.value)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                statusFilter === option.value
                  ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                  : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {allItems.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-8 text-center dark:border-neutral-700 dark:bg-neutral-800">
          <p className="text-sm text-neutral-500 text-pretty dark:text-neutral-400">
            No integrations configured. Connect your first service to get started.
          </p>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-8 text-center dark:border-neutral-700 dark:bg-neutral-800">
          <p className="text-sm text-neutral-500 text-pretty dark:text-neutral-400">
            No integrations match your filters.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredItems.map((item) => {
            if (item.type === '1password') {
              return <OnePasswordCard key={item.key} />;
            }
            if (item.type === 'telegram') {
              return <TelegramCard key={item.key} config={telegramConfig!} />;
            }
            if (item.type === 'slack') {
              return <SlackCard key={item.key} />;
            }
            if (item.type === 'github') {
              return <GitHubCard key={item.key} />;
            }
            if (item.type === 'auto') {
              return <AutoEnabledCard key={item.key} service={item.service} icon={item.icon} description={item.description} />;
            }
            return <IntegrationCard key={item.key} integration={item.integration!} />;
          })}
        </div>
      )}
    </div>
  );
}

// ─── Configured Integration Cards ───────────────────────────────────────

function OnePasswordCard() {
  const deleteCredential = useDeleteUserCredential();

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
            <OnePasswordIcon className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">1Password</CardTitle>
            <p className="text-xs text-green-600 dark:text-green-400">Connected</p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Service account token configured
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => deleteCredential.mutate('1password')}
            disabled={deleteCredential.isPending}
          >
            {deleteCredential.isPending ? 'Removing...' : 'Disconnect'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TelegramCard({ config }: { config: { botUsername: string; webhookActive: boolean; ownerTelegramUserId?: string } }) {
  const disconnectTelegram = useDisconnectTelegram();
  const updateConfig = useUpdateTelegramConfig();
  const [editingOwner, setEditingOwner] = React.useState(false);
  const [ownerValue, setOwnerValue] = React.useState(config.ownerTelegramUserId || '');

  // Sync local state when config updates (e.g. after mutation or refetch)
  React.useEffect(() => {
    if (!editingOwner) {
      setOwnerValue(config.ownerTelegramUserId || '');
    }
  }, [config.ownerTelegramUserId, editingOwner]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
            <TelegramIcon className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">Telegram</CardTitle>
            <p className="text-xs text-green-600 dark:text-green-400">
              @{config.botUsername}
              {config.webhookActive ? ' \u00b7 Webhook active' : ''}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <label className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Owner Telegram User ID</label>
          {editingOwner ? (
            <div className="mt-1 flex items-center gap-2">
              <input
                type="text"
                value={ownerValue}
                onChange={(e) => setOwnerValue(e.target.value)}
                className="flex-1 rounded border px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-800"
                placeholder="Telegram user ID"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  updateConfig.mutate({ ownerTelegramUserId: ownerValue }, {
                    onSuccess: () => setEditingOwner(false),
                  });
                }}
                disabled={updateConfig.isPending}
              >
                Save
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setEditingOwner(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="mt-1 flex items-center gap-2">
              <p className="text-sm text-neutral-700 dark:text-neutral-300">
                {config.ownerTelegramUserId || 'Not set — send /start to your bot'}
              </p>
              <Button variant="secondary" size="sm" onClick={() => setEditingOwner(true)}>
                Edit
              </Button>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Bot connected to orchestrator
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => disconnectTelegram.mutate()}
            disabled={disconnectTelegram.isPending}
          >
            {disconnectTelegram.isPending ? 'Disconnecting...' : 'Disconnect'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Slack Identity Link Card ───────────────────────────────────────

function SlackCard() {
  const { data: status } = useSlackUserStatus();
  const unlinkSlack = useUnlinkSlack();
  const [linking, setLinking] = React.useState(false);

  if (!status) return null;

  if (status.linked) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
              <SlackIcon className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Slack</CardTitle>
              <p className="text-xs text-green-600 dark:text-green-400">
                Linked{status.slackDisplayName ? ` as ${status.slackDisplayName}` : ''}
                {status.teamName ? ` in ${status.teamName}` : ''}
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Messages route to your orchestrator
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => unlinkSlack.mutate()}
              disabled={unlinkSlack.isPending}
            >
              {unlinkSlack.isPending ? 'Unlinking...' : 'Unlink'}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
            <SlackIcon className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">Slack</CardTitle>
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Not linked{status.teamName ? ` — ${status.teamName}` : ''}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {linking ? (
          <SlackLinkFlow onClose={() => setLinking(false)} />
        ) : (
          <div className="flex items-center justify-between">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Link your Slack account to receive messages
            </p>
            <Button variant="secondary" size="sm" onClick={() => setLinking(true)}>
              Link Account
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SlackLinkFlow({ onClose }: { onClose: () => void }) {
  const { data: workspaceUsers, isLoading: usersLoading } = useSlackWorkspaceUsers();
  const initiateLink = useInitiateSlackLink();
  const verifyLink = useVerifySlackLink();
  const [step, setStep] = React.useState<'select' | 'verify'>('select');
  const [search, setSearch] = React.useState('');
  const [selectedUser, setSelectedUser] = React.useState<{ id: string; displayName: string } | null>(null);
  const [code, setCode] = React.useState('');

  const filteredUsers = React.useMemo(() => {
    if (!workspaceUsers) return [];
    if (!search.trim()) return workspaceUsers;
    const q = search.toLowerCase();
    return workspaceUsers.filter(
      (u) =>
        u.displayName.toLowerCase().includes(q) ||
        u.realName.toLowerCase().includes(q)
    );
  }, [workspaceUsers, search]);

  function handleSelectUser(user: { id: string; displayName: string; realName: string }) {
    setSelectedUser({ id: user.id, displayName: user.displayName || user.realName });
    initiateLink.mutate(
      { slackUserId: user.id, slackDisplayName: user.displayName || user.realName },
      {
        onSuccess: () => setStep('verify'),
      }
    );
  }

  function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    verifyLink.mutate(
      { code: code.trim().toUpperCase() },
      { onSuccess: onClose }
    );
  }

  if (step === 'verify') {
    return (
      <div className="space-y-3">
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          A verification code was sent to <span className="font-medium text-neutral-700 dark:text-neutral-300">{selectedUser?.displayName}</span> via DM. Enter it below.
        </p>
        <form onSubmit={handleVerify} className="flex items-center gap-2">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
            placeholder="AX7K2M"
            maxLength={6}
            autoFocus
            className="w-28 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-center font-mono text-sm tracking-widest text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
          />
          <Button size="sm" type="submit" disabled={code.length !== 6 || verifyLink.isPending}>
            {verifyLink.isPending ? 'Verifying...' : 'Verify'}
          </Button>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
          >
            Cancel
          </button>
        </form>
        {verifyLink.isError && (
          <p className="text-xs text-red-600 dark:text-red-400">
            {(verifyLink.error as Error)?.message || 'Invalid code. Please try again.'}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search workspace members..."
          autoFocus
          className="flex-1 rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-xs text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
        />
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
        >
          Cancel
        </button>
      </div>
      {usersLoading ? (
        <div className="space-y-1">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-neutral-100 dark:bg-neutral-700" />
          ))}
        </div>
      ) : (
        <div className="max-h-40 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700">
          {filteredUsers.length === 0 ? (
            <p className="px-3 py-2 text-xs text-neutral-400">No users found</p>
          ) : (
            filteredUsers.map((user) => (
              <button
                key={user.id}
                type="button"
                onClick={() => handleSelectUser(user)}
                disabled={initiateLink.isPending}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-neutral-50 disabled:opacity-50 dark:hover:bg-neutral-750"
              >
                {user.avatar ? (
                  <img src={user.avatar} alt="" className="h-5 w-5 rounded" />
                ) : (
                  <div className="h-5 w-5 rounded bg-neutral-200 dark:bg-neutral-600" />
                )}
                <span className="font-medium text-neutral-900 dark:text-neutral-100">{user.displayName}</span>
                {user.realName !== user.displayName && (
                  <span className="text-neutral-400 dark:text-neutral-500">{user.realName}</span>
                )}
              </button>
            ))
          )}
        </div>
      )}
      {initiateLink.isError && (
        <p className="text-xs text-red-600 dark:text-red-400">
          {(initiateLink.error as Error)?.message || 'Failed to send verification code.'}
        </p>
      )}
    </div>
  );
}

// ─── Auto-Enabled Card ──────────────────────────────────────────────────

const autoServiceLabels: Record<string, string> = {
  deepwiki: 'DeepWiki',
};

function AutoEnabledCard({ service, icon, description }: { service: string; icon?: string; description?: string }) {
  const label = autoServiceLabels[service] ?? service.charAt(0).toUpperCase() + service.slice(1);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-100 text-lg dark:bg-neutral-700">
            {icon ?? '🔌'}
          </div>
          <div>
            <CardTitle className="text-base">{label}</CardTitle>
            <p className="text-xs text-green-600 dark:text-green-400">Active</p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          No login required{description ? ` — ${description.toLowerCase()}` : ''}
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Icons ──────────────────────────────────────────────────────────────

function OnePasswordIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .007C5.373.007 0 5.376 0 11.999c0 6.624 5.373 11.994 12 11.994S24 18.623 24 12C24 5.376 18.627.007 12 .007Zm-.895 4.857h1.788c.484 0 .729.002.914.096a.86.86 0 0 1 .377.377c.094.185.095.428.095.912v6.016c0 .12 0 .182-.015.238a.427.427 0 0 1-.067.137.923.923 0 0 1-.174.162l-.695.564c-.113.092-.17.138-.191.194a.216.216 0 0 0 0 .15c.02.055.078.101.191.193l.695.565c.094.076.14.115.174.162.03.042.053.087.067.137a.936.936 0 0 1 .015.238v2.746c0 .484-.001.727-.095.912a.86.86 0 0 1-.377.377c-.185.094-.43.096-.914.096h-1.788c-.484 0-.726-.002-.912-.096a.86.86 0 0 1-.377-.377c-.094-.185-.095-.428-.095-.912v-6.016c0-.12 0-.182.015-.238a.437.437 0 0 1 .067-.139c.034-.047.08-.083.174-.16l.695-.564c.113-.092.17-.138.191-.194a.216.216 0 0 0 0-.15c-.02-.055-.078-.101-.191-.193l-.695-.565a.92.92 0 0 1-.174-.162.437.437 0 0 1-.067-.139.92.92 0 0 1-.015-.236V6.25c0-.484.001-.727.095-.912a.86.86 0 0 1 .377-.377c.186-.094.428-.096.912-.096z" />
    </svg>
  );
}

function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

function SlackIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
    </svg>
  );
}

function IntegrationListSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="rounded-lg border border-neutral-200 bg-white p-6"
        >
          <div className="flex items-start gap-3">
            <Skeleton className="h-10 w-10 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-4 w-32" />
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-8 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}
