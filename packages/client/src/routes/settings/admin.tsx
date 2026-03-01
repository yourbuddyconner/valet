import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { useAuthStore } from '@/stores/auth';
import { Button } from '@/components/ui/button';
import {
  useOrgSettings,
  useUpdateOrgSettings,
  useOrgLLMKeys,
  useSetLLMKey,
  useDeleteLLMKey,
  useCustomProviders,
  useUpsertCustomProvider,
  useDeleteCustomProvider,
  useDiscoverModels,
  useInvites,
  useCreateInvite,
  useDeleteInvite,
  useOrgUsers,
  useUpdateUserRole,
  useRemoveUser,
} from '@/api/admin';
import { useOrgRepos, useCreateOrgRepo, useDeleteOrgRepo, useSetRepoPersonaDefault } from '@/api/org-repos';
import { usePersonas } from '@/api/personas';
import type { UserRole, CustomProviderModel } from '@agent-ops/shared';
import { formatDate } from '../../lib/format';
import { Input } from '@/components/ui/input';
import { useAvailableModels } from '@/api/sessions';
import type { ProviderModels } from '@/api/sessions';
import { useSlackInstallStatus, useInstallSlack, useUninstallSlack } from '@/api/slack';

export const Route = createFileRoute('/settings/admin')({
  component: AdminSettingsPage,
});

const inputClass =
  'mt-1 block w-full max-w-md rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-400 dark:focus:ring-neutral-400';

const selectClass =
  'mt-1 block w-full max-w-md rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-400 dark:focus:ring-neutral-400';

function AdminSettingsPage() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();

  // Redirect non-admins
  React.useEffect(() => {
    if (user && user.role !== 'admin') {
      navigate({ to: '/settings', search: { tab: 'general' } });
    }
  }, [user, navigate]);

  if (!user || user.role !== 'admin') {
    return null;
  }

  return (
    <PageContainer>
      <PageHeader
        title="Organization"
        description="Manage your organization settings, members, and API keys"
      />

      <div className="space-y-6">
        <OrgNameSection />
        <OrgModelPreferencesSection />
        <OrgReposSection />
        <LLMKeysSection />
        <SlackInstallSection />
        <CustomProvidersSection />
        <AccessControlSection />
        <InvitesSection />
        <UsersSection currentUserId={user.id} />
      </div>
    </PageContainer>
  );
}

// --- Organization Name ---

function OrgNameSection() {
  const { data: settings } = useOrgSettings();
  const updateSettings = useUpdateOrgSettings();
  const [name, setName] = React.useState('');
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    if (settings?.name) setName(settings.name);
  }, [settings?.name]);

  const hasChanges = name !== (settings?.name ?? '');

  function handleSave() {
    updateSettings.mutate(
      { name },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        },
      }
    );
  }

  return (
    <Section title="Organization">
      <div className="space-y-4">
        <div>
          <label htmlFor="org-name" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Name
          </label>
          <input
            id="org-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Organization"
            className={inputClass}
          />
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={handleSave} disabled={!hasChanges || updateSettings.isPending}>
            {updateSettings.isPending ? 'Saving...' : 'Save'}
          </Button>
          {saved && <span className="text-sm text-green-600 dark:text-green-400">Saved</span>}
        </div>
      </div>
    </Section>
  );
}

// --- Org Model Preferences ---

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

