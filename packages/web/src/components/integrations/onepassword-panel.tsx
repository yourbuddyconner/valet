import { useOnePasswordSettings } from "~/api/onepassword";
import { useOrg } from "~/api/settings";
import { Spinner } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { ServiceIcon } from "~/components/service-icon";
import {
  OnePasswordTokenRow,
  OnePasswordTokenStatus,
} from "~/components/integrations/onepassword-setup";

/**
 * Organization · 1Password: the service-account token the whole org shares.
 * An admin sets it; a member sees the same row with the status in place of
 * the controls, so nobody has to guess whether one is connected.
 *
 * Your OWN token is not here. It is a personal credential, so it sits with
 * the rest of them on You · Connected accounts. Both pages open the same
 * setup dialog, so the instructions read the same wherever you start.
 */

const REMOVE_ORG_TOKEN_NOTE =
  "This token is shared across the organization. Credentials that read their secret through it " +
  "stop resolving for every member. An admin can connect a new token here.";

export function OnePasswordPanel() {
  const orgQ = useOrg();
  const settingsQ = useOnePasswordSettings();
  const isAdmin = orgQ.data?.callerRole === "admin";

  return (
    <Section
      title="1Password"
      description="Connect a service account, and agents read credentials from your vaults instead of you pasting them."
    >
      <div className="flex items-start gap-3 py-4">
        <ServiceIcon slug="1password" label="1Password" />
        <p className="text-sm text-muted">
          The organization token reads vaults every member's runtimes can use. Your own token
          lives on{" "}
          <a className="text-moss underline" href="/settings/connected-accounts">
            Connected accounts
          </a>
          .
        </p>
      </div>

      {settingsQ.isLoading && (
        <div className="flex items-center gap-2 py-2 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {settingsQ.error && (
        <p className="py-2 text-sm text-danger-500">Failed to load 1Password settings.</p>
      )}

      {settingsQ.data &&
        (isAdmin ? (
          <OnePasswordTokenRow
            scope="org"
            connected={settingsQ.data.orgTokenConnected}
            label="Organization token"
            hint="A 1Password service account token shared across the organization."
            removeNote={REMOVE_ORG_TOKEN_NOTE}
          />
        ) : (
          <OnePasswordTokenStatus
            connected={settingsQ.data.orgTokenConnected}
            label="Organization token"
            hint="A 1Password service account token shared across the organization."
            note="Only an organization admin can connect or remove this token."
          />
        ))}
    </Section>
  );
}
