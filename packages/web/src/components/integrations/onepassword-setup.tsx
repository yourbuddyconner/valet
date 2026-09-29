import { useEffect, useState } from "react";
import { errorText } from "~/lib/error-text";
import { useConnectCredential, useDisconnectCredential } from "~/api/integrations";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
} from "~/components/primitives";
import { FieldRow } from "~/components/settings/field-row";

/**
 * The 1Password token controls, shared by the two pages that carry a token:
 * You · Connected accounts holds your own, and Organization · 1Password holds
 * the one the whole org shares. Both reach the same setup dialog, so the
 * instructions are written once and a reader meets them wherever they start.
 */

/**
 * Setup links. `www.1password.dev` is the current developer-docs host —
 * `developer.1password.com` answers every path with a 301 to it. Creating a
 * vault is an end-user task with no developer-docs page, so that one points
 * at the support site.
 */
const OP_CREATE_VAULT_URL = "https://support.1password.com/create-share-vaults-teams/";
const OP_SERVICE_ACCOUNT_URL = "https://www.1password.dev/service-accounts/get-started/";
const OP_SECRET_REFERENCE_URL = "https://www.1password.dev/cli/secret-reference-syntax/";
const VALET_SECRETS_GUIDE_URL =
  "https://github.com/tkhq/valet/blob/dev-v2/docs/onepassword-secrets.md";

/** Inline external link, the treatment the other setup pages already use. */
const LINK = "text-moss underline";

export type OnePasswordTokenScope = "personal" | "org";

/**
 * What each scope reads, in the reader's words. The dialog says this before
 * it asks for a token, because pasting an org-wide service account into the
 * personal row is the mistake that is hard to see afterwards.
 */
const SCOPE_COPY: Record<OnePasswordTokenScope, { title: string; reach: string; input: string }> = {
  personal: {
    title: "Connect your 1Password account",
    reach: "This token is yours alone. It reads your own vaults, for runtimes you own.",
    input: "1Password personal token",
  },
  org: {
    title: "Connect 1Password for the organization",
    reach:
      "This token is shared across the organization. Every member's runtimes resolve org references through it.",
    input: "Organization 1Password token",
  },
};

/** The numbered setup steps. Rendered inside the dialog on both pages. */
export function OnePasswordInstructions() {
  return (
    <div className="space-y-3 text-sm text-muted">
      <ol className="list-decimal space-y-1 pl-5">
        <li>
          <a className={LINK} href={OP_CREATE_VAULT_URL} target="_blank" rel="noreferrer">
            Create a vault
          </a>{" "}
          and put the items an agent needs into it.
        </li>
        <li>
          <a className={LINK} href={OP_SERVICE_ACCOUNT_URL} target="_blank" rel="noreferrer">
            Create a service account
          </a>{" "}
          with read access to that vault. 1Password shows the token once, so copy it before you
          leave the screen.
        </li>
        <li>Paste the token below. Valet encrypts it and never shows it again.</li>
      </ol>
      <p>
        An item is addressed by a{" "}
        <a className={LINK} href={OP_SECRET_REFERENCE_URL} target="_blank" rel="noreferrer">
          secret reference
        </a>
        , written <span className="font-mono">op://Vault/Item/field</span>. The{" "}
        <a className={LINK} href={VALET_SECRETS_GUIDE_URL} target="_blank" rel="noreferrer">
          secrets guide
        </a>{" "}
        shows how an agent uses one.
      </p>
    </div>
  );
}

/** The instructions and the token field, in one dialog. */
export function OnePasswordSetupDialog({
  scope,
  open,
  onOpenChange,
}: {
  scope: OnePasswordTokenScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const connect = useConnectCredential();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const copy = SCOPE_COPY[scope];

  // A dialog that keeps a typed token after it closes would offer it back on
  // the next open, under a heading that may now name the other scope.
  useEffect(() => {
    if (!open) {
      setToken("");
      setError(null);
      connect.reset();
    }
    // `connect` is a stable mutation handle; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function save() {
    const trimmed = token.trim();
    if (!trimmed) return;
    setError(null);
    try {
      await connect.mutateAsync({
        service: "onepassword",
        body:
          scope === "org"
            ? { type: "service_account", apiKey: trimmed, scope: "org" }
            : { type: "service_account", apiKey: trimmed },
      });
      onOpenChange(false);
    } catch (err) {
      setError(errorText(err, "Couldn't save the token."));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={copy.title} description={copy.reach}>
        <OnePasswordInstructions />
        <div className="mt-4 space-y-2">
          <Input
            type="password"
            aria-label={copy.input}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ops_…"
          />
          {error && <p className="text-xs text-danger-500">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={connect.isPending || !token.trim()}
            onClick={() => void save()}
          >
            {connect.isPending ? "Saving…" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A token row the reader may change: the status, and the controls that open
 * the setup dialog or remove what is there.
 */
export function OnePasswordTokenRow({
  scope,
  connected,
  label,
  hint,
  removeNote,
}: {
  scope: OnePasswordTokenScope;
  connected: boolean;
  label: string;
  hint: string;
  removeNote: string;
}) {
  const disconnect = useDisconnectCredential();
  const [setupOpen, setSetupOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <>
      <FieldRow label={label} hint={hint}>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
          {connected ? (
            <>
              <Badge variant="success">Connected</Badge>
              <Button type="button" variant="ghost" size="sm" onClick={() => setSetupOpen(true)}>
                Replace
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disconnect.isPending}
                onClick={() => {
                  // Radix fires no `onOpenChange(true)` here, so the stale
                  // refusal is cleared on open.
                  disconnect.reset();
                  setConfirmRemove(true);
                }}
              >
                {disconnect.isPending ? "Removing…" : "Remove token"}
              </Button>
            </>
          ) : (
            <Button type="button" size="sm" onClick={() => setSetupOpen(true)}>
              Connect 1Password
            </Button>
          )}
        </div>
      </FieldRow>

      <OnePasswordSetupDialog scope={scope} open={setupOpen} onOpenChange={setSetupOpen} />

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={scope === "org" ? "Remove the organization 1Password token?" : "Remove your personal 1Password token?"}
        description={removeNote}
        confirmLabel="Remove token"
        pendingLabel="Removing…"
        pending={disconnect.isPending}
        error={disconnect.error != null ? errorText(disconnect.error) : undefined}
        onConfirm={() =>
          disconnect.mutate(
            scope === "org" ? { service: "onepassword", scope: "org" } : { service: "onepassword" },
            { onSuccess: () => setConfirmRemove(false) },
          )
        }
      />
    </>
  );
}

/**
 * A token row the reader may not change: the same labelled row, with the
 * status where the controls are and a line naming who can change it.
 * Read-only rather than hidden — a reader who cannot find the row cannot
 * tell a missing token from a page that is not showing it.
 */
export function OnePasswordTokenStatus({
  connected,
  label,
  hint,
  note,
}: {
  connected: boolean;
  label: string;
  hint: string;
  note: string;
}) {
  return (
    <FieldRow label={label} hint={hint}>
      <div className="space-y-1" role="group" aria-label={label}>
        {connected ? (
          <Badge variant="success">Connected</Badge>
        ) : (
          <p className="text-sm text-ink">Not connected</p>
        )}
        <p className="text-xs text-muted">{note}</p>
      </div>
    </FieldRow>
  );
}