function OrgModelPreferencesSection() {
  const { data: settings } = useOrgSettings();
  const updateSettings = useUpdateOrgSettings();
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
    setModels(settings?.modelPreferences ?? []);
  }, [settings?.modelPreferences]);

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

  React.useEffect(() => {
    setHighlightedIndex(0);
  }, [filteredModels.length]);

  React.useEffect(() => {
    if (!showDropdown || !dropdownRef.current) return;
    const item = dropdownRef.current.children[highlightedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, showDropdown]);

  const hasChanges = JSON.stringify(models) !== JSON.stringify(settings?.modelPreferences ?? []);

  function handleSave() {
    updateSettings.mutate(
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

  function getModelDisplay(modelId: string) {
    const flat = allModels.find((m) => m.id === modelId);
    if (flat) return { name: flat.name, provider: flat.provider };
    const slash = modelId.indexOf('/');
    if (slash > 0) return { name: modelId.slice(slash + 1), provider: modelId.slice(0, slash) };
    return { name: modelId, provider: '' };
  }

  return (
    <Section title="Default Model Preferences">
      <div className="space-y-4">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Set the organization default model order. These are used when a user has no personal model preferences configured.
          When a model encounters a billing, rate limit, or auth error, the system fails over to the next model in the list.
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
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="m18 15-6-6-6 6" /></svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => moveModel(index, index + 1)}
                      disabled={index === models.length - 1}
                      className="rounded p-0.5 text-neutral-400 hover:text-neutral-600 disabled:opacity-30 dark:text-neutral-500 dark:hover:text-neutral-300"
                      title="Move down"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="m6 9 6 6 6-6" /></svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeModel(index)}
                      className="rounded p-0.5 text-neutral-400 hover:text-red-500 dark:text-neutral-500 dark:hover:text-red-400"
                      title="Remove"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
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
            className={inputClass}
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
            disabled={!hasChanges || updateSettings.isPending}
          >
            {updateSettings.isPending ? 'Saving...' : 'Save'}
          </Button>
          {saved && (
            <span className="text-sm text-green-600 dark:text-green-400">Saved</span>
          )}
          {updateSettings.isError && (
            <span className="text-sm text-red-600 dark:text-red-400">Failed to save</span>
          )}
        </div>
      </div>
    </Section>
  );
}

// --- Org Repositories ---

function OrgReposSection() {
  const { data: repos, isLoading } = useOrgRepos();
  const { data: personas } = usePersonas();
  const createRepo = useCreateOrgRepo();
  const deleteRepo = useDeleteOrgRepo();
  const setDefault = useSetRepoPersonaDefault();
  const [fullName, setFullName] = React.useState('');

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!fullName.trim() || !fullName.includes('/')) return;
    createRepo.mutate(
      { fullName: fullName.trim() },
      { onSuccess: () => setFullName('') }
    );
  }

  return (
    <Section title="Org Repositories">
      <div className="space-y-4">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Known repositories for your organization. You can assign a default persona to each repo.
        </p>

        <form onSubmit={handleAdd} className="flex items-end gap-3">
          <div className="flex-1">
            <label htmlFor="repo-name" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Add repository
            </label>
            <Input
              id="repo-name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="owner/repo"
            />
          </div>
          <Button type="submit" disabled={!fullName.includes('/') || createRepo.isPending}>
            {createRepo.isPending ? 'Adding...' : 'Add'}
          </Button>
        </form>

        {createRepo.isError && (
          <p className="text-sm text-red-600 dark:text-red-400">
            Failed to add repository.
          </p>
        )}

        {isLoading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-md bg-neutral-100 dark:bg-neutral-700" />
            ))}
          </div>
        ) : repos && repos.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 dark:border-neutral-700">
                <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Repository</th>
                <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Language</th>
                <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Default Persona</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {repos.map((repo) => (
                <tr key={repo.id} className="border-b border-neutral-100 dark:border-neutral-700/50">
                  <td className="py-2 text-neutral-900 dark:text-neutral-100">{repo.fullName}</td>
                  <td className="py-2 text-neutral-500 dark:text-neutral-400">{repo.language || '-'}</td>
                  <td className="py-2">
                    <select
                      value={repo.personaId || ''}
                      onChange={(e) =>
                        setDefault.mutate({
                          repoId: repo.id,
                          personaId: e.target.value || null,
                        })
                      }
                      className="rounded border border-neutral-200 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
                    >
                      <option value="">None</option>
                      {personas?.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.icon ? `${p.icon} ` : ''}{p.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      variant="secondary"
                      onClick={() => deleteRepo.mutate(repo.id)}
                      disabled={deleteRepo.isPending}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">No repositories added yet.</p>
        )}
      </div>
    </Section>
  );
}

// --- Slack App Install ---

