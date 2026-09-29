import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { CredentialSummary, IdentityLinkStatus, StartIdentityLinkResponse } from "@valet/api/wire";
import {
  useIdentityLinks,
  useSetLinkNotify,
  useStartIdentityLink,
  useUnlinkIdentity,
} from "~/api/queries";
import { useConnectGithub, useDisconnectGithub } from "~/api/repos";
import { useCredentials, useDisconnectCredential } from "~/api/integrations";
import { useGithubApp } from "~/api/settings";
import { ApiError } from "~/api/client";
import { Section } from "~/components/settings/section";
import { FieldRow } from "~/components/settings/field-row";
import { Badge, Button, ConfirmDialog, Spinner, Switch } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { formatDateOr } from "~/lib/format-when";
import { displayName } from "~/components/integrations/display-name";
import { useOnePasswordSettings } from "~/api/onepassword";
import { OnePasswordTokenRow } from "~/components/integrations/onepassword-setup";

/**
 * `/settings/connected-accounts` — You · Connected accounts. Renders one
 * `LinkAccountCard` per provider returned by `GET /api/me/identity-links`.
 */
export const Route = createFileRoute("/settings/connected-accounts")({
  component: ConnectedAccountsPage,
});

/** Server sends `{ error: "..." }` for documented failures; fall back to a
 * generic message for anything else (network failure, unexpected shape). */
function extractStartLinkError(err: unknown, provider: string): string {
  if (err instanceof ApiError && err.payload && typeof err.payload === "object") {
    const message = (err.payload as Record<string, unknown>).error;
    if (typeof message === "string" && message) return message;
  }
  return `Couldn't start the ${displayName(provider)} link. Try again.`;
}

interface LinkAccountCardProps {
  link: IdentityLinkStatus;
  onStart: (provider: string) => Promise<StartIdentityLinkResponse>;
  startPending: boolean;
}

function LinkAccountCard({ link, onStart, startPending }: LinkAccountCardProps) {
  const [pendingLink, setPendingLink] = useState<StartIdentityLinkResponse | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const setNotify = useSetLinkNotify(link.provider);
  const unlink = useUnlinkIdentity(link.provider);
  const label = displayName(link.provider);

  if (!link.channelReady) {
    return (
      <FieldRow label={label}>
        <p className="text-sm text-muted">
          {label} isn't configured for this organization yet. An admin can add a bot token
          under Integrations.
        </p>
      </FieldRow>
    );
  }

  if (!link.linked) {
    return (
      <FieldRow label={label} hint={`Message your assistant from ${label}.`}>
        <div className="space-y-2">
          <Button
            type="button"
            variant="secondary"
            disabled={startPending}
            onClick={async () => {
              try {
                const res = await onStart(link.provider);
                setPendingLink(res);
                setConnectError(null);
              } catch (err) {
                setConnectError(extractStartLinkError(err, link.provider));
              }
            }}
          >
            {startPending ? "Connecting…" : `Connect ${label}`}
          </Button>
          {connectError && <p className="text-sm text-danger-500">{connectError}</p>}
          {pendingLink && (
            <div className="space-y-1 rounded-md border border-line bg-ink-wash p-3 text-sm">
              {pendingLink.deepLink && (
                <>
                  <a
                    href={pendingLink.deepLink}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-moss underline"
                  >
                    Open Telegram and press Start
                  </a>
                  <p className="break-all font-mono text-xs text-muted">{pendingLink.deepLink}</p>
                </>
              )}
              <p className="break-all font-mono text-xs text-muted">{pendingLink.code}</p>
              <p className="text-xs text-muted">{pendingLink.instructions}</p>
              <p className="text-xs text-muted">
                Link expires in {Math.round(pendingLink.expiresInSeconds / 60)} minutes.
              </p>
            </div>
          )}
        </div>
      </FieldRow>
    );
  }

  return (
    <>
      <FieldRow label={label}>
        <div className="space-y-1 text-sm text-ink">
          <div>{link.externalId}</div>
          {link.createdAt && (
            <div className="text-xs text-muted">
              Linked since {formatDateOr(link.createdAt, "")}
            </div>
          )}
        </div>
      </FieldRow>
      <FieldRow label="Notify on attention" hint={`Ping you on ${label} when your assistant needs you.`}>
        <Switch
          checked={link.notifyAttention ?? false}
          onCheckedChange={(next) => setNotify.mutate({ notifyAttention: next })}
          aria-label="Notify on attention"
        />
      </FieldRow>
      <FieldRow label="Disconnect">
        <Button
          type="button"
          variant="danger"
          disabled={unlink.isPending}
          onClick={() => unlink.mutate()}
        >
          {unlink.isPending ? "Disconnecting…" : "Disconnect"}
        </Button>
      </FieldRow>
    </>
  );
}

