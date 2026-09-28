import { useEffect, useState } from "react";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { usePlugins } from "~/api/integrations";
import { Spinner } from "~/components/primitives";
import { SearchInput } from "~/components/search-input";
import { Section } from "~/components/settings/section";
import { hasVisibleSurface, IntegrationRow, isService } from "~/components/integrations/integration-row";
import { pluginDisplayName } from "~/components/integrations/display-name";
import { matchesNeedle } from "~/lib/text-match";
import { textParam } from "~/lib/search-params";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { TeamIntegrations } from "~/components/integrations/team-integrations";

/**
 * `/integrations` — the services a person can connect, in the settings
 * visual idiom (open hairline stacks, no card boxes). Content-only plugins
 * are not listed: they need no credential and offer no action, so a row for
 * one was a row nobody could use. OAuth connect for services declaring
 * `oauth` metadata redirects
 * to `/api/credentials/:service/connect` and lands back here with
 * `?connected=` or `?error=`; manual token entry remains the fallback for
 * everything else.
 *
 * The search box narrows the tiles IN the browser, unlike the catalog
 * search on `/skills`: `usePlugins` holds the whole plugin set, so a
 * client-side match answers about everything it claims to. The settled
 * query lives in `?q=`, so a search is a link and Back clears it.
 */
interface IntegrationsSearch {
  q?: string;
}

/** Reads the search params, keeping only strings. The OAuth round trip's
 * `?connected=`/`?error=` stay off this schema: `useConnectResult` reads
 * and clears them from `window.location` on mount. */
function readIntegrationsSearch(raw: unknown): IntegrationsSearch {
  return { q: textParam(raw, "q") };
}

export const Route = createFileRoute("/integrations")({
  component: IntegrationsPage,
  validateSearch: readIntegrationsSearch,
});

type ConnectResult = { kind: "connected" | "error"; value: string; detail?: string; teamId?: string } | null;

/**
 * Maps OAuth callback error codes to human-readable messages. Each message
 * names the corrective action when one exists.
 */
const ERROR_MESSAGES: Record<string, string> = {
  team_sync_failed: "Connection saved. Open Workflows and sync the team sources again.",
  team_access_changed: "Team access changed. Ask a team admin to restart the connection.",
  team_connection_exists: "This team already has a connection. Disconnect it before connecting another account.",
  team_identity_unsupported: "This personal identity cannot be used for a team. Connect a team account instead.",
  identity_conflict:
    "This Slack account is already linked to another Valet user. Unlink it there first, or sign in as that user.",
};

/**
 * Reads the OAuth round trip's result, then clears it from the URL so a
 * reload does not repeat the notice. The read is an effect, not a `useState`
 * initializer: `replaceState` is a side effect, and React runs an
 * initializer during render — twice under StrictMode. The effect also runs
 * after the first paint, so the live region below is already on the page
 * when its text arrives. A screen reader announces the notice only in that
 * order.
 */
function useConnectResult(): ConnectResult {
  const [result, setResult] = useState<ConnectResult>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error = params.get("error");
    const teamId = params.get("teamId") ?? undefined;
    // Server-composed corrective action (e.g. an OAuthInterpretError message);
    // rendered as plain text below, never as markup.
    const detail = params.get("detail");
    if (!connected && !error) return;
    window.history.replaceState(null, "", window.location.pathname);
    setResult(
      connected
        ? { kind: "connected", value: connected, teamId }
        : { kind: "error", value: error ?? "", teamId, ...(detail ? { detail } : {}) },
    );
  }, []);

  return result;
}