function SlackInstallSection() {
  const { data: installStatus, isLoading } = useSlackInstallStatus();
  const installSlack = useInstallSlack();
  const uninstallSlack = useUninstallSlack();
  const [botToken, setBotToken] = React.useState('');
  const [signingSecret, setSigningSecret] = React.useState('');
  const [editing, setEditing] = React.useState(false);
  const [confirmUninstall, setConfirmUninstall] = React.useState(false);

  const isInstalled = installStatus?.installed;

  function handleInstall(e: React.FormEvent) {
    e.preventDefault();
    if (!botToken.trim()) return;
    installSlack.mutate(
      {
        botToken: botToken.trim(),
        signingSecret: signingSecret.trim() || undefined,
      },
      {
        onSuccess: () => {
          setBotToken('');
          setSigningSecret('');
          setEditing(false);
        },
      }
    );
  }

  function handleUninstall() {
    uninstallSlack.mutate(undefined, {
      onSuccess: () => setConfirmUninstall(false),
    });
  }

  return (
    <Section title="Slack">
      <div className="space-y-4">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Install the Slack app for your organization. Once installed, team members can link their Slack accounts from the Integrations page.
        </p>

        {isLoading ? (
          <div className="h-12 animate-pulse rounded-md bg-neutral-100 dark:bg-neutral-700" />
        ) : isInstalled ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-neutral-700 dark:bg-neutral-800/50">
              <SlackIcon className="h-5 w-5 text-neutral-600 dark:text-neutral-300" />
              <div className="flex-1">
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  {installStatus.teamName || 'Slack Workspace'}
                </p>
                <p className="text-xs text-green-600 dark:text-green-400">
                  Connected{installStatus.hasSigningSecret ? '' : ' · No signing secret'}
                </p>
              </div>
              {confirmUninstall ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-red-600 dark:text-red-400">Confirm?</span>
                  <Button
                    variant="secondary"
                    onClick={handleUninstall}
                    disabled={uninstallSlack.isPending}
                  >
                    {uninstallSlack.isPending ? 'Removing...' : 'Remove'}
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirmUninstall(false)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button variant="secondary" onClick={() => setConfirmUninstall(true)}>
                  Uninstall
                </Button>
              )}
            </div>
            {uninstallSlack.isError && (
              <p className="text-sm text-red-600 dark:text-red-400">Failed to uninstall Slack app.</p>
            )}
          </div>
        ) : editing ? (
          <form onSubmit={handleInstall} className="space-y-3">
            <div>
              <label htmlFor="slack-token" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Bot Token
              </label>
              <input
                id="slack-token"
                type="password"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="xoxb-..."
                autoComplete="off"
                autoFocus
                className={inputClass}
              />
              <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
                Create a Slack app, install it to your workspace, and paste the Bot User OAuth Token here.
              </p>
            </div>
            <div>
              <label htmlFor="slack-signing-secret" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Signing Secret
              </label>
              <input
                id="slack-signing-secret"
                type="password"
                value={signingSecret}
                onChange={(e) => setSigningSecret(e.target.value)}
                placeholder="abc123..."
                autoComplete="off"
                className={inputClass}
              />
              <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
                Found under Basic Information &gt; App Credentials in your Slack app settings. Used to verify inbound events.
              </p>
            </div>
            {installSlack.isError && (
              <p className="text-sm text-red-600 dark:text-red-400">
                {(installSlack.error as Error)?.message || 'Failed to install Slack app.'}
              </p>
            )}
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={!botToken.trim() || installSlack.isPending}>
                {installSlack.isPending ? 'Installing...' : 'Install'}
              </Button>
              <Button type="button" variant="secondary" onClick={() => { setEditing(false); setBotToken(''); setSigningSecret(''); }}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Install Slack App
          </Button>
        )}
      </div>
    </Section>
  );
}

function SlackIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
    </svg>
  );
}

// --- LLM API Keys ---

const LLM_PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'google', label: 'Google' },
  { id: 'parallel', label: 'Parallel' },
] as const;

function LLMKeysSection() {
  const { data: keys, isLoading } = useOrgLLMKeys();

  return (
    <Section title="LLM API Keys">
      <div className="space-y-4">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Organization-level API keys are used for all sandboxes. If not set, environment variable defaults are used.
        </p>
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-md bg-neutral-100 dark:bg-neutral-700" />
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            {LLM_PROVIDERS.map((provider) => {
              const existing = keys?.find((k) => k.provider === provider.id);
              return (
                <LLMKeyRow key={provider.id} provider={provider.id} label={provider.label} isSet={!!existing} />
              );
            })}
          </div>
        )}
      </div>
    </Section>
  );
}