export function ConnectedAccountsPage() {
  const linksQ = useIdentityLinks();
  const startLink = useStartIdentityLink();

  return (
    <>
    <Section
      title="Connected accounts"
      description="Link other channels to your account to chat with your assistant there."
    >
      {linksQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {linksQ.error && (
        <div className="py-4 text-sm text-danger-500">Failed to load connected accounts.</div>
      )}

      {linksQ.data?.links.map((link) => (
        <LinkAccountCard
          key={link.provider}
          link={link}
          onStart={startLink.mutateAsync}
          // Pending is scoped to the provider in flight, so starting one
          // provider's link does not disable every other card's button.
          startPending={startLink.isPending && startLink.variables === link.provider}
        />
      ))}

      <GithubRow />
      <OnePasswordRow />
    </Section>

    <CredentialsListSection />
    </>
  );
}

const REMOVE_PERSONAL_TOKEN_NOTE =
  "This token is yours alone. Credentials that read their secret through it stop resolving for " +
  "you, and other members and the organization token are not affected. You can connect a new " +
  "token here.";

/**
 * 1Password sits beside the other accounts you connect yourself. A personal
 * service account token needs no organization permission, so a member never
 * has to open an Organization page to set one up (TKAI-487).
 * Organization · 1Password keeps the org-wide token and opens the same
 * setup dialog.
 */
function OnePasswordRow() {
  const settingsQ = useOnePasswordSettings();

  if (settingsQ.isLoading) {
    return (
      <FieldRow label="1Password">
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      </FieldRow>
    );
  }
  if (settingsQ.error || !settingsQ.data) {
    return (
      <FieldRow label="1Password">
        <p className="text-sm text-danger-500">Failed to load 1Password connection status.</p>
      </FieldRow>
    );
  }

  return (
    <OnePasswordTokenRow
      scope="personal"
      connected={settingsQ.data.personalTokenConnected}
      label="1Password"
      hint="Let an agent read a credential from your vaults instead of you pasting it. Your token reads your own vaults, for runtimes you own."
      removeNote={REMOVE_PERSONAL_TOKEN_NOTE}
    />
  );
}

/** A credential is "healthy" (repo-capable + usable) when it's neither
 * identity-only, mid-refresh-failure, nor past its known expiry — mirrors
 * `services/github-tokens.ts`'s health rules on the server. */
function isExpired(cred: CredentialSummary): boolean {
  return typeof cred.expiresAt === "number" && cred.expiresAt < Date.now();
}

function GithubRow() {
  const credentialsQ = useCredentials();
  const githubAppQ = useGithubApp();
  const connectGithub = useConnectGithub();
  const disconnectGithub = useDisconnectGithub();
  const [connectError, setConnectError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  if (credentialsQ.isLoading) {
    return (
      <FieldRow label="GitHub">
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      </FieldRow>
    );
  }
  if (credentialsQ.error) {
    return (
      <FieldRow label="GitHub">
        <p className="text-sm text-danger-500">Failed to load GitHub connection status.</p>
      </FieldRow>
    );
  }

  const github = credentialsQ.data?.credentials.find((c) => c.service === "github");
  const repoCapable = !!github && !github.identityOnly;
  const installUrl =
    githubAppQ.data?.configured && githubAppQ.data.app ? githubAppQ.data.app.installUrl : undefined;

  /** Answers whether the OAuth flow started, so the replace dialog can stay
   * open carrying the reason when it did not. */
  async function connect(): Promise<boolean> {
    setConnectError(null);
    try {
      const res = await connectGithub.mutateAsync(undefined);
      window.location.href = res.url;
      return true;
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "Couldn't start the GitHub connect flow.");
      return false;
    }
  }

  return (
    <FieldRow label="GitHub" hint="Let the assistant clone and push to your repos.">
      <div className="space-y-2">
        {github && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
            {github.login && <span>{github.login}</span>}
            {github.identityOnly && <Badge variant="neutral">Identity only</Badge>}
            {github.refreshFailedAt && <Badge variant="danger">Refresh failed</Badge>}
            {isExpired(github) && <Badge variant="danger">Expired</Badge>}
            {repoCapable && !github.refreshFailedAt && !isExpired(github) && (
              <Badge variant="success">Connected</Badge>
            )}
          </div>
        )}
        {github?.identityOnly && (
          <p className="text-xs text-muted">Sign-in only — connect to enable repos.</p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={repoCapable ? "secondary" : "primary"}
            size="sm"
            disabled={connectGithub.isPending}
            onClick={() => {
              // Reconnecting over a repo-capable token overwrites it, so it
              // asks first; a first connect has nothing to overwrite. And
              // `connectError` outlives the dialog, so clear it here.
              if (repoCapable) {
                setConnectError(null);
                setConfirmReplace(true);
              } else void connect();
            }}
          >
            {connectGithub.isPending
              ? "Connecting…"
              : repoCapable
                ? "Reconnect GitHub"
                : "Connect GitHub"}
          </Button>
          {github && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disconnectGithub.isPending}
              onClick={() => {
                // React Query holds `error` until the next mutate, and Radix
                // never calls `onOpenChange(true)` for a controlled dialog
                // with no trigger, so the previous refusal is cleared here.
                disconnectGithub.reset();
                setConfirmDisconnect(true);
              }}
            >
              {disconnectGithub.isPending ? "Disconnecting…" : "Disconnect GitHub"}
            </Button>
          )}
        </div>

        {/* The open replace dialog carries the failure itself, so the same
            text does not render twice. */}
        {connectError && !confirmReplace && (
          <p className="text-xs text-danger-500">{connectError}</p>
        )}

        {installUrl && (
          <a href={installUrl} target="_blank" rel="noreferrer" className="block text-xs text-moss underline">
            Install on your personal account
          </a>
        )}

        <ConfirmDialog
          open={confirmReplace}
          onOpenChange={setConfirmReplace}
          title="Replace your GitHub token?"
          description="Valet keeps one GitHub token for you. When you finish the sign-in on GitHub, the new token replaces the one stored now. Cancel to keep the token you have."
          confirmLabel="Reconnect GitHub"
          pendingLabel="Connecting…"
          pending={connectGithub.isPending}
          error={connectError ?? undefined}
          onConfirm={() => {
            void connect().then((started) => {
              if (started) setConfirmReplace(false);
            });
          }}
        />
        <ConfirmDialog
          open={confirmDisconnect}
          onOpenChange={setConfirmDisconnect}
          title="Disconnect GitHub?"
          description="Valet deletes your stored GitHub token, so the assistant can no longer clone or push to your repos. Teams you shared it with lose access too. Connect GitHub again to restore it."
          confirmLabel="Disconnect"
          pendingLabel="Disconnecting…"
          pending={disconnectGithub.isPending}
          error={disconnectGithub.error != null ? errorText(disconnectGithub.error) : undefined}
          onConfirm={() =>
            disconnectGithub.mutate(undefined, { onSuccess: () => setConfirmDisconnect(false) })
          }
        />
      </div>
    </FieldRow>
  );
}

