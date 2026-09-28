import { useEffect, useState } from "react";
import type { PluginServiceSummary } from "@valet/api/wire";
import { useConnectCredential, useCredentials, usePlugins } from "~/api/integrations";
import { useGithubOrgStatus } from "~/api/repos";
import { Button, Dialog, DialogContent, ErrorRow, LoadingRow, Textarea } from "~/components/primitives";
import { SearchInput } from "~/components/search-input";
import { CardHeading, CardFooter, IntegrationCard } from "./integration-card";
import { errorText } from "~/lib/error-text";
import { LinearEventsConnection } from "./linear-events-connection";
import { displayName } from "./display-name";
import { githubOrgAppState } from "./github-org-app";

/** Only explicit org-provided services qualify; personal connected flags do not. */
export function TeamConnectionSetup({ teamId, canManage, orgAdmin }: {
  teamId: string; canManage: boolean; orgAdmin: boolean;
}) {
  // The team catalog reports effective credentials for this team. In
  // particular, an org-managed Slack bot is connected for team workflows
  // even though the team has no Slack credential row of its own.
  const plugins = usePlugins(teamId);
  const github = useGithubOrgStatus();
  const credentials = useCredentials("team", { teamId });
  const [selected, setSelected] = useState<PluginServiceSummary | null>(null);
  const [query, setQuery] = useState("");
  const canConnect = canManage && !!credentials.data && !credentials.error && !plugins.error;
  useEffect(() => {
    if (!canConnect) setSelected(null);
  }, [canConnect]);
  const githubState = github.data ? githubOrgAppState(github.data) : undefined;
  const services = [...new Map((plugins.error ? [] : plugins.data?.plugins ?? [])
    .flatMap((p) => p.services).map((s) => [s.service, s])).values()];
  const provided = services.filter((s) => s.connect === "org" || s.service === "slack");
  const occupied = new Set(credentials.data?.credentials.map((c) => c.service));
  const choices = services.filter((s) => s.configKeys.length > 0 &&
    s.service !== "slack-user" && s.service !== "slack" && s.service !== "github" &&
    // `onepassword` is a service-account TOKEN, not one service's credential.
    // The team list skips reserved rows, so an already-connected token never
    // reads as occupied here, and this dialog's create-only promise does not
    // reach `mutateTeamOnePassword`, which upserts. It would replace a live
    // team token with no 409 and no confirmation. `TeamOnePasswordToken` is
    // the control for it, and the team Integrations page renders it.
    s.service !== "onepassword" && s.connect !== "org" && !occupied.has(s.service))
    .sort((a, b) => displayName(a.service).localeCompare(displayName(b.service)));

  const available = choices.filter((s) => displayName(s.service).toLowerCase().includes(query.toLowerCase()));
  return <div className="space-y-6">
    <section aria-label="Organization connections">
      <h3 className="text-sm font-medium text-ink">Organization access</h3>
      <p className="mt-1 text-sm text-muted">
        Native event connections are managed in Organization settings.
      </p>
      {plugins.error && <ErrorRow>Could not load organization access. Reload the page.</ErrorRow>}
      {github.error && <ErrorRow>Could not load GitHub App status. Reload the page.</ErrorRow>}
      {(plugins.isFetching || github.isFetching) && <LoadingRow label="Loading organization access…" />}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted">
        {!plugins.isFetching && provided.filter((s) => s.service !== "github").map((s) =>
          <span key={s.service}>{displayName(s.service)}{s.connect === "org" ? " · Organization connection" : ""}</span>)}
        {!github.error && !github.isFetching && githubState && <span>GitHub App{githubState === "installed" ? " · Installed" : githubState === "suspended" ? " · Suspended" : ""}</span>}
        {orgAdmin && <a className="text-ink underline" href="/settings/organization">Organization settings</a>}
      </div>
      {services.some(s => s.service === "linear") && <div className="mt-4"><LinearEventsConnection /></div>}
    </section>
    <section aria-label="Dedicated team connection">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h3 className="text-sm font-medium text-ink">Connect a service</h3>
          <p className="mt-1 text-sm text-muted">Connect an account intended for this team.</p></div>
        <div className="w-full sm:w-56"><SearchInput value={query} onSettled={setQuery} placeholder="Search integrations…" /></div>
      </div>
      {credentials.error && <ErrorRow>Could not check team connections. Reload the page.</ErrorRow>}
      {!plugins.isLoading && !plugins.error && available.length === 0 && <p className="mt-4 text-sm text-muted">No available integrations match.</p>}
      <div className="grid gap-3 pt-4 sm:grid-cols-2">
        {available.map((service) => {
          const blocked = service.connect === "unconfigured" && service.connectBlockedBy !== "org";
          const card = <IntegrationCard key={service.service}>
            <CardHeading title={service.service === "linear" ? "Linear MCP" : displayName(service.service)} slug={service.iconSlug ?? service.service}
              description={blocked ? "Ask an organization admin to configure OAuth for this service." : service.service === "linear" ? "Optional tools for this team. Native events use the organization connection." : "Connect an account this team can use."} />
            <CardFooter meta={blocked ? undefined : canManage ? "Team connection" : "Team admin required"}
              right={<Button size="sm" variant="secondary" disabled={blocked || !canConnect} onClick={() => setSelected(service)}>{service.service === "linear" ? "Connect via MCP" : `Connect ${displayName(service.service)}`}</Button>} />
          </IntegrationCard>;
          return service.service === "linear" ? <details key={service.service} className="text-sm text-muted">
            <summary className="cursor-pointer">Optional MCP tools</summary>
            <div className="mt-3">{card}</div>
          </details> : card;
        })}
      </div>
      {canConnect && selected && <TeamConnectionDialog key={selected.service} teamId={teamId} service={selected} onClose={() => setSelected(null)} />}
    </section>
  </div>;
}

function TeamConnectionDialog({ teamId, service, onClose }: {
  teamId: string; service: PluginServiceSummary; onClose: () => void;
}) {
  const connect = useConnectCredential();
  const [token, setToken] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const oauth = service.connect === "oauth" && service.service !== "github";
  return <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent title={`Connect ${displayName(service.service)}${service.service === "linear" ? " via MCP" : ""} to this team`}
      description={oauth ? "Sign in to the account intended for this team. Everyone on the team can use the permissions you grant." : "Paste a token for the account intended for this team. Everyone on this team can use its permissions."}>
      {!oauth && <label className="text-sm">Team account token
        <Textarea value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        I authorize team members to use this account’s permissions.
      </label>
      <p className="text-xs text-muted">One connection per service. Disconnect the existing account before replacing it.</p>
      {connect.error && <ErrorRow>{errorText(connect.error)}</ErrorRow>}
      <Button disabled={(!oauth && !token.trim()) || !confirmed || connect.isPending} onClick={() => {
        if (oauth) {
          window.location.href = `/api/credentials/${encodeURIComponent(service.service)}/connect?scope=team&teamId=${encodeURIComponent(teamId)}`;
          return;
        }
        connect.mutate({ service: service.service, body: {
          scope: "team", teamId, type: service.type, createOnly: true,
          ...(service.type === "api_key" ? { apiKey: token.trim() } : { accessToken: token.trim() }),
        } }, { onSuccess: onClose });
      }}>{connect.isPending ? "Connecting…" : oauth ? `Continue to ${displayName(service.service)}` : "Connect team account"}</Button>
    </DialogContent>
  </Dialog>;
}
