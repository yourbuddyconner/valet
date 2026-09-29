import { useRef, useState } from "react";
import type {
  GetGithubAppResponse,
  GithubAppInstallationSummary,
  PostGithubAppManifestResponse,
} from "@valet/api/wire";
import { Badge, Button, ConfirmDialog, Input, Spinner, Switch, Textarea } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { livePollInterval } from "~/lib/use-live-query";
import { relativeTime } from "~/lib/relative-time";
import {
  qkSettings,
  useOrg,
  usePatchOrgSettings,
  useCreateGithubAppManifest,
  useDeleteGithubApp,
  useGithubApp,
  useRefreshGithubApp,
  useSaveGithubAppCredential,
} from "~/api/settings";

/** The server checks installations on its own (`POST /refresh` is the
 * impatient path, not the only one), so the one state worth polling is the
 * incomplete one: an App exists and nothing is installed yet, which is exactly
 * when somebody is watching this page after installing on GitHub. The poll
 * stops as soon as an installation appears, and the query library holds it in
 * a hidden tab. This hits our own API and never GitHub. */
const SETUP_POLL_MS = 15_000;

function setupPollInterval(data: GetGithubAppResponse | undefined): number | false {
  return livePollInterval(data, (reply) => reply.configured && reply.installations.length === 0, SETUP_POLL_MS);
}


/**
 * Organization · GitHub — the App setup flow (GitHub/repo integration plan,
 * Task 5/11), rendered inside `/settings/organization`'s `OrgRouteGuard`.
 * Two states: not-configured and configured (app card + installations table
 * + refresh + webhook-mode badge + destructive removal).
 *
 * The not-configured state offers two paths. Creating an App is the default:
 * a "Create GitHub App" button mints a manifest and hands the browser off to
 * GitHub via a POSTed form, because GitHub's manifest flow only accepts a
 * browser form submission, not a fetch/XHR. Below it, `ExistingAppCard`
 * connects an App that already exists — the path for anyone whose App name
 * is taken, since App names are global on GitHub and the second creation
 * attempt is refused on GitHub's own page, where this app never sees it.
 */
export function GithubAppSection() {
  const githubAppQ = useGithubApp({
    // `useGithubApp` sets the same key; `UseQueryOptions` makes it required.
    queryKey: qkSettings.githubApp(),
    refetchInterval: (query) => setupPollInterval(query.state.data),
  });

  if (githubAppQ.isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted">
        <Spinner size={14} /> Loading…
      </div>
    );
  }
  if (githubAppQ.error) {
    return <div className="py-4 text-sm text-danger-500">Failed to load the GitHub App.</div>;
  }
  if (!githubAppQ.data) return null;

  return githubAppQ.data.configured ? (
    <ConfiguredCard
      data={githubAppQ.data}
      checkedAt={githubAppQ.data.installationsCheckedAt}
    />
  ) : (
    <NotConfiguredCard webhookMode={githubAppQ.data.webhook.mode} />
  );
}

// GitHub App permissions the picker offers (V1 parity), with the levels
// GitHub actually supports per permission.
const AVAILABLE_PERMISSIONS: { key: string; label: string; levels: string[] }[] = [
  { key: "contents", label: "Repository contents", levels: ["read", "write"] },
  { key: "metadata", label: "Metadata", levels: ["read"] },
  { key: "pull_requests", label: "Pull requests", levels: ["read", "write"] },
  { key: "issues", label: "Issues", levels: ["read", "write"] },
  { key: "actions", label: "Actions", levels: ["read", "write"] },
  { key: "checks", label: "Checks", levels: ["read", "write"] },
  { key: "statuses", label: "Commit statuses", levels: ["read", "write"] },
  { key: "deployments", label: "Deployments", levels: ["read", "write"] },
  { key: "environments", label: "Environments", levels: ["read", "write"] },
  { key: "pages", label: "Pages", levels: ["read", "write"] },
  { key: "workflows", label: "Workflows", levels: ["write"] },
  { key: "members", label: "Organization members", levels: ["read"] },
  { key: "administration", label: "Administration", levels: ["read", "write"] },
];

const AVAILABLE_EVENTS = [
  "push", "pull_request", "issues", "issue_comment",
  "create", "delete", "release", "workflow_run",
  "check_run", "check_suite", "status",
];

// Mirror the server defaults so opening the picker shows what an untouched
// create would request.
const DEFAULT_PERMISSIONS: Record<string, string> = {
  contents: "write",
  metadata: "read",
  pull_requests: "write",
  issues: "write",
  actions: "write",
  checks: "read",
  statuses: "read",
};