/** A reference-backed row stores only the `op://` reference, so revoking it
 * leaves the 1Password item itself in place. */
function revokeDescription(cred: CredentialSummary): string {
  const removed = cred.onepasswordRef
    ? `Valet deletes its stored ${cred.service} reference. The item in 1Password is not deleted.`
    : `Valet deletes the stored ${cred.service} credential.`;
  return (
    `${removed} The assistant can no longer act on ${cred.service}, and teams you shared it ` +
    `with lose it too. Connect ${cred.service} again to restore access.`
  );
}

/** Generic credentials list — every service from `GET /api/credentials`
 * except `github` (already surfaced above with its own richer row). */
function CredentialsListSection() {
  const credentialsQ = useCredentials();
  const disconnect = useDisconnectCredential();
  // The row being confirmed, not a bare boolean: the rows share one dialog,
  // which a boolean would open for every row at once.
  const [confirmRevoke, setConfirmRevoke] = useState<CredentialSummary | null>(null);

  // `github` gets its own richer row above, and `onepassword` (the reserved
  // service holding the personal service-account token itself) gets the
  // 1Password section above. This list is every OTHER credential, including
  // the 1Password reference-backed ones (badge below).
  const others = (credentialsQ.data?.credentials ?? []).filter(
    (c) => c.service !== "github" && c.service !== "onepassword",
  );

  return (
    <Section title="Other credentials" description="Manually connected services.">
      {credentialsQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {credentialsQ.error && (
        <div className="py-4 text-sm text-danger-500">Failed to load credentials.</div>
      )}
      {!credentialsQ.isLoading && !credentialsQ.error && others.length === 0 && (
        <div className="py-4 text-sm text-muted">No other services connected.</div>
      )}
      {others.map((cred) => (
        <FieldRow key={cred.service} label={cred.service}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="neutral">{cred.type}</Badge>
            {cred.identityOnly && <Badge variant="neutral">Identity only</Badge>}
            {cred.refreshFailedAt && <Badge variant="danger">Refresh failed</Badge>}
            {isExpired(cred) && <Badge variant="danger">Expired</Badge>}
            {/* Reference-backed credentials have no inline secret to edit —
                only the reference itself, shown as a badge, and deletion via
                the same Revoke control every other credential uses. */}
            {cred.onepasswordRef && <Badge variant="accent">{cred.onepasswordRef}</Badge>}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disconnect.isPending}
              onClick={() => {
                // Clear the previous row's refusal as this dialog opens.
                disconnect.reset();
                setConfirmRevoke(cred);
              }}
            >
              {disconnect.isPending ? "Revoking…" : `Revoke ${cred.service}`}
            </Button>
          </div>
        </FieldRow>
      ))}
      {confirmRevoke && (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setConfirmRevoke(null);
          }}
          title={`Revoke ${confirmRevoke.service}?`}
          description={revokeDescription(confirmRevoke)}
          confirmLabel="Revoke"
          pendingLabel="Revoking…"
          pending={disconnect.isPending}
          // The list shares one mutation, so a failure belongs to the row it
          // was fired for — never to the next row somebody opens.
          error={
            disconnect.error != null && disconnect.variables?.service === confirmRevoke.service
              ? errorText(disconnect.error)
              : undefined
          }
          onConfirm={() =>
            disconnect.mutate(
              { service: confirmRevoke.service },
              { onSuccess: () => setConfirmRevoke(null) },
            )
          }
        />
      )}
    </Section>
  );
}