function LLMKeyRow({ provider, label, isSet }: { provider: string; label: string; isSet: boolean }) {
  const setKey = useSetLLMKey();
  const deleteKey = useDeleteLLMKey();
  const [value, setValue] = React.useState('');
  const [editing, setEditing] = React.useState(false);

  function handleSave() {
    setKey.mutate(
      { provider, key: value },
      {
        onSuccess: () => {
          setValue('');
          setEditing(false);
        },
      }
    );
  }

  return (
    <div className="flex items-center gap-3">
      <div className="w-24 text-sm font-medium text-neutral-700 dark:text-neutral-300">{label}</div>
      {editing ? (
        <>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="sk-..."
            className={inputClass + ' !mt-0 flex-1'}
            autoFocus
          />
          <Button onClick={handleSave} disabled={!value || setKey.isPending}>
            {setKey.isPending ? 'Saving...' : 'Save'}
          </Button>
          <Button variant="secondary" onClick={() => { setEditing(false); setValue(''); }}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          <span className="flex-1 text-sm text-neutral-500 dark:text-neutral-400">
            {isSet ? '••••••••••••' : 'Not set (using env var)'}
          </span>
          <Button variant="secondary" onClick={() => setEditing(true)}>
            {isSet ? 'Update' : 'Set'}
          </Button>
          {isSet && (
            <Button
              variant="secondary"
              onClick={() => deleteKey.mutate(provider)}
              disabled={deleteKey.isPending}
            >
              Remove
            </Button>
          )}
        </>
      )}
    </div>
  );
}

// --- Custom Providers ---

function CustomProvidersSection() {
  const { data: providers, isLoading } = useCustomProviders();
  const [adding, setAdding] = React.useState(false);

  return (
    <Section title="Custom LLM Providers">
      <div className="space-y-4">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Add OpenAI-compatible LLM providers (self-hosted models, Together AI, Fireworks, etc.) that will be available in sandboxes.
        </p>
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-md bg-neutral-100 dark:bg-neutral-700" />
            ))}
          </div>
        ) : (
          <>
            {providers && providers.length > 0 && (
              <div className="overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-700">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800/50">
                      <th className="px-3 py-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Provider ID</th>
                      <th className="px-3 py-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Name</th>
                      <th className="px-3 py-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Base URL</th>
                      <th className="px-3 py-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Models</th>
                      <th className="px-3 py-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Key</th>
                      <th className="px-3 py-2 text-right font-medium text-neutral-600 dark:text-neutral-400">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providers.map((p) => (
                      <CustomProviderRow key={p.id} provider={p} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {adding ? (
              <CustomProviderForm onCancel={() => setAdding(false)} onSaved={() => setAdding(false)} />
            ) : (
              <Button variant="secondary" onClick={() => setAdding(true)}>
                Add Provider
              </Button>
            )}
          </>
        )}
      </div>
    </Section>
  );
}

function CustomProviderRow({ provider }: { provider: import('@agent-ops/shared').CustomProvider }) {
  const deleteProvider = useDeleteCustomProvider();
  const [editing, setEditing] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  if (editing) {
    return (
      <tr>
        <td colSpan={6} className="p-3">
          <CustomProviderForm
            existing={provider}
            onCancel={() => setEditing(false)}
            onSaved={() => setEditing(false)}
          />
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-neutral-100 last:border-0 dark:border-neutral-700/50">
      <td className="px-3 py-2 font-mono text-xs text-neutral-700 dark:text-neutral-300">{provider.providerId}</td>
      <td className="px-3 py-2 text-neutral-900 dark:text-neutral-100">{provider.displayName}</td>
      <td className="px-3 py-2 text-neutral-500 dark:text-neutral-400 truncate max-w-[200px]">{provider.baseUrl}</td>
      <td className="px-3 py-2 text-neutral-500 dark:text-neutral-400">{provider.models.length}</td>
      <td className="px-3 py-2 text-neutral-500 dark:text-neutral-400">{provider.hasKey ? 'Set' : 'None'}</td>
      <td className="px-3 py-2 text-right">
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
          {confirmDelete ? (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  deleteProvider.mutate(provider.providerId, { onSuccess: () => setConfirmDelete(false) });
                }}
                disabled={deleteProvider.isPending}
              >
                Confirm
              </Button>
              <Button variant="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setConfirmDelete(true)}>Delete</Button>
          )}
        </div>
      </td>
    </tr>
  );
}