const DEFAULT_EVENTS = ["push", "pull_request", "issue_comment"];

function NotConfiguredCard({ webhookMode }: { webhookMode: "public" | "manual" }) {
  const createManifest = useCreateGithubAppManifest();
  const [manifest, setManifest] = useState<PostGithubAppManifestResponse | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // Target: personal account by default; switch on to create the App
  // under a GitHub organization instead.
  const [underOrg, setUnderOrg] = useState(false);
  const [githubOrg, setGithubOrg] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [permissions, setPermissions] = useState<Record<string, string>>(DEFAULT_PERMISSIONS);
  const [events, setEvents] = useState<string[]>(DEFAULT_EVENTS);
  // Webhook delivery: only possible when the server has a public URL —
  // GitHub rejects manifests whose hook URL isn't publicly reachable,
  // so the switch is forced off and disabled in manual mode.
  const webhookPossible = webhookMode === "public";
  const [webhookOn, setWebhookOn] = useState(webhookPossible);

  const orgMissing = underOrg && githubOrg.trim().length === 0;

  async function create() {
    try {
      const res = await createManifest.mutateAsync({
        webhook: webhookPossible && webhookOn,
        ...(underOrg && githubOrg.trim() ? { target: `org:${githubOrg.trim()}` } : {}),
        ...(showAdvanced ? { permissions, events } : {}),
      });
      setManifest(res);
    } catch {
      // useMutation surfaces the error via `createManifest.error`.
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="rounded-lg border border-line bg-paper">
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-line px-6 py-5">
          <span
            aria-hidden="true"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-base font-semibold text-white"
            style={{ backgroundColor: "#24292f" }}
          >
            G
          </span>
          <div className="min-w-0">
            <div className="font-display text-base text-ink">Create a GitHub App</div>
            <p className="mt-0.5 text-sm leading-relaxed text-muted">
              One click sets up an App the assistant uses to clone and push to your repos —
              GitHub walks you through the final confirmation.
            </p>
          </div>
        </div>

        {/* Options */}
        <div className="divide-y divide-line/60 px-6">
          <div className="space-y-3 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <label htmlFor="gh-under-org" className="text-sm font-medium text-ink">
                  Create under a GitHub organization
                </label>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">
                  Off — the App is created on your personal GitHub account.
                </p>
              </div>
              <Switch
                id="gh-under-org"
                checked={underOrg}
                onCheckedChange={setUnderOrg}
                aria-label="Create under a GitHub organization"
              />
            </div>
            {underOrg && (
              <div className="max-w-xs space-y-1.5">
                <Input
                  value={githubOrg}
                  onChange={(e) => setGithubOrg(e.target.value)}
                  placeholder="acme-corp"
                  aria-label="GitHub organization"
                />
                <p className="text-xs text-muted">
                  The GitHub organization the App is created and installed under.
                </p>
              </div>
            )}
          </div>

          <div className="flex items-start justify-between gap-4 py-4">
            <div className="min-w-0">
              <label htmlFor="gh-webhook" className="text-sm font-medium text-ink">
                Deliver webhook events
              </label>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">
                {webhookPossible
                  ? "GitHub pushes repo events to this server as they happen."
                  : "Needs a public URL GitHub can reach — set VALET_PUBLIC_URL (e.g. a tunnel) and reload. Without it the App is created with no webhook."}
              </p>
            </div>
            <Switch
              id="gh-webhook"
              checked={webhookPossible && webhookOn}
              onCheckedChange={setWebhookOn}
              disabled={!webhookPossible}
              aria-label="Deliver webhook events"
            />
          </div>

          <div className="py-4">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
              className="text-xs font-medium text-muted underline-offset-2 hover:text-ink hover:underline"
            >
              {showAdvanced ? "Hide permissions" : "Configure permissions"}
            </button>

            {showAdvanced && (
              <div className="mt-4 space-y-5">
                <div>
                  <p className="mb-2.5 text-[10px] font-medium uppercase tracking-wider text-muted">
                    Permissions
                  </p>
                  <div className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
                    {AVAILABLE_PERMISSIONS.map((perm) => (
                      <label
                        key={perm.key}
                        className="flex items-center justify-between gap-3 text-xs text-ink"
                      >
                        <span className="truncate">{perm.label}</span>
                        <select
                          value={permissions[perm.key] ?? ""}
                          aria-label={`${perm.label} permission`}
                          onChange={(e) => {
                            setPermissions((prev) => {
                              const next = { ...prev };
                              if (e.target.value) next[perm.key] = e.target.value;
                              else delete next[perm.key];
                              return next;
                            });
                          }}
                          className={
                            "w-20 shrink-0 rounded-md border border-line px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss " +
                            ((permissions[perm.key] ?? "") === ""
                              ? "bg-paper text-muted"
                              : "bg-moss-wash font-medium text-ink")
                          }
                        >
                          <option value="">none</option>
                          {perm.levels.map((level) => (
                            <option key={level} value={level}>
                              {level}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                </div>

                {webhookPossible && webhookOn && (
                  <div>
                    <p className="mb-2.5 text-[10px] font-medium uppercase tracking-wider text-muted">
                      Webhook events
                    </p>
                    <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 sm:grid-cols-3">
                      {AVAILABLE_EVENTS.map((event) => (
                        <label
                          key={event}
                          className="flex items-center gap-2 font-mono text-xs text-ink"
                        >
                          <input
                            type="checkbox"
                            className="accent-[--moss]"
                            checked={events.includes(event)}
                            onChange={(e) => {
                              setEvents((prev) =>
                                e.target.checked
                                  ? [...prev, event]
                                  : prev.filter((ev) => ev !== event),
                              );
                            }}
                          />
                          {event}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-4 border-t border-line px-6 py-4">
          <p className="text-xs text-muted">
            You review everything on GitHub before the App is created.
          </p>
          <Button
            type="button"
            onClick={() => void create()}
            disabled={createManifest.isPending || orgMissing}
          >
            {createManifest.isPending ? "Creating…" : "Create GitHub App"}
          </Button>
        </div>
      </div>

      {createManifest.error && (
        <p className="text-sm text-danger-500">{createManifest.error.message}</p>
      )}

      {manifest && (
        <div className="space-y-3 rounded-lg border border-line bg-ink-wash p-5">
          <p className="text-sm text-ink">
            Ready — continue to GitHub to finish creating the app.
          </p>
          {/* GitHub's manifest-creation flow requires a real browser POST
              (not fetch/XHR): the form target is GitHub's own page, which
              redirects back to our `/setup` callback with a `code` GitHub
              mints, using the signed `state` we round-trip via the query
              string. */}
          <form
            ref={formRef}
            method="post"
            action={`${manifest.url}?state=${encodeURIComponent(manifest.state)}`}
            data-testid="github-manifest-form"
          >
            <input type="hidden" name="manifest" value={JSON.stringify(manifest.manifest)} />
          </form>
          <Button type="button" variant="primary" onClick={() => formRef.current?.submit()}>
            Continue to GitHub
          </Button>
        </div>
      )}

      <ExistingAppCard />
    </div>
  );
}

/**
 * The second path: connect a GitHub App that already exists.
 *
 * Two people need it. Someone who already made an App cannot make a second
 * one with the same name — App names are global on GitHub, so that attempt
 * is refused on GitHub's page, which this app never sees and cannot explain.
 * Someone whose database was reset still has the App, but no longer has the
 * credential row that points at it.
 *
 * Only the App ID and the private key are asked for. The server reads the
 * slug, the page URL and the OAuth client id from GitHub while it checks the
 * credential, so a wrong paste is refused here instead of at the first tool
 * call. The two secrets below them cannot be read from GitHub, and each one
 * only turns on the feature named beside it.
 */
function ExistingAppCard() {
  const save = useSaveGithubAppCredential();
  const [open, setOpen] = useState(false);
  const [appId, setAppId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [appSlug, setAppSlug] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");

  const incomplete = appId.trim().length === 0 || privateKey.trim().length === 0;

  async function connect() {
    try {
      await save.mutateAsync({
        appId: appId.trim(),
        privateKey,
        ...(appSlug.trim() ? { appSlug: appSlug.trim() } : {}),
        ...(oauthClientId.trim() ? { oauthClientId: oauthClientId.trim() } : {}),
        ...(oauthClientSecret ? { oauthClientSecret } : {}),
        ...(webhookSecret ? { webhookSecret } : {}),
      });
      // On success the section re-renders as the configured card, because the
      // mutation invalidates the App query.
    } catch {
      // useMutation surfaces the error via `save.error`.
    }
  }

  if (!open) {
    return (
      <div className="rounded-lg border border-line bg-paper px-6 py-4">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-sm font-medium text-ink underline-offset-2 hover:underline"
        >
          I already have a GitHub App
        </button>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          App names are global on GitHub, so creating a second App with the same name fails.
          Connect the one you have instead.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line bg-paper">
      <div className="border-b border-line px-6 py-5">
        <div className="font-display text-base text-ink">Connect an App you already have</div>
        <p className="mt-0.5 text-sm leading-relaxed text-muted">
          Open the App's settings page on GitHub, copy the App ID, and generate a private key.
          The App ID and the key are all that is needed — the rest is read from GitHub.
        </p>
      </div>

      <div className="space-y-4 px-6 py-5">
        <div className="max-w-xs space-y-1.5">
          <label htmlFor="gh-app-id" className="text-sm font-medium text-ink">
            App ID
          </label>
          <Input
            id="gh-app-id"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder="123456"
            aria-label="App ID"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="gh-private-key" className="text-sm font-medium text-ink">
            Private key
          </label>
          <Textarea
            id="gh-private-key"
            rows={5}
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
            placeholder="-----BEGIN RSA PRIVATE KEY-----"
            aria-label="Private key"
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted">
            Paste the whole .pem file GitHub downloaded, including the BEGIN and END lines.
            A base64 copy of it also works.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="gh-client-secret" className="text-sm font-medium text-ink">
              Client secret <span className="font-normal text-muted">— optional</span>
            </label>
            <Input
              id="gh-client-secret"
              type="password"
              value={oauthClientSecret}
              onChange={(e) => setOauthClientSecret(e.target.value)}
              aria-label="Client secret"
            />
            <p className="text-xs leading-relaxed text-muted">
              Needed only so people can sign in to GitHub with their own account.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="gh-webhook-secret" className="text-sm font-medium text-ink">
              Webhook secret <span className="font-normal text-muted">— optional</span>
            </label>
            <Input
              id="gh-webhook-secret"
              type="password"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              aria-label="Webhook secret"
            />
            <p className="text-xs leading-relaxed text-muted">
              Needed only to receive repo events. Without it every delivery is refused.
            </p>
          </div>
        </div>

        <details className="text-xs">
          <summary className="cursor-pointer text-muted hover:text-ink">
            GitHub did not report the slug or client ID
          </summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="gh-app-slug" className="text-sm font-medium text-ink">
                App slug
              </label>
              <Input
                id="gh-app-slug"
                value={appSlug}
                onChange={(e) => setAppSlug(e.target.value)}
                placeholder="my-app"
                aria-label="App slug"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="gh-client-id" className="text-sm font-medium text-ink">
                Client ID
              </label>
              <Input
                id="gh-client-id"
                value={oauthClientId}
                onChange={(e) => setOauthClientId(e.target.value)}
                placeholder="Iv1.0123456789abcdef"
                aria-label="Client ID"
              />
            </div>
          </div>
        </details>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line px-6 py-4">
        {/* Storing the key makes this server the App's owner, and it moves the
            App's webhook URL here on save and at every restart. Anyone
            connecting an App that another server already uses has to know
            that before they paste, not after deliveries stop arriving. */}
        <p className="max-w-md text-xs leading-relaxed text-muted">
          This server takes over the App's webhook URL. Do not connect an App another Valet
          server uses.
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void connect()} disabled={save.isPending || incomplete}>
            {save.isPending ? "Checking with GitHub…" : "Connect App"}
          </Button>
        </div>
      </div>

      {save.error && (
        <p className="border-t border-line px-6 py-3 text-sm text-danger-500">{errorText(save.error)}</p>
      )}
    </div>
  );
}

/** How long a quiet sweep may stay quiet before the page says so. The slowest
 * tier checks every 6 h, so four intervals is a day — long enough that a
 * healthy webhook-live org never trips it. */
const STALE_AFTER_MS = 4 * 6 * 60 * 60_000;

function ConfiguredCard({
  data,
  checkedAt,
}: {
  data: { app?: { appId: string; appSlug: string; htmlUrl: string; installUrl: string }; installations: GithubAppInstallationSummary[]; webhook: { mode: "public" | "manual" } };
  /** When the server last read the installations from GitHub, epoch ms.
   * `null` when there are no installation rows to date from. */
  checkedAt: number | null;
}) {
  const refresh = useRefreshGithubApp();
  const deleteApp = useDeleteGithubApp();
  const orgQ = useOrg();
  const patchSettings = usePatchOrgSettings();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const app = data.app;
  const uninstalled = data.installations.length === 0;

  return (
    <div className="space-y-6">
      {/* The App exists but grants access to NOTHING until it's installed
          on an account — the step people miss, because GitHub's creation
          flow ends without prompting for it. Loud on purpose. */}
      {uninstalled && app && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-amber-300 bg-amber-50/70 px-5 py-4 dark:border-amber-700/60 dark:bg-amber-950/40">
          <div className="min-w-0">
            <div className="text-sm font-medium text-ink">One step left — install the App</div>
            {/* Both webhook modes now pick the install up on their own: with
                a webhook the delivery does it, and without one the background
                sweep does. The button below stays for anybody who does not
                want to wait for the next check. */}
            <p className="mt-0.5 text-xs leading-relaxed text-muted">
              The App is created, but nothing works until it's installed on a GitHub account
              and granted repos. After installing, come back — Valet picks it up within a few
              minutes. Choose Refresh installations to see it now.
            </p>
          </div>
          <Button asChild>
            <a href={app.installUrl} target="_blank" rel="noreferrer">
              Install on GitHub
            </a>
          </Button>
        </div>
      )}

      <div className="space-y-3 rounded-md border border-line p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="text-sm font-medium text-ink">{app?.appSlug}</div>
            <div className="text-xs text-muted">App ID {app?.appId}</div>
            {app && (
              <a
                href={app.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-moss underline"
              >
                View on GitHub
              </a>
            )}
          </div>
          <Badge variant={data.webhook.mode === "public" ? "success" : "neutral"}>
            {data.webhook.mode}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          {app && !uninstalled && (
            <Button asChild variant="secondary" size="sm">
              <a href={app.installUrl} target="_blank" rel="noreferrer">
                Install on another account
              </a>
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            {refresh.isPending ? "Refreshing…" : "Refresh installations"}
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={deleteApp.isPending}
            onClick={() => {
              // Radix fires no `onOpenChange(true)` here, so the stale refusal is cleared on open.
              deleteApp.reset();
              setConfirmRemove(true);
            }}
          >
            {deleteApp.isPending ? "Removing…" : "Remove App"}
          </Button>
        </div>
      </div>

      {/* The server drops only this org's credential and installation rows;
          the App itself stays on GitHub. That is why the description promises
          a way back: the "I already have a GitHub App" path reappears as soon
          as the credential is gone. */}
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the GitHub App?"
        description="Runtimes using it for repo access lose that access. The App stays on GitHub, so you can connect it again with its App ID and private key."
        confirmLabel="Remove App"
        pendingLabel="Removing…"
        pending={deleteApp.isPending}
        error={deleteApp.error != null ? errorText(deleteApp.error) : undefined}
        onConfirm={() => deleteApp.mutate(undefined, { onSuccess: () => setConfirmRemove(false) })}
      />

      <div className="flex items-start justify-between gap-4 border-t border-line pt-4">
        <div className="min-w-0">
          <label htmlFor="gh-personal-installations" className="text-sm font-medium text-ink">
            Allow personal installations
          </label>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">
            Allow members to install the GitHub App on personal accounts.
          </p>
        </div>
        <Switch
          id="gh-personal-installations"
          checked={orgQ.data?.allowPersonalInstallations ?? true}
          disabled={patchSettings.isPending}
          onCheckedChange={(allowPersonalInstallations) => patchSettings.mutate({ allowPersonalInstallations })}
          aria-label="Allow personal installations"
        />
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted">Installations</h3>
          {/* The answer to "it is not updating": one line saying when the
              server last read GitHub. Without a timestamp there is nothing to
              date from, so say what is happening instead of guessing. */}
          <span className="text-xs text-muted">
            {checkedAt === null ? "Checking automatically" : `Checked ${relativeTime(checkedAt)}`}
          </span>
        </div>
        {checkedAt !== null && Date.now() - checkedAt > STALE_AFTER_MS && (
          <p className="text-xs text-muted">
            This is older than expected. Choose Refresh installations to see the error.
          </p>
        )}
        {data.installations.length === 0 ? (
          <p className="text-sm text-muted">
            No installations yet — the App can't reach any repos until it's installed.
          </p>
        ) : (
          <div className="divide-y divide-line border-t border-line">
            {data.installations.map((inst) => (
              <div key={inst.id} className="flex items-center gap-3 py-3 text-sm">
                <div className="min-w-0 flex-1 truncate font-medium text-ink">
                  {inst.accountLogin}
                </div>
                <div className="w-28 shrink-0 text-xs text-muted">{inst.accountType}</div>
                <div className="w-20 shrink-0 text-xs text-muted">
                  {inst.repositorySelection ?? "—"}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {inst.suspended && <Badge variant="danger">Suspended</Badge>}
                  {inst.linkedUserId && <Badge variant="accent">Linked</Badge>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
