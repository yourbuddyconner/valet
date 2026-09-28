# Environment Variables

All variables are read by the `@valet/api` server process unless noted. The
`valet` CLI resolves settings with precedence flag > env >
`~/.valet/config.json` > default.

## Core

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic key for the agent loop. The server exits without it. You can add org-level LLM providers in the UI |
| `PORT` | No | HTTP port (default `8788`). Deploy images and charts set `8787` explicitly |
| `DATABASE_URL` | No | Postgres connection string. Set → node-postgres. Unset → embedded PGlite under the data dir |
| `VALET_DATA_DIR` | No | Data root (default `~/.valet`): config, PGlite, blobs, serve.lock. When it, `VALET_PG_DATA_DIR`, and `DATABASE_URL` are all unset, `make dev-local` sets it to `.valet-dev/` in the worktree, so each worktree gets its own database |
| `VALET_PG_DATA_DIR` / `VALET_BLOBS_DIR` | No | Override the PGlite and blob-store locations individually |
| `VALET_ENCRYPTION_KEY` | Prod | AES-256-GCM key for credentials at rest (warned if unset) |
| `VALET_PLUGINS` | No | Extra plugin module specifiers to load beyond the bundled registry |
| `VALET_CONFIG` | No | Path to the instance config file (`valet.yaml`). `make dev-local` points it at `config/valet.dev.yaml`; the helm chart mounts `api.instanceConfig` and sets it. See docs/specs/2026-08-14-instance-config-design.md |
| `OPENAI_API_KEY` | No | Fallback OpenAI key |

The instance config's `mcpServers` entries with `auth: bearer` each name
their own env var (`tokenEnv`). Set that variable in the api's environment;
the server refuses to boot when it is missing.

## Auth

Real auth activates when `BETTER_AUTH_SECRET` is set. Otherwise the local
stub applies. Provider variable pairs are all-or-none.