function ModelIdInput({
  value,
  onChange,
  discoveredModels,
}: {
  value: string;
  onChange: (value: string) => void;
  discoveredModels: string[];
}) {
  const [showDropdown, setShowDropdown] = React.useState(false);
  const [highlightIndex, setHighlightIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  const filtered = React.useMemo(() => {
    if (discoveredModels.length === 0) return [];
    const q = value.toLowerCase();
    if (!q) return discoveredModels;
    return discoveredModels.filter((m) => m.toLowerCase().includes(q));
  }, [value, discoveredModels]);

  React.useEffect(() => {
    setHighlightIndex(0);
  }, [filtered.length]);

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

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!showDropdown || filtered.length === 0) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightIndex((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        if (filtered[highlightIndex]) {
          e.preventDefault();
          onChange(filtered[highlightIndex]);
          setShowDropdown(false);
        }
        break;
      case 'Escape':
        setShowDropdown(false);
        break;
    }
  }

  return (
    <div className="relative flex-[4] min-w-0">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setShowDropdown(true);
        }}
        onFocus={() => { if (discoveredModels.length > 0) setShowDropdown(true); }}
        onKeyDown={handleKeyDown}
        placeholder="model-id"
        className={inputClass + ' !mt-0 !max-w-none w-full'}
      />
      {showDropdown && filtered.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute z-20 mt-1 max-h-48 min-w-[360px] overflow-auto rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
        >
          {filtered.map((modelId, i) => (
            <button
              key={modelId}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(modelId);
                setShowDropdown(false);
              }}
              onMouseEnter={() => setHighlightIndex(i)}
              className={`block w-full truncate px-3 py-1.5 text-left font-mono text-xs ${
                i === highlightIndex
                  ? 'bg-neutral-100 dark:bg-neutral-700'
                  : 'hover:bg-neutral-50 dark:hover:bg-neutral-750'
              }`}
            >
              {modelId}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CustomProviderForm({
  existing,
  onCancel,
  onSaved,
}: {
  existing?: import('@agent-ops/shared').CustomProvider;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const upsert = useUpsertCustomProvider();
  const discover = useDiscoverModels();
  const [providerId, setProviderId] = React.useState(existing?.providerId ?? '');
  const [displayName, setDisplayName] = React.useState(existing?.displayName ?? '');
  const [baseUrl, setBaseUrl] = React.useState(existing?.baseUrl ?? '');
  const [apiKey, setApiKey] = React.useState('');
  const [models, setModels] = React.useState<CustomProviderModel[]>(
    existing?.models ?? [{ id: '' }]
  );
  const [discoveredModels, setDiscoveredModels] = React.useState<string[]>([]);
  const [discoverStatus, setDiscoverStatus] = React.useState<
    { type: 'success'; count: number } | { type: 'error'; message: string } | null
  >(null);

  function handleTest() {
    if (!baseUrl.trim()) return;
    setDiscoverStatus(null);
    discover.mutate(
      { baseUrl: baseUrl.trim(), apiKey: apiKey || undefined },
      {
        onSuccess: (data) => {
          const ids = data.models.map((m) => m.id);
          setDiscoveredModels(ids);
          setDiscoverStatus({ type: 'success', count: ids.length });
        },
        onError: (err: any) => {
          setDiscoveredModels([]);
          setDiscoverStatus({ type: 'error', message: err?.message ?? 'Connection failed' });
        },
      }
    );
  }

  function addModel() {
    setModels([...models, { id: '' }]);
  }

  function removeModel(index: number) {
    if (models.length <= 1) return;
    setModels(models.filter((_, i) => i !== index));
  }

  function updateModel(index: number, field: keyof CustomProviderModel, value: string | number) {
    const updated = [...models];
    updated[index] = { ...updated[index], [field]: value };
    setModels(updated);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validModels = models.filter((m) => m.id.trim().length > 0);
    if (validModels.length === 0) return;

    upsert.mutate(
      {
        providerId,
        displayName,
        baseUrl,
        apiKey: apiKey || undefined,
        models: validModels.map((m) => ({
          id: m.id,
          name: m.name || undefined,
          contextLimit: m.contextLimit || undefined,
          outputLimit: m.outputLimit || undefined,
        })),
      },
      { onSuccess: onSaved }
    );
  }

  const isValid = providerId.trim().length > 0 && /^[a-z0-9-]+$/.test(providerId) &&
    displayName.trim().length > 0 && baseUrl.trim().length > 0 &&
    models.some((m) => m.id.trim().length > 0);

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-md border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-800/50">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">Provider ID</label>
          <input
            value={providerId}
            onChange={(e) => setProviderId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            placeholder="together-ai"
            className={inputClass}
            disabled={!!existing}
            maxLength={50}
          />
          <p className="mt-1 text-xs text-neutral-400">Lowercase, alphanumeric, hyphens only</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">Display Name</label>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Together AI"
            className={inputClass}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">Base URL</label>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.together.xyz/v1"
            className={inputClass}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">API Key (optional)</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={existing?.hasKey ? '(unchanged)' : 'sk-...'}
            className={inputClass}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          onClick={handleTest}
          disabled={!baseUrl.trim() || discover.isPending}
        >
          {discover.isPending ? 'Testing...' : 'Test Connection'}
        </Button>
        {discoverStatus?.type === 'success' && (
          <span className="flex items-center gap-1.5 text-sm text-green-600 dark:text-green-400">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            Connected — {discoverStatus.count} models found
          </span>
        )}
        {discoverStatus?.type === 'error' && (
          <span className="text-sm text-red-600 dark:text-red-400">
            Connection failed — check URL and API key
          </span>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">Models</label>
        <div className="mt-2 space-y-2">
          {models.map((model, i) => (
            <div key={i} className="flex items-center gap-2">
              <ModelIdInput
                value={model.id}
                onChange={(v) => updateModel(i, 'id', v)}
                discoveredModels={discoveredModels}
              />
              <input
                value={model.name ?? ''}
                onChange={(e) => updateModel(i, 'name', e.target.value)}
                placeholder="Display name"
                className={inputClass + ' !mt-0 !max-w-none flex-1'}
              />
              <input
                type="number"
                value={model.contextLimit ?? ''}
                onChange={(e) => updateModel(i, 'contextLimit', parseInt(e.target.value) || 0)}
                placeholder="Ctx"
                className={inputClass + ' !mt-0 w-20 shrink-0'}
              />
              <input
                type="number"
                value={model.outputLimit ?? ''}
                onChange={(e) => updateModel(i, 'outputLimit', parseInt(e.target.value) || 0)}
                placeholder="Out"
                className={inputClass + ' !mt-0 w-20 shrink-0'}
              />
              <Button type="button" variant="secondary" onClick={() => removeModel(i)} disabled={models.length <= 1}>
                -
              </Button>
            </div>
          ))}
          <Button type="button" variant="secondary" onClick={addModel}>
            + Add Model
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={!isValid || upsert.isPending}>
          {upsert.isPending ? 'Saving...' : existing ? 'Update Provider' : 'Add Provider'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// --- Access Control ---

function AccessControlSection() {
  const { data: settings } = useOrgSettings();
  const updateSettings = useUpdateOrgSettings();
  const [domainGating, setDomainGating] = React.useState(false);
  const [domain, setDomain] = React.useState('');
  const [emailAllowlist, setEmailAllowlist] = React.useState(false);
  const [emails, setEmails] = React.useState('');
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    if (settings) {
      setDomainGating(settings.domainGatingEnabled);
      setDomain(settings.allowedEmailDomain ?? '');
      setEmailAllowlist(settings.emailAllowlistEnabled);
      setEmails(settings.allowedEmails ?? '');
    }
  }, [settings]);

  function handleSave() {
    updateSettings.mutate(
      {
        domainGatingEnabled: domainGating,
        allowedEmailDomain: domain || undefined,
        emailAllowlistEnabled: emailAllowlist,
        allowedEmails: emails || undefined,
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
    <Section title="Access Control">
      <div className="space-y-4">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Control who can sign up. If nothing is enabled, signups are open to anyone (or controlled by invites).
        </p>

        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="domain-gating"
            checked={domainGating}
            onChange={(e) => setDomainGating(e.target.checked)}
            className="mt-1 rounded border-neutral-300 dark:border-neutral-600"
          />
          <div>
            <label htmlFor="domain-gating" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Restrict signups to email domain
            </label>
            {domainGating && (
              <input
                type="text"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="acme.com"
                className={inputClass}
              />
            )}
          </div>
        </div>

        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="email-allowlist"
            checked={emailAllowlist}
            onChange={(e) => setEmailAllowlist(e.target.checked)}
            className="mt-1 rounded border-neutral-300 dark:border-neutral-600"
          />
          <div>
            <label htmlFor="email-allowlist" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Use email allowlist
            </label>
            {emailAllowlist && (
              <textarea
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                placeholder="user1@example.com, user2@example.com"
                rows={3}
                className={inputClass + ' !max-w-lg'}
              />
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={handleSave} disabled={updateSettings.isPending}>
            {updateSettings.isPending ? 'Saving...' : 'Save'}
          </Button>
          {saved && <span className="text-sm text-green-600 dark:text-green-400">Saved</span>}
        </div>
      </div>
    </Section>
  );
}

// --- Invites ---

function InvitesSection() {
  const { data: invites, isLoading } = useInvites();
  const createInvite = useCreateInvite();
  const deleteInvite = useDeleteInvite();
  const [role, setRole] = React.useState<UserRole>('member');
  const [email, setEmail] = React.useState('');
  const [copiedCode, setCopiedCode] = React.useState<string | null>(null);

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createInvite.mutate(
      { role, email: email || undefined },
      { onSuccess: () => { setRole('member'); setEmail(''); } }
    );
  }

  function getInviteUrl(code: string): string {
    return `${window.location.origin}/invite/${code}`;
  }

  function copyLink(code: string) {
    navigator.clipboard.writeText(getInviteUrl(code));
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  }

  return (
    <Section title="Invites">
      <div className="space-y-4">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Create an invite link to share with anyone. They'll sign in with OAuth and join with the assigned role.
        </p>

        <form onSubmit={handleCreate} className="flex items-end gap-3">
          <div>
            <label htmlFor="invite-role" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Role
            </label>
            <select
              id="invite-role"
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              className={selectClass}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="flex-1">
            <label htmlFor="invite-email" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Email <span className="text-neutral-400 font-normal">(optional, for your reference)</span>
            </label>
            <input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              className={inputClass}
            />
          </div>
          <Button type="submit" disabled={createInvite.isPending}>
            {createInvite.isPending ? 'Creating...' : 'Create Invite'}
          </Button>
        </form>

        {createInvite.isSuccess && createInvite.data?.code && (
          <div className="rounded-md border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-900/20">
            <p className="text-sm font-medium text-green-800 dark:text-green-300 mb-1">Invite created! Share this link:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-sm bg-white dark:bg-neutral-800 rounded px-2 py-1 text-neutral-700 dark:text-neutral-300 border border-neutral-200 dark:border-neutral-700 truncate">
                {getInviteUrl(createInvite.data.code)}
              </code>
              <Button
                variant="secondary"
                onClick={() => copyLink(createInvite.data!.code)}
              >
                {copiedCode === createInvite.data.code ? 'Copied!' : 'Copy'}
              </Button>
            </div>
          </div>
        )}

        {createInvite.isError && (
          <p className="text-sm text-red-600 dark:text-red-400">
            Failed to create invite.
          </p>
        )}

        {isLoading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-md bg-neutral-100 dark:bg-neutral-700" />
            ))}
          </div>
        ) : invites && invites.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 dark:border-neutral-700">
                <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Code</th>
                <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Role</th>
                <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Status</th>
                <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Created</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {invites.map((invite) => {
                const isExpired = new Date(invite.expiresAt) < new Date();
                const isAccepted = !!invite.acceptedAt;
                const status = isAccepted ? 'Accepted' : isExpired ? 'Expired' : 'Pending';

                return (
                  <tr
                    key={invite.id}
                    className={`border-b border-neutral-100 dark:border-neutral-700/50 ${isExpired || isAccepted ? 'opacity-50' : ''}`}
                  >
                    <td className="py-2 text-neutral-900 dark:text-neutral-100">
                      <span className="font-mono text-xs">{invite.code.slice(0, 8)}...</span>
                      {invite.email && (
                        <span className="ml-2 text-neutral-400 dark:text-neutral-500 text-xs">{invite.email}</span>
                      )}
                    </td>
                    <td className="py-2 capitalize text-neutral-700 dark:text-neutral-300">{invite.role}</td>
                    <td className="py-2">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                          isAccepted
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : isExpired
                              ? 'bg-neutral-100 text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400'
                              : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                        }`}
                      >
                        {status}
                      </span>
                    </td>
                    <td className="py-2 text-neutral-500 dark:text-neutral-400">
                      {formatDate(invite.createdAt)}
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex items-center gap-2 justify-end">
                        {!isAccepted && !isExpired && (
                          <Button
                            variant="secondary"
                            onClick={() => copyLink(invite.code)}
                          >
                            {copiedCode === invite.code ? 'Copied!' : 'Copy Link'}
                          </Button>
                        )}
                        {!isAccepted && (
                          <Button
                            variant="secondary"
                            onClick={() => deleteInvite.mutate(invite.id)}
                            disabled={deleteInvite.isPending}
                          >
                            Revoke
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">No invites yet.</p>
        )}
      </div>
    </Section>
  );
}

// --- Users ---

function UsersSection({ currentUserId }: { currentUserId: string }) {
  const { data: users, isLoading } = useOrgUsers();
  const updateRole = useUpdateUserRole();
  const removeUser = useRemoveUser();
  const [confirmDelete, setConfirmDelete] = React.useState<string | null>(null);

  const adminCount = users?.filter((u) => u.role === 'admin').length ?? 0;

  return (
    <Section title="Members">
      <div className="space-y-4">
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-md bg-neutral-100 dark:bg-neutral-700" />
            ))}
          </div>
        ) : users && users.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 dark:border-neutral-700">
                <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">User</th>
                <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Role</th>
                <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Joined</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = u.id === currentUserId;
                const isLastAdmin = u.role === 'admin' && adminCount <= 1;

                return (
                  <tr key={u.id} className="border-b border-neutral-100 dark:border-neutral-700/50">
                    <td className="py-2">
                      <div>
                        <span className="text-neutral-900 dark:text-neutral-100">
                          {u.name || u.email}
                        </span>
                        {u.name && (
                          <span className="ml-2 text-neutral-400 dark:text-neutral-500">{u.email}</span>
                        )}
                        {isSelf && (
                          <span className="ml-2 text-xs text-neutral-400 dark:text-neutral-500">(you)</span>
                        )}
                      </div>
                    </td>
                    <td className="py-2">
                      <select
                        value={u.role}
                        onChange={(e) =>
                          updateRole.mutate({ userId: u.id, role: e.target.value as UserRole })
                        }
                        disabled={isSelf || isLastAdmin || updateRole.isPending}
                        className="rounded border border-neutral-200 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
                      >
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                      </select>
                    </td>
                    <td className="py-2 text-neutral-500 dark:text-neutral-400">
                      {formatDate(u.createdAt)}
                    </td>
                    <td className="py-2 text-right">
                      {!isSelf && !isLastAdmin && (
                        <>
                          {confirmDelete === u.id ? (
                            <div className="flex items-center gap-2 justify-end">
                              <span className="text-xs text-red-600 dark:text-red-400">Confirm?</span>
                              <Button
                                variant="secondary"
                                onClick={() => {
                                  removeUser.mutate(u.id, { onSettled: () => setConfirmDelete(null) });
                                }}
                                disabled={removeUser.isPending}
                              >
                                Remove
                              </Button>
                              <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <Button variant="secondary" onClick={() => setConfirmDelete(u.id)}>
                              Remove
                            </Button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">No users found.</p>
        )}

        {updateRole.isError && (
          <p className="text-sm text-red-600 dark:text-red-400">
            Failed to update role. {(updateRole.error as Error)?.message}
          </p>
        )}
        {removeUser.isError && (
          <p className="text-sm text-red-600 dark:text-red-400">
            Failed to remove user. {(removeUser.error as Error)?.message}
          </p>
        )}
      </div>
    </Section>
  );
}

// --- Shared Section component ---

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-6 dark:border-neutral-700 dark:bg-neutral-800">
      <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">{title}</h2>
      <div className="mt-4">{children}</div>
    </div>
  );
}