export function IntegrationsPage() {
  const { teamId, setKey } = useWorkspaceScope();
  const connectResult = useConnectResult();
  useEffect(() => {
    if (connectResult?.teamId) setKey(connectResult.teamId);
  }, [connectResult, setKey]);
  // Unmount personal forms and team dialogs when the workspace changes.
  if (teamId) {
    const notice = connectResult?.teamId === teamId
      ? connectResult.kind === "connected"
        ? `Connected ${connectResult.value === "linear" ? "Linear via MCP" : connectResult.value}.`
        : connectResult.detail ?? ERROR_MESSAGES[connectResult.value] ?? "Connection failed. Select Connect to try again."
      : undefined;
    return <TeamIntegrations key={teamId} teamId={teamId} notice={notice} />;
  }
  return <PersonalIntegrationsPage connectResult={connectResult?.teamId && connectResult.kind === "connected" ? null : connectResult} />;
}

function PersonalIntegrationsPage({ connectResult }: { connectResult: ConnectResult }) {
  const { data, isLoading, error } = usePlugins();
  const plugins = data?.plugins ?? [];

  // The top-level hooks, not `Route.useSearch()`: the route suite mocks
  // this module and never builds a real router context.
  const search = readIntegrationsSearch(useSearch({ strict: false }));
  const navigate = useNavigate();
  const query = search.q ?? "";

  // `hasVisibleSurface` drops plugins whose every service is unconfigured,
  // unconnected, and unfixable by this caller — nothing on such a tile could
  // work, and nothing on it would tell the reader what to do. An org admin
  // keeps the tile, because the API tells them which setting is missing.
  const reachable = plugins.filter(isService).filter(hasVisibleSurface);
  // A tile answers the query by its display name, raw name, or description.
  const services = reachable
    .filter((plugin) => matchesNeedle(query, [pluginDisplayName(plugin), plugin.name, plugin.description]))
    .sort((a, b) => pluginDisplayName(a).localeCompare(pluginDisplayName(b)));
  const searching = query.trim().length > 0;
  // The box stays up through an empty match — hiding it would leave the
  // search with no box to clear it in.
  const showSearch = reachable.length > 0 || searching;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
        <h1 className="font-display text-2xl text-ink">Integrations</h1>

        {/* The live region is on the page from the first paint, and stays
            empty until the connect result arrives. A screen reader ignores a
            region that appears together with its text. */}
        <div role="status">
          {connectResult?.kind === "connected" && (
            <div className="mt-4 rounded border border-line bg-moss-wash px-3 py-2 text-sm text-ink">
              Connected {connectResult.value === "linear" ? "Linear via MCP" : connectResult.value}.
            </div>
          )}
          {connectResult?.kind === "error" && (
            <div className="mt-4 rounded border border-line bg-danger-wash px-3 py-2 text-sm text-danger-600">
              {connectResult.detail ?? ERROR_MESSAGES[connectResult.value] ?? (
                <>
                  Connection failed: {connectResult.value}. Select Connect on the service below to
                  try again.
                </>
              )}
            </div>
          )}
        </div>

        <div className="mt-10 space-y-12">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Spinner size={14} /> Loading integrations…
            </div>
          )}
          {!isLoading && error && (
            <div className="text-sm text-danger-500">
              Couldn't load integrations. Check that the server is running, then reload.
            </div>
          )}
          {!isLoading && !error && plugins.length === 0 && (
            <div className="text-sm text-muted">No plugins installed.</div>
          )}

          {!isLoading && !error && showSearch && (
            <div className="space-y-4">
              <div className="ml-auto w-full sm:w-56">
                <SearchInput
                  value={query}
                  onSettled={(next) =>
                    void navigate({
                      to: "/integrations",
                      search: next.trim().length === 0 ? {} : { q: next },
                    })
                  }
                  placeholder="Search integrations…"
                  aria-label="Search integrations"
                />
              </div>

              {searching && services.length === 0 && (
                <div className="text-sm text-muted">No integrations match your search.</div>
              )}

              {services.length > 0 && (
                <Section title="Services" description="Most need a key to connect.">
                  <div className="grid gap-3 pt-4 sm:grid-cols-2">
                    {services.map((plugin) => (
                      <IntegrationRow key={plugin.name} plugin={plugin} />
                    ))}
                  </div>
                </Section>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