| Variable | Description |
|----------|-------------|
| `BETTER_AUTH_SECRET` | Enables better-auth (email/password + configured providers) |
| `BETTER_AUTH_URL` | Public base URL (default `http://localhost:8788`) |
| `AUTH_TRUSTED_ORIGINS` | Extra CORS/trusted origins (`http://localhost:5173` is always included) |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | Comma-separated signup domain allowlist |
| `AUTH_OIDC_ISSUER` / `AUTH_OIDC_CLIENT_ID` / `AUTH_OIDC_CLIENT_SECRET` | Generic OIDC SSO (e.g. Keycloak). Optional: `AUTH_OIDC_NAME`, `AUTH_OIDC_DOMAIN` |
| `AUTH_OIDC_TEAM_CLAIM` | Claim carrying the user's group paths (default `groups`) — see below. Prefer `auth.sso.teams.claim` in `valet.yaml` |
| `AUTH_OIDC_TEAM_ASSERTED_CLAIM` | Claim that proves the group mapper ran (default `groups_asserted`). Prefer `auth.sso.teams.assertedClaim` |
| `AUTH_OIDC_TEAM_ADMIN_GROUP` | Sub-group that grants admin on its parent team (default `admins`). Prefer `auth.sso.teams.adminSubGroup` |
| `AUTH_GOOGLE_CLIENT_ID` / `AUTH_GOOGLE_CLIENT_SECRET` | Google social login. NOT the Google integrations pair — see [Integrations](#integrations) |
| `AUTH_GITHUB_CLIENT_ID` / `AUTH_GITHUB_CLIENT_SECRET` | GitHub social login |
| `VALET_LOCAL_AUTH` | `1` → stub identity for local dev. Mutually exclusive with `BETTER_AUTH_SECRET` — the server refuses to boot when both are set |
| `VALET_SANDBOX_JWT_MASTER` | Master key for per-session sandbox gateway JWT secrets (falls back to `BETTER_AUTH_SECRET`) |
| `VALET_INTERNAL_TOKEN` | Token for the server's internal self-calls (generated if unset) |

### Group claims from the identity provider

Team creation from groups is a feature you turn on. It is off in every
deployment that does not set it, and none of the variables or keys in this
section turns it on. The switch is the `ssoTeamSync` org feature:

```yaml
org:
  features:
    ssoTeamSync: true
```

An org admin can also turn it on in Settings, which takes effect at the next
sign-in and needs no restart. While it is off, sign-in still works and still
decides the user's role and org membership; only team mirroring stops.

The file wins over Settings, and it wins at every boot. If `valet.yaml`
declares `ssoTeamSync`, the boot reconciler writes that value over whatever
Settings holds, so a toggle set in the UI lasts until the next api restart.
It prints one line naming the file each time it changes the value. To control
the feature from Settings, remove the key from the file. Note also that the
reconciler only adds declared keys and never removes one, so a value the file
wrote once stays in the database after you delete the line — turn it off in
Settings.

Valet maps identity-provider groups to teams, so the provider must send group
membership in the token. The local Keycloak realm
(`docker/keycloak/valet-realm.json`, started by `make dev-keycloak`) carries
two protocol mappers on the `valet` client for this. Both are client-dedicated
mappers, so they apply to every sign-in and need no extra scope.

| Claim | Mapper | Value |
|-------|--------|-------|
| `groups` | Group membership, full path on | Every group the user is in, as full paths: `["/platform/admins"]` |
| `groups_asserted` | Hardcoded claim | The string `"true"`, on every response, for every user |

The second mapper looks redundant and is not. Keycloak omits the `groups`
claim completely for a user who is in no group — it does not send an empty
array. So an absent `groups` claim alone is ambiguous: it means either "this
user is in no group" or "no group information reached us", which is what a
missing mapper, a dropped scope, or a different provider produces. Those two
cases need opposite handling. `groups_asserted` separates them: it proves the
mapper set ran. Present marker plus absent `groups` means the user is in no
group. An absent marker means Valet learned nothing about groups and must
change no membership.

The seeded realm puts one user in `/platform/admins`, and a second user in
`/platform` and `/research`, so the two dev users have different membership
shapes.

#### Keep the two mappers together

The marker gives the group claim its meaning, so the two mappers must always
agree. Two edits break that agreement, and both remove every mirrored team
from every user at the next sign-in:

1. If you delete the group mapper, delete the marker mapper in the same
   change. A marker without a group claim states that every user is in no
   group.
2. Enable both mappers on the same tokens. Valet reads the claims from the
   UserInfo response, because OIDC discovery gives the provider a UserInfo
   endpoint. A marker on the UserInfo response and a group claim on the ID
   token only is the same failure as case 1.

To turn the sync off, delete both mappers. Valet then learns nothing about
groups and changes no team.

#### Do not put a slash in a group name

A group name must not contain `/`. Keycloak accepts such a name and builds an
ambiguous path from it. A top-level group named `platform/admins` reports the
path `/platform/admins`, which is the path of the `admins` sub-group of
`platform`. The two are identical in the claim, and Valet reads the path to
decide who administers a team. A member of the flat group therefore becomes an
administrator of the team that mirrors `/platform`, although that member is in
no group under `/platform`.

Nothing in the token separates the two cases, so Valet cannot detect this. If
you delegate group creation in the identity provider, restrict the names that
the delegates can use.

Keycloak imports a realm only when that realm is absent. If you edit the realm
file, run `make dev-keycloak-down && make dev-keycloak` to import it again.

A provider that names these claims differently needs no code change. Set
`AUTH_OIDC_TEAM_CLAIM` and `AUTH_OIDC_TEAM_ASSERTED_CLAIM` to the names it
sends, and `AUTH_OIDC_TEAM_ADMIN_GROUP` to the sub-group that grants admin.
A provider that sends neither claim changes no team membership at all.

#### Declare the mapping in `valet.yaml` instead

The three variables above still work, but `valet.yaml` is the preferred home
for them. They are not secrets, they are the same on every replica, and they
change the shape of instance state — which is what the file is for. The
issuer, the client id and the client secret stay in the environment.

```yaml
auth:
  sso:
    teams:
      claim: groups                   # AUTH_OIDC_TEAM_CLAIM
      assertedClaim: groups_asserted  # AUTH_OIDC_TEAM_ASSERTED_CLAIM
      adminSubGroup: admins           # AUTH_OIDC_TEAM_ADMIN_GROUP
      groups:                         # the allowlist, no env equivalent
        - /platform
        - /research
```

If you set an environment variable and declare the matching key, the api
refuses to start and names both. Remove one. The check is per field, so you
can declare two keys in the file and set the third variable.

`groups` is the allowlist, and it decides every team the sync may create.
Only a group you list becomes a team. Any other group the claim carries is
ignored, and it is ignored in silence, because you excluded it on purpose and
a warning would repeat at every sign-in of every user. Omit `groups` and
Valet mirrors nothing at all — an identity provider carries groups that have
nothing to do with Valet, such as `/everyone` or `/vpn-users`, and no rule
can tell those from the groups you want. The api prints one line at boot when
`ssoTeamSync` is on and the list is empty.

Each entry must be a top-level path such as `/platform`. The admin sub-group
of a listed group is still read, so `/platform` also admits
`/platform/admins`. There are no patterns: to mirror `/eng-web` and
`/eng-api`, list both. Matching is exact after trimming, so `/Platform` and
`/platform` are two entries.

The claim must carry full group paths, with the leading `/`. A group NAME on
its own is ignored, and the api prints one line naming the fix. The reason is
that a name loses the nesting: a member of `/contractors/platform` and a
member of `/platform` both send `platform`, so a group you never listed would
grant membership of a team you did. On Keycloak, turn on **Full group path**
on the group mapper. A provider that cannot send paths mirrors nothing.

#### Taking a group off the list

Removing a group from `groups` stops the mirroring of that group. It does not
deprovision anybody. The team keeps its name, its members and the skills,
sources and workflows it owns, and no sign-in changes it any more — the same
state the whole feature reaches when `ssoTeamSync` goes off. The list decides
what Valet updates, never what Valet takes away.

The api prints one line at boot naming each such team. Put the group back on
the list and restart, and the next sign-in of each member updates the team
again.

One limitation to know: while `ssoTeamSync` is on, the api still refuses to
rename, empty or delete such a team, because it reads `origin='idp'` and the
gate and nothing else. To edit or delete one by hand, turn `ssoTeamSync` off
first.

Do not give a team in `teams:` the same name as a group in
`auth.sso.teams.groups`. The api refuses to start on that pair, and it
compares the two without case, because `Platform` and `/platform` would
otherwise make two teams that look like one in the teams page. A declared
team and a mirrored group cannot share a name: each owns its members, and
sharing one row would make the file add a member at every boot that the sync
removes at the next sign-in.

#### Turning team sync off again

Valet deletes no team when `ssoTeamSync` goes off. A team that mirrored a
group keeps its name, its members, and the skills, sources and workflows it
owns — a delete would take that work away from people who only changed a
setting. What stops is the updating: no sign-in adds a member, removes one,
or creates a team any more.

Those teams then become editable in Valet again. While the sync runs, Valet
refuses to rename, empty or delete a mirrored team, because the next sign-in
would undo the change. With the sync off nothing undoes anything, so the
controls come back and the teams page marks each such team "Identity provider
(paused)". The api also prints one line at boot that names how many there
are.

Turn `ssoTeamSync` back on and each team is adopted again by its group path,
not by its name, so a team you renamed keeps working. From that point the
identity provider owns the membership again, and it removes anybody you added
by hand as each user signs in. No wipe and no re-import is needed.

## Sandboxes

| Variable | Description |
|----------|-------------|
| `VALET_MAX_UPLOAD_BYTES` | Per-upload size cap in bytes (default 52428800 = 50 MB). A request whose Content-Length exceeds the cap returns 413 before the body is parsed. A chunked body (no Content-Length) is buffered in memory before the cap check, so the cap bounds well-formed clients, not parser memory. Size the cap to your api memory budget. |
| `VALET_SANDBOX_BACKEND` | `docker` (default) \| `local` \| `kubernetes` |
| `VALET_SANDBOX_IMAGE` | Sandbox image ref (required for kubernetes; docker defaults to `node:20-bookworm`) |
| `VALET_SANDBOX_CPU` | Optional Kubernetes sandbox CPU default. Use a value greater than 0 and at most 64, such as `4` or `0.5`. Empty leaves it unset. |
| `VALET_SANDBOX_MEMORY` | Optional Kubernetes sandbox memory default. Use a positive quantity, such as `8Gi` or `500Mi`. Empty leaves it unset. |
| `VALET_SANDBOX_IDLE_MINUTES` | Idle-hibernation window (default `30`, `0` disables). Only effective on backends with hibernation (kubernetes) |
| `VALET_SANDBOX_NAMESPACE` | Kubernetes namespace for Sandbox CRs |
| `VALET_SANDBOX_IMAGE_PULL_SECRET` | Image pull secret name (kubernetes) |
| `VALET_KUBE_CONTEXT` | kubectl context (required when running out-of-cluster) |
| `VALET_SANDBOX_API_URL` | URL sandboxes use to call back into the API (defaults to the auth base URL) |

The Helm chart maps `sandbox.resources.cpu` and `sandbox.resources.memory` to
these defaults. Repository YAML overrides saved repository defaults, which override
deployment defaults per field. Kubernetes uses equal requests and limits. Invalid
deployment values stop API startup. See [sandbox resources](prebuild-yaml.md#resources)
for precedence, replacement, and read-failure behavior.

Inside each sandbox, the provider injects: `VALET_SANDBOX_TOKEN`,
`VALET_API_URL`, `VALET_SANDBOX_JWT_SECRET`, `VALET_SESSION_ID`,
`VALET_SANDBOX_PROFILE`.

## Integrations

Optional. These variables hold the OAuth client the server uses to connect
integrations on a user's behalf, in Settings → Integrations.

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client for the Gmail, Google Calendar, and Google Workspace integrations |

### The two Google pairs

Valet reads two Google credential pairs, and they do different jobs:

| Pair | What it turns on |
|------|------------------|
| `AUTH_GOOGLE_CLIENT_ID` / `AUTH_GOOGLE_CLIENT_SECRET` | Sign in to Valet with a Google account |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Connect the Gmail, Google Calendar, and Google Workspace integrations |

The two pairs may hold the same Google OAuth client's id and secret, but the
server reads them separately and never falls back from one to the other. Set
only the `AUTH_` pair and sign-in works while nobody can connect the three
Google integrations. Add this redirect URI to the OAuth client behind the
second pair: `{public URL}/api/credentials/oauth/callback`.

Each pair is all-or-none. A Google integration whose pair is half-set stays
unconnectable, the same as an unset pair
(`services/integration-availability.ts`). Settings → Integrations names the
unset variables to an org admin. A member sees no tile for the integration,
and a member who connected it before the pair went missing is told to ask an
org admin.

## GitHub App fallback

Optional. These variables point the deployment at a pre-existing GitHub
App, as an alternative to the in-app manifest flow. The env is the config
— nothing lands in the database. An org that later creates an App in the
UI shadows the fallback. Set all required variables or none. If the set
is partial, GitHub App operations fail and name the missing variables.
Point the App's webhook URL at `{public URL}/webhooks/github-app`. Point
its callback URL at `{public URL}/api/me/github/callback`. The
env-fallback entry in
`docs/specs/2026-07-16-github-repo-integration-design.md` has the full
semantics.

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_APP_ID` | Yes | The App's numeric id |
| `GITHUB_APP_SLUG` | Yes | The App's URL slug (drives the install link) |
| `GITHUB_APP_CLIENT_ID` | Yes | OAuth client id (user connect flow) |
| `GITHUB_APP_CLIENT_SECRET` | Yes | OAuth client secret |
| `GITHUB_APP_PRIVATE_KEY` | Yes | The App's private key PEM, raw or base64-encoded |
| `GITHUB_APP_WEBHOOK_SECRET` | No | Webhook HMAC secret. Leave unset for a webhook-less App |

## Linear events

Personal Linear connections enable MCP tools. Organization event triggers use a
separate native OAuth app configured on the API server.

| Variable | Description |
|----------|-------------|
| `LINEAR_CLIENT_ID` | Native Linear OAuth app client ID |
| `LINEAR_CLIENT_SECRET` | Native Linear OAuth app client secret |
| `VALET_PUBLIC_URL` | Reachable HTTPS API base URL for callbacks and webhook delivery |

1. Provision the Linear OAuth app for the intended workspace.
2. Register `{public API URL}/api/org/linear/callback` as its redirect URI.
3. Set the variables above and restart the API server.
4. As an organization admin, open Settings > Organization > Linear events and connect.

The server requests `read,write,admin` with `actor=app`. After authorization, it
registers `{public API URL}/webhooks/events/linear` and stores a generated signing
secret with the organization credential. No webhook secret environment variable
is needed. Local development needs a public tunnel for webhook delivery.

For Helm, supply these variables through an external Secret referenced by
`api.extraEnvFrom`. Restart the API after changing that Secret; the chart cannot
automatically detect changes to externally managed Secrets. Keep secret values
out of committed values files.

## Channels

| Variable | Description |
|----------|-------------|
| `VALET_PUBLIC_URL` | Public URL for channel webhooks. Set (or a public `BETTER_AUTH_URL`) → webhook mode. Unset → long-poll |

## CLI

| Variable | Description |
|----------|-------------|
| `VALET_INSTANCE` | Named instance profile to target (client subcommands) |
| `VALET_DATA_DIR` | Also locates `~/.valet/config.json` for the CLI |

## Test-only

`VALET_TEST_AUTH_HEADER` (enables `x-valet-test-user-id` impersonation — never
set in dev targets or `.env`), `VALET_SKIP_DOCKER_TESTS`, `TEST_DATABASE_URL`,
`TELEGRAM_TEST_BOT_TOKEN` / `TELEGRAM_TEST_CHAT_ID`, and the
`VALET_GITHUB_LIVE_*` live-App test variables.


## Registry capacity

| Variable | Default | Purpose |
|---|---|---|
| `VALET_REGISTRY_HEALTH_URL` | unset | Filesystem probe URL. The bundled Helm registry sets this automatically. |
| `VALET_REGISTRY_MIN_FREE_GB` | `5` | Minimum available registry bytes, in decimal GB. Zero disables only the absolute reserve. |
| `VALET_REGISTRY_MIN_FREE_PERCENT` | `10` | Minimum available registry capacity percentage. Must be greater than 0 and less than 100. |

The API uses the larger reserve. At or below the reserve, new bakes fail before creation.
Sandbox-backed children can use an existing startup image with a warning. Children with no startup image fail before creation.
A configured probe that fails uses the same policy. An unset probe reports unknown capacity without blocking admission.
See [registry capacity and cache health](specs/2026-08-02-sandbox-reconcile-design.md#registry-capacity-and-cache-health-2026-09-11) for the API response and operational limits.
