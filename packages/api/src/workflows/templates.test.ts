import linearEventPlugin from "@valet/plugin-linear/plugin";
import { generateKeyPairSync } from "node:crypto";
/**
 * Workflow template aggregation and install.
 *
 * The install path is the reason this file exists. It writes three rows —
 * a definition, its version-1 snapshot, and a cron schedule — and a
 * half-written install is worse than a failed one: a schedule armed
 * against a workflow that does not exist fires forever and fails forever.
 * `install writes nothing when a later write fails` forces exactly that
 * failure with a database constraint and asserts the first two rows are
 * gone too.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { and, eq } from "drizzle-orm";
import type {
  ActionPlugin,
  CredentialStore,
  PluginAction,
  StoredCredential,
  ValetPlugin,
  WorkflowTemplate,
} from "@valet/engine";
import { InMemoryCredentialStore } from "@valet/engine";
import type { WorkflowDefinition } from "@valet/workflow";
import { bundledPlugins } from "../plugins/registry.gen.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import type { AppDb } from "../lib/drizzle.js";
import type { PgDb } from "@valet/store-postgres";
import { linearInstallations, githubInstallations, eventSubscriptions, orgs, teamMembers, teams, workflowDefinitions, workflowSchedules, workflowVersions } from "../schema/index.js";
import { setApprovedModels } from "../services/approved-models.js";
import { assemblePlugins } from "../plugins/assemble.js";
import {
  bakeInputs,
  installWorkflowTemplate,
  listPluginTemplates,
  listWorkflowTemplateSummaries,
  templateInputs,
  type TemplateServiceDeps,
} from "./templates.js";

const OWNER = { userId: "u-1", orgId: "org-1" };

// ─── Fixture plugins ─────────────────────────────────────────────────────

function action(
  id: string,
  riskLevel: PluginAction["riskLevel"],
  parameters: PluginAction["parameters"] = Type.Object({}),
): PluginAction {
  return {
    id,
    name: id,
    description: id,
    riskLevel,
    parameters,
    execute: () => Promise.resolve({ success: true, data: {} }),
  };
}

const gmailActions: ActionPlugin = {
  service: "gmail",
  actions: [action("gmail.list_labels", "low"), action("gmail.send_email", "high")],
};

const linearActions: ActionPlugin = {
  service: "linear",
  // A dynamic resolver is what makes an MCP-backed service's action NAMES
  // unverifiable at save time — the caveat the summary must carry.
  actions: [],
  resolveActions: () => Promise.resolve([action("linear.list_issues", "medium")]),
};

/** No credential declaration anywhere, so nothing needs connecting.
 * The read action declares the params its fixture templates send — the
 * save-time params lint checks tool params against this schema. */
const localActions: ActionPlugin = {
  service: "notes",
  actions: [
    action(
      "notes.read",
      "low",
      Type.Object({
        id: Type.String(),
        depth: Type.Optional(Type.Number()),
        label: Type.Optional(Type.String()),
      }),
    ),
  ],
};

function definition(nodes: unknown[], edges: unknown[]): unknown {
  return { version: "dag/v1", nodes, edges };
}

const sweepDefinition = definition(
  [
    { id: "start", type: "trigger" },
    { id: "labels", type: "tool", service: "gmail", action: "list_labels", params: {} },
    {
      id: "batch",
      type: "foreach",
      items: "{{ nodes.labels.result.labels }}",
      maxItems: 25,
      body: { id: "one", type: "llm", model: "claude-haiku-4-5", prompt: "{{ item }}" },
    },
  ],
  [
    { from: "start", to: "labels" },
    { from: "labels", to: "batch" },
  ],
);

const gmailSweep: WorkflowTemplate = {
  id: "gmail-sweep",
  name: "Inbox sweeper",
  description: "Moves low-priority mail onto one label.",
  category: "Inbox",
  apps: ["gmail"],
  steps: ["Read the labels", "Sort the mail"],
  definition: sweepDefinition,
  schedule: { name: "Inbox sweeper", cron: "0 12 * * 1-5", timezone: "UTC", description: "Weekdays at 12:00" },
};

const gmailBlast: WorkflowTemplate = {
  id: "gmail-blast",
  name: "Mail blast",
  description: "Sends a message.",
  category: "Inbox",
  apps: ["gmail"],
  steps: ["Send"],
  caveats: ["Written by the template author."],
  definition: definition(
    [
      { id: "start", type: "trigger" },
      { id: "send", type: "tool", service: "gmail", action: "send_email", params: {} },
    ],
    [{ from: "start", to: "send" }],
  ),
};

const linearDigest: WorkflowTemplate = {
  id: "linear-digest",
  name: "Linear digest",
  description: "Summarizes open issues.",
  category: "Daily digest",
  apps: ["linear"],
  steps: ["Read the issues"],
  definition: definition(
    [
      { id: "start", type: "trigger" },
      { id: "issues", type: "tool", service: "linear", action: "list_issues", params: {} },
    ],
    [{ from: "start", to: "issues" }],
  ),
};

/** Needs no credential, and reads one baked-in parameter. */
const notesTemplate: WorkflowTemplate = {
  id: "notes-echo",
  name: "Notes echo",
  description: "Reads one note.",
  category: "Batch work",
  apps: ["notes"],
  steps: ["Read"],
  definition: definition(
    [
      {
        id: "start",
        type: "trigger",
        dataSchema: {
          noteId: { type: "string", required: true, label: "Note id", placeholder: "n_123" },
          secret: { type: "string", hidden: true },
          rows: { type: "array" },
        },
      },
      { id: "read", type: "tool", service: "notes", action: "read", params: { id: "{{ trigger.data.noteId }}" } },
    ],
    [{ from: "start", to: "read" }],
  ),
};

/**
 * Scheduled AND parameterised — the combination the baking rule exists for.
 * A scheduled run applies no `dataSchema` defaults, so install has to
 * resolve every field before it writes: the declared default for one, and a
 * refusal for the required field nobody supplied.
 */
const notesNightly: WorkflowTemplate = {
  id: "notes-nightly",
  name: "Notes nightly",
  description: "Reads one note every night.",
  category: "Batch work",
  apps: ["notes"],
  steps: ["Read"],
  definition: definition(
    [
      {
        id: "start",
        type: "trigger",
        dataSchema: {
          noteId: { type: "string", required: true, label: "Note id", placeholder: "n_123" },
          depth: { type: "number", required: true, default: 3, label: "Depth" },
        },
      },
      {
        id: "read",
        type: "tool",
        service: "notes",
        action: "read",
        params: { id: "{{ trigger.data.noteId }}", depth: "{{ trigger.data.depth }}" },
      },
    ],
    [{ from: "start", to: "read" }],
  ),
  schedule: { name: "Notes nightly", cron: "0 3 * * *", timezone: "UTC", description: "Every day at 03:00" },
};

/**
 * The same schedule with NO tool node. A scheduled TEAM install is refused
 * only when the definition holds tool steps (no credential to act as), so
 * this is the shape that reaches the schedule insert with a team owner.
 */
const nightlyNoTools: WorkflowTemplate = {
  ...notesNightly,
  id: "nightly-no-tools",
  name: "Nightly no tools",
  apps: [],
  definition: definition(
    [
      { id: "start", type: "trigger" },
      { id: "stop", type: "stop" },
    ],
    [{ from: "start", to: "stop" }],
  ),
};

/**
 * An EVENT-driven template: no schedule, one subscription install arms, and
 * a filter whose value comes from an install-time input. The trigger def
 * supplies the catalog entry `validateSubscription` checks the filter field
 * against — an undeclared field is the failure mode worth a test, because
 * it arms a subscription that silently matches nothing.
 */
const notesOnEvent: WorkflowTemplate = {
  id: "notes-on-event",
  name: "Notes on event",
  description: "Reads a note when one is written.",
  category: "Batch work",
  apps: ["notes"],
  steps: ["Read"],
  definition: definition(
    [
      {
        id: "start",
        type: "trigger",
        dataSchema: {
          watched: { type: "string", required: true, label: "Folder" },
          payload: { type: "object", hidden: true },
        },
      },
      { id: "read", type: "tool", service: "notes", action: "read", params: { id: "n_1" } },
    ],
    [{ from: "start", to: "read" }],
  ),
  events: [
    {
      name: "On a note",
      eventKeys: ["notes.written"],
      filters: [{ field: "folder", op: "eq", fromInput: "watched" }],
      description: "When a note is written",
    },
  ],
};

/** Same, with a filter field the catalog does not declare. */
const notesBadFilter: WorkflowTemplate = {
  ...notesOnEvent,
  id: "notes-bad-filter",
  name: "Notes bad filter",
  events: [
    {
      name: "On a note",
      eventKeys: ["notes.written"],
      filters: [{ field: "not_a_declared_field", op: "eq", fromInput: "watched" }],
      description: "When a note is written",
    },
  ],
};

/** The catalog entry both fixtures above are validated against. */
const notesTriggerDef = {
  id: "notes.written",
  service: "notes",
  description: "A note was written",
  verify: () => Promise.resolve(null),
  toEvent: () => ({
    key: "notes.written",
    dedupeKey: "d",
    occurredAt: new Date(0).toISOString(),
    refs: {},
    summary: "note written",
    payload: {},
  }),
  catalog: [
    {
      key: "notes.written",
      description: "A note was written",
      filters: [{ field: "folder", path: "folder", description: "Folder" }],
    },
  ],
};

const eventPlugin: ValetPlugin = {
  name: "notes-events",
  version: "0.0.1",
  actions: [localActions],
  triggers: [notesTriggerDef],
  templates: [notesOnEvent],
};

const badFilterPlugin: ValetPlugin = {
  name: "notes-bad-filter",
  version: "0.0.1",
  actions: [localActions],
  triggers: [notesTriggerDef],
  templates: [notesBadFilter],
};

const brokenTemplate: WorkflowTemplate = {
  id: "broken",
  name: "Broken",
  description: "References a node that does not exist.",
  category: "Batch work",
  apps: [],
  steps: [],
  definition: definition(
    [
      { id: "start", type: "trigger" },
      { id: "read", type: "tool", service: "notes", action: "read", params: { id: "{{ nodes.ghost.result.id }}" } },
    ],
    [{ from: "start", to: "read" }],
  ),
};

const gmailPlugin: ValetPlugin = {
  name: "gmail",
  version: "0.0.1",
  actions: [gmailActions],
  credentials: [{ type: "oauth2", service: "gmail", configKeys: [] }],
  templates: [gmailSweep, gmailBlast],
};

const linearPlugin: ValetPlugin = {
  name: "linear",
  version: "0.0.1",
  actions: [linearActions],
  credentials: [{ type: "oauth2", service: "linear", configKeys: [] }],
  templates: [linearDigest],
};

const schedulePlugin: ValetPlugin = {
  name: "notes-schedule",
  version: "0.0.1",
  actions: [localActions],
  templates: [nightlyNoTools],
};

const notesPlugin: ValetPlugin = {
  name: "notes",
  version: "0.0.1",
  actions: [localActions],
  templates: [notesTemplate, notesNightly, brokenTemplate],
};

/**
 * The shape slack ships: a credential an ADMIN has to connect for the whole
 * organization before anybody can connect their own. Until that happens the
 * service resolves "unconfigured" (integration-availability design) and the
 * integrations page hides it, so the person reading a template card has no
 * page that would let them connect it.
 */
const orgGatedActions: ActionPlugin = {
  service: "chat",
  actions: [action("chat.post", "low", Type.Object({ text: Type.String() }))],
};

const chatTemplate: WorkflowTemplate = {
  id: "chat-note",
  name: "Chat note",
  description: "Posts one message.",
  category: "Chat",
  apps: ["chat"],
  steps: ["Post"],
  definition: definition(
    [
      { id: "start", type: "trigger" },
      { id: "post", type: "tool", service: "chat", action: "post", params: { text: "hello" } },
    ],
    [{ from: "start", to: "post" }],
  ),
};

/** An App-pinned GitHub step: the run acts as the org's GitHub App, and
 * no team or personal connection can stand in for it. */
const githubAppTemplate: WorkflowTemplate = {
  id: "github-app-issues",
  name: "App issues",
  description: "Lists issues as the App.",
  category: "Chat",
  apps: ["github"],
  steps: ["List"],
  definition: definition(
    [
      { id: "start", type: "trigger" },
      { id: "issues", type: "tool", service: "github", action: "list_issues", params: {}, credential: "app" },
    ],
    [{ from: "start", to: "issues" }],
  ),
};

/** The same service, pinned the other way: the run acts as the person who
 * owns the workflow, so a team run reads the team's own github row and the
 * App can never stand in for it. Its answer must not decide the App-pinned
 * template's answer. */
const githubUserTemplate: WorkflowTemplate = {
  id: "github-user-issues",
  name: "User issues",
  description: "Lists issues as the workflow owner.",
  category: "Chat",
  apps: ["github"],
  steps: ["List"],
  definition: definition(
    [
      { id: "start", type: "trigger" },
      { id: "issues", type: "tool", service: "github", action: "list_issues", params: {}, credential: "user" },
    ],
    [{ from: "start", to: "issues" }],
  ),
};

const githubPlugin: ValetPlugin = {
  name: "github",
  version: "0.0.1",
  actions: [{ service: "github", actions: [action("github.list_issues", "low")] }],
  credentials: [{ type: "oauth2", service: "github", configKeys: [] }],
  templates: [githubAppTemplate, githubUserTemplate],
};

const chatPlugin: ValetPlugin = {
  name: "chat",
  version: "0.0.1",
  actions: [orgGatedActions],
  credentials: [
    { type: "bot_token", service: "chat", configKeys: ["accessToken"], requires: { orgCredential: true } },
  ],
  templates: [chatTemplate],
};

// ─── Harness ─────────────────────────────────────────────────────────────

let db: AppDb;
let pgdb: PgDb;
let credentials: CredentialStore;

async function boot(): Promise<void> {
  const fresh = await freshTestPgDb();
  db = fresh.appDb;
  pgdb = fresh.pgdb;
}

function deps(plugins: ValetPlugin[] = [gmailPlugin, linearPlugin, notesPlugin]): TemplateServiceDeps {
  const assembled = assemblePlugins([plugins]);
  return {
    db,
    plugins: assembled.plugins,
    actionPluginByService: assembled.actionPluginByService,
    credentials,
  };
}

async function connect(service: string, userId = OWNER.userId): Promise<void> {
  const cred: StoredCredential = { type: "oauth2", accessToken: `token-${service}` };
  await credentials.save({ type: "user", id: userId }, service, cred);
}

async function seedTeam(teamId: string, memberIds: string[]): Promise<void> {
  await db.insert(teams).values({ id: teamId, orgId: OWNER.orgId, name: teamId, createdAt: Date.now() });
  for (const userId of memberIds) {
    await db.insert(teamMembers).values({ teamId, userId, role: "member" });
  }
}

beforeEach(async () => {
  // Install validates the baked definition against the org's model
  // environment, exactly as `POST /api/workflows` does. The bundled
  // templates name Anthropic models, so the org needs a key it can reach or
  // every install is refused for a reason none of these tests is about.
  vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
  await boot();
  credentials = new InMemoryCredentialStore();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  // `freshTestPgDb` shares one PGlite instance per process; nothing to close.
});

// ─── Aggregation ─────────────────────────────────────────────────────────

describe("listPluginTemplates", () => {
  it("flattens every loaded plugin's templates in plugin order", () => {
    const owned = listPluginTemplates([gmailPlugin, linearPlugin]);
    expect(owned.map((o) => o.template.id)).toEqual(["gmail-sweep", "gmail-blast", "linear-digest"]);
    expect(owned[0]!.pluginName).toBe("gmail");
  });

  it("returns nothing for a plugin set that contributes no template", () => {
    expect(listPluginTemplates([{ name: "bare", version: "0.0.1" }])).toEqual([]);
  });

  it("throws on a repeated id, naming both plugins", () => {
    const twin: ValetPlugin = { name: "twin", version: "0.0.1", templates: [gmailSweep] };
    expect(() => listPluginTemplates([gmailPlugin, twin])).toThrow(/"gmail-sweep".*"gmail".*"twin"/s);
  });
});

// ─── Listing ─────────────────────────────────────────────────────────────

describe("listWorkflowTemplateSummaries", () => {
  it("reports an unconnected service, and flips it once connected", async () => {
    const before = await listWorkflowTemplateSummaries(deps(), OWNER);
    const sweepBefore = before.find((t) => t.id === "gmail-sweep");
    expect(sweepBefore?.requires).toEqual([{ service: "gmail", connected: false }]);

    await connect("gmail");
    const after = await listWorkflowTemplateSummaries(deps(), OWNER);
    expect(after.find((t) => t.id === "gmail-sweep")?.requires).toEqual([{ service: "gmail", connected: true }]);
  });

  it("treats a service that declares no credential as needing nothing", async () => {
    const list = await listWorkflowTemplateSummaries(deps(), OWNER);
    expect(list.find((t) => t.id === "notes-echo")?.requires).toEqual([{ service: "notes", connected: true }]);
  });

  it("marks a service that resolves its actions at run time", async () => {
    const list = await listWorkflowTemplateSummaries(deps(), OWNER);
    expect(list.find((t) => t.id === "linear-digest")?.requires).toEqual([
      { service: "linear", connected: false, dynamic: true },
    ]);
  });

  /**
   * An organization that has not set the service up is NOT a reason to drop
   * the card. The person cannot connect the service, so a card offering
   * "Connect chat" would send them to a page that hides it. The card is
   * kept and the state is reported, which is what lets the gallery name the
   * admin's setup instead of a link.
   */
  it("keeps a template whose service the organization has not configured, and says so", async () => {
    const list = await listWorkflowTemplateSummaries(deps([chatPlugin]), OWNER);
    expect(list.map((t) => t.id)).toContain("chat-note");
    expect(list.find((t) => t.id === "chat-note")?.requires).toEqual([
      { service: "chat", connected: false, unconfigured: true },
    ]);
  });

  it("reports a service the organization connected as connected — nobody's own credential list ever carries it", async () => {
    // The org credential IS the integration (Settings → Organization →
    // Chat): every member reads it by owner escalation, and no member ever
    // gets a personal row for "chat" in their own credential list. Reading
    // only that list — the bug this pins — would report this template as
    // needing a personal connection forever, to a service the caller can
    // never personally connect.
    await credentials.save({ type: "org", id: OWNER.orgId }, "chat", {
      type: "bot_token",
      accessToken: "chat-org-token",
    });
    const list = await listWorkflowTemplateSummaries(deps([chatPlugin]), OWNER);
    expect(list.find((t) => t.id === "chat-note")?.requires).toEqual([{ service: "chat", connected: true }]);
  });

  it("hides a template whose definition does not validate", async () => {
    const list = await listWorkflowTemplateSummaries(deps(), OWNER);
    expect(list.map((t) => t.id)).not.toContain("broken");
    expect(list.map((t) => t.id)).toContain("notes-echo");
  });

  it("derives the caveats the definition can prove, after the author's own", async () => {
    const list = await listWorkflowTemplateSummaries(deps(), OWNER);

    expect(list.find((t) => t.id === "gmail-sweep")?.caveats).toEqual([
      "Each run processes at most 25 items. The workflow reports the count it did not process.",
    ]);

    const blast = list.find((t) => t.id === "gmail-blast");
    expect(blast?.caveats[0]).toBe("Written by the template author.");
    expect(blast?.caveats[1]).toContain("gmail.send_email");
    expect(blast?.caveats[1]).toContain("high risk");

    expect(list.find((t) => t.id === "linear-digest")?.caveats[0]).toContain("finds its action when the workflow runs");
  });

  it("does not repeat a limit the author already wrote about", async () => {
    const spelledOut: WorkflowTemplate = {
      ...gmailSweep,
      id: "gmail-sweep-documented",
      caveats: ["It sorts at most 25 messages per run.", "It reads linear only to name the issue."],
    };
    const plugin: ValetPlugin = { ...gmailPlugin, templates: [spelledOut] };
    const list = await listWorkflowTemplateSummaries(deps([plugin, linearPlugin, notesPlugin]), OWNER);
    // "25" appears in the author's line, so the derived foreach line is
    // dropped rather than said twice.
    expect(list.find((t) => t.id === "gmail-sweep-documented")?.caveats).toEqual(spelledOut.caveats);
  });

  it("still names a high-risk step even when the author wrote about it", async () => {
    const documented: WorkflowTemplate = {
      ...gmailBlast,
      id: "gmail-blast-documented",
      caveats: ["This sends mail through gmail.send_email."],
    };
    const plugin: ValetPlugin = { ...gmailPlugin, templates: [documented] };
    const list = await listWorkflowTemplateSummaries(deps([plugin]), OWNER);
    // An approval gate on an unattended run is the one thing card copy
    // must never be able to hide, so this line is never suppressed.
    expect(list[0]?.caveats).toHaveLength(2);
    expect(list[0]?.caveats[1]).toContain("high risk");
  });

  it("says a scheduled high-risk step makes the run wait, not fail", async () => {
    const scheduledBlast: WorkflowTemplate = {
      ...gmailBlast,
      id: "gmail-blast-daily",
      caveats: undefined,
      schedule: { name: "Blast", cron: "0 9 * * *", timezone: "UTC", description: "Daily at 09:00" },
    };
    const plugin: ValetPlugin = { ...gmailPlugin, templates: [scheduledBlast] };
    const list = await listWorkflowTemplateSummaries(deps([plugin]), OWNER);
    expect(list[0]?.caveats[0]).toContain("a scheduled run then waits until a person answers");
  });

  it("carries the schedule the gallery shows, and null when there is none", async () => {
    const list = await listWorkflowTemplateSummaries(deps(), OWNER);
    expect(list.find((t) => t.id === "gmail-sweep")?.schedule).toEqual({ cron: "0 12 * * 1-5", timezone: "UTC" });
    expect(list.find((t) => t.id === "linear-digest")?.schedule).toBeNull();
  });
});

// ─── Listing in a team workspace ─────────────────────────────────────────

/**
 * A listing taken in a team workspace has to measure the team, because a
 * team install does. The gallery reads `requires[].connected` to decide
 * whether to offer Install at all, so a listing judged by the caller's own
 * connections produces a card that refuses an install the server would
 * accept, and connecting the service personally never changes it.
 */
describe("listWorkflowTemplateSummaries in a team workspace", () => {
  it("reports nested services and unreadable calls in team gallery summaries", async () => {
    await seedTeam("nested-team", [OWNER.userId]);
    await db.insert(workflowDefinitions).values({
      id: "nested-child", orgId: OWNER.orgId, ownerType: "team", ownerId: "nested-team",
      name: "Child", definition: sweepDefinition, createdAt: 1, updatedAt: 1,
    });
    const parent = (id: string, workflowId: string): WorkflowTemplate => ({
      ...gmailSweep, id,
      definition: definition(
        [{ id: "start", type: "trigger" }, { id: "call", type: "workflow", workflowId }],
        [{ from: "start", to: "call" }],
      ),
    });
    const service = deps([{ ...gmailPlugin, templates: [parent("nested", "nested-child"), parent("missing", "gone")] }]);
    const list = () => listWorkflowTemplateSummaries(service, OWNER, { teamId: "nested-team" });
    const summaries = await list();
    expect(summaries.find((s) => s.id === "nested")?.requires).toEqual([{ service: "gmail", connected: false }]);
    expect(summaries.find((s) => s.id === "missing")?.blockers?.join(" ")).toContain("Reference a workflow this team owns");
    await credentials.save({ type: "team", id: "nested-team" }, "gmail", { type: "oauth2", accessToken: "team-token" });
    const ready = (await list()).find((s) => s.id === "nested");
    expect(ready?.requires).toEqual([{ service: "gmail", connected: true }]);
    expect(ready?.blockers).toEqual([]);
  });

  it("reports a service the team holds as connected, though the caller has not connected it", async () => {
    await seedTeam("team-list-1", [OWNER.userId]);
    await credentials.save({ type: "team", id: "team-list-1" }, "gmail", {
      type: "oauth2",
      accessToken: "team-gmail",
    });

    const list = await listWorkflowTemplateSummaries(deps(), OWNER, { teamId: "team-list-1" });
    expect(list.find((t) => t.id === "gmail-sweep")?.requires).toEqual([
      { service: "gmail", connected: true },
    ]);
  });

  it("reports a service only the caller holds as not connected for the team", async () => {
    await seedTeam("team-list-2", [OWNER.userId]);
    await connect("gmail");

    const list = await listWorkflowTemplateSummaries(deps(), OWNER, { teamId: "team-list-2" });
    expect(list.find((t) => t.id === "gmail-sweep")?.requires).toEqual([
      { service: "gmail", connected: false },
    ]);
    // The same caller's PERSONAL listing still reads connected: the two
    // answers differ because the two installs differ.
    const personal = await listWorkflowTemplateSummaries(deps(), OWNER);
    expect(personal.find((t) => t.id === "gmail-sweep")?.requires).toEqual([
      { service: "gmail", connected: true },
    ]);
  });

  it("offers exactly what the install accepts, in both directions", async () => {
    await seedTeam("team-list-3", [OWNER.userId]);
    await credentials.save({ type: "team", id: "team-list-3" }, "gmail", {
      type: "oauth2",
      accessToken: "team-gmail",
    });

    const list = await listWorkflowTemplateSummaries(deps(), OWNER, { teamId: "team-list-3" });
    const offered = list.filter((t) => t.requires.every((r) => r.connected)).map((t) => t.id);
    for (const id of ["gmail-sweep", "linear-digest"]) {
      const install = await installWorkflowTemplate(deps(), OWNER, id, { teamId: "team-list-3" });
      expect(offered.includes(id)).toBe(install.ok);
    }
  });

  it("keeps an App-pinned template readable when another template pins the owner's own token", async () => {
    // The listing memoizes readiness per definition signature, so two
    // templates that pin `github` differently must not share an answer:
    // the App pin here is ready and the user pin is not, and one answer
    // for both would hide the ready one behind the blocked one.
    await seedTeam("team-list-4", [OWNER.userId]);
    await credentials.save({ type: "org", id: OWNER.orgId }, "github_app", {
      type: "api_key",
      apiKey: "-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----",
      accessToken: "client-secret",
      refreshToken: "webhook-secret",
      metadata: { appId: "1", appSlug: "valet", oauthClientId: "iv1", htmlUrl: "https://github.com/apps/valet" },
    });

    await db.insert(githubInstallations).values({
      id: "app-list", orgId: OWNER.orgId, installationId: 1, accountLogin: "acme",
      accountType: "Organization", repositorySelection: "selected", suspended: false,
      createdAt: 1000, updatedAt: 1000,
    });
    const list = await listWorkflowTemplateSummaries(deps([githubPlugin]), OWNER, {
      teamId: "team-list-4",
    });
    expect(list.find((t) => t.id === "github-app-issues")?.requires).toEqual([
      { service: "github", connected: true, organizationProvided: true },
    ]);
    expect(list.find((t) => t.id === "github-user-issues")?.requires).toEqual([
      { service: "github", connected: false },
    ]);
  });
});

// ─── The shipped gallery, now that Slack is available ────────────────────

/**
 * Every other case in this file uses fixtures, so the assertions do not
 * move when a template's copy does. This one runs the REAL plugin set: it
 * pins that removing "slack" from `SERVICES_NOT_READY` actually changes
 * what a person sees, not only what the flag says. `requires` is derived
 * from tool nodes rather than declared by an author, so a slack tool node
 * added to or removed from any template below moves this test.
 */
describe("the shipped gallery, now that Slack is available", () => {
  async function shippedIds(): Promise<string[]> {
    const list = await listWorkflowTemplateSummaries(deps(bundledPlugins), OWNER);
    return list.map((t) => t.id);
  }

  it("offers the reviewer-assignment template, and reports that it needs Slack now", async () => {
    const list = await listWorkflowTemplateSummaries(deps(bundledPlugins), OWNER);
    const summary = list.find((t) => t.id === "github.assign-reviewers");
    expect(summary).toBeDefined();
    expect(summary?.requires.map((r) => r.service)).toContain("slack");
  });

  it("now offers the two templates that read Slack for their data", async () => {
    const ids = await shippedIds();
    expect(ids).toContain("workflows.daily-triage-digest");
    expect(ids).toContain("workflows.meeting-prep");
  });
});

describe("templateInputs", () => {
  it("labels each field, drops hidden fields, and drops non-primitives", () => {
    expect(
      templateInputs({
        noteId: { type: "string", required: true, label: "Note id", placeholder: "n_123" },
        secret: { type: "string", hidden: true },
        rows: { type: "array" },
        count: { type: "number", default: 5 },
      }),
    ).toEqual([
      { name: "noteId", type: "string", label: "Note id", placeholder: "n_123", required: true },
      { name: "count", type: "number", label: "count", required: false, default: 5 },
    ]);
  });

  it("is empty for a trigger that declares no schema", () => {
    expect(templateInputs(undefined)).toEqual([]);
  });
});

// ─── Baking ──────────────────────────────────────────────────────────────

describe("bakeInputs", () => {
  const base: WorkflowDefinition = {
    version: "dag/v1",
    nodes: [
      { id: "start", type: "trigger", dataSchema: { channel: { type: "string" }, note: { type: "string" } } },
      {
        id: "read",
        type: "tool",
        service: "notes",
        action: "read",
        params: { id: "{{ trigger.data.channel }}", label: "for {{ trigger.data.channel }} today" },
      },
    ],
    edges: [{ from: "start", to: "read" }],
  };

  it("keeps the value's type in a single-expression field and stringifies in mixed text", () => {
    const baked = bakeInputs(base, { channel: "C123" });
    const node = baked.nodes[1];
    expect(node?.type).toBe("tool");
    if (node?.type !== "tool") throw new Error("expected a tool node");
    expect(node.params.id).toBe("C123");
    expect(node.params.label).toBe("for C123 today");
  });

  it("drops a baked field from the trigger schema and keeps the others", () => {
    const baked = bakeInputs(base, { channel: "C123" });
    const trigger = baked.nodes[0];
    if (trigger?.type !== "trigger") throw new Error("expected a trigger node");
    expect(Object.keys(trigger.dataSchema ?? {})).toEqual(["note"]);
  });

  it("leaves the definition alone when there is nothing to bake", () => {
    expect(bakeInputs(base, {})).toBe(base);
  });

  it("keeps a field whose remaining reference it cannot rewrite", () => {
    const nested: WorkflowDefinition = {
      version: "dag/v1",
      nodes: [
        { id: "start", type: "trigger", dataSchema: { rows: { type: "object" } } },
        { id: "set", type: "set", values: { first: "{{ trigger.data.rows.first }}" } },
      ],
      edges: [{ from: "start", to: "set" }],
    };
    const baked = bakeInputs(nested, { rows: "x" });
    const trigger = baked.nodes[0];
    if (trigger?.type !== "trigger") throw new Error("expected a trigger node");
    // `trigger.data.rows.first` is a longer path, so the literal cannot be
    // written in — the field must stay declared.
    expect(Object.keys(trigger.dataSchema ?? {})).toEqual(["rows"]);
  });

  it("does not mutate the template the plugin ships", () => {
    const snapshot = JSON.stringify(base);
    bakeInputs(base, { channel: "C123" });
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

// ─── Install ─────────────────────────────────────────────────────────────

describe("installWorkflowTemplate", () => {
  it("requires organization ingress before arming a Linear template", async () => {
    const template: WorkflowTemplate = {
      id: "linear-event-test", name: "Linear event", description: "Responds to Linear.", category: "Work", apps: [], steps: ["Stop"],
      definition: definition([{ id: "start", type: "trigger" }, { id: "stop", type: "stop" }], [{ from: "start", to: "stop" }]),
      events: [{ name: "On issue", description: "When an issue changes", eventKeys: ["linear.issue.update"] }],
    };
    const scopedDeps = deps([{ ...linearEventPlugin, templates: [template] }]);
    expect(await installWorkflowTemplate(scopedDeps,OWNER,template.id)).toMatchObject({ ok: false, code: "not_connected", error: expect.stringContaining("Linear events") });
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
    await db.insert(linearInstallations).values({ id: "template-install", orgId: OWNER.orgId, workspaceId: "linear-org", workspaceName: "Linear", webhookId: "webhook", connectedBy: OWNER.userId, createdAt: 1, updatedAt: 1 });
    await credentials.save({ type: "org", id: OWNER.orgId },"linear",{ type: "oauth2", accessToken: "token", metadata: { webhookSecret: "secret" } });
    expect(await installWorkflowTemplate(scopedDeps,OWNER,template.id)).toMatchObject({ ok: true });
    expect(await db.select().from(eventSubscriptions)).toHaveLength(1);
  });

  it("writes the definition, its first version, and the schedule", async () => {
    await connect("gmail");
    const result = await installWorkflowTemplate(deps(), OWNER, "gmail-sweep");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const defs = await db.select().from(workflowDefinitions);
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe("Inbox sweeper");
    expect(defs[0]!.ownerType).toBe("user");
    expect(defs[0]!.ownerId).toBe(OWNER.userId);

    const versions = await db.select().from(workflowVersions);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(1);
    expect(versions[0]!.workflowId).toBe(result.workflowId);

    const schedules = await db.select().from(workflowSchedules);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]!.workflowId).toBe(result.workflowId);
    expect(schedules[0]!.enabled).toBe(true);
    expect(schedules[0]!.nextFireAt).toBeGreaterThan(Date.now());
    // The suffix comes from the workflow id minted in the same transaction.
    expect(schedules[0]!.name).toBe(`Inbox sweeper (${result.workflowId.slice(-6)})`);
    expect(result.scheduleId).toBe(schedules[0]!.id);
  });

  it("arms no schedule for a template that declares none", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-echo");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.scheduleId).toBeUndefined();
    expect(await db.select().from(workflowSchedules)).toHaveLength(0);
  });

  it("refuses an install whose model this organization cannot use", async () => {
    // The gallery lists the template — it is a valid template. The org just
    // cannot run its model, and an install writes the definition row
    // directly, so the gate has to be here or the workflow lands in the
    // editor and refuses its own first save.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    await connect("gmail");
    const result = await installWorkflowTemplate(deps(), OWNER, "gmail-sweep");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("invalid_input");
    expect(result.error).toContain("Settings > Models");
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
    expect(await db.select().from(workflowVersions)).toHaveLength(0);
  });

  it("refuses an install whose model the organization removed from its approved list", async () => {
    await db.insert(orgs).values({ id: OWNER.orgId, name: "Org", createdAt: Date.now() });
    await setApprovedModels(db, OWNER.orgId, ["anthropic/claude-opus-4-7"]);
    await connect("gmail");
    const result = await installWorkflowTemplate(deps(), OWNER, "gmail-sweep");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    if (result.code !== "invalid_input") throw new Error(`expected invalid_input, got ${result.code}`);
    expect(result.errors.join(" ")).toContain("Settings > Models");
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
  });

  it("still lists a template this organization cannot install", async () => {
    // The org's model policy belongs to the org, not to the template, so it
    // must not empty the gallery or brand a shipped template invalid.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    await connect("gmail");
    const list = await listWorkflowTemplateSummaries(deps(), OWNER);
    expect(list.map((t) => t.id)).toContain("gmail-sweep");
  });

  it("marks a template this organization cannot install, with both remedies", async () => {
    // The card stays, and it says why the Install button is off. Without
    // this the button is live and every press answers 400.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    await connect("gmail");
    const card = (await listWorkflowTemplateSummaries(deps(), OWNER)).find((t) => t.id === "gmail-sweep");
    expect(card?.installable).toBe(false);
    const reason = card?.installBlockedReason ?? "";
    expect(reason).toContain("gmail-sweep");
    expect(reason).toContain("Settings > Models");
    expect(reason).toContain("add a key for the provider");
    // The bundled templates name model ids, never a size tier, so the tier
    // remedy would send the reader to look for something that is not there.
    expect(reason).not.toContain("size tier");
    // The install gate refuses with the same sentence, so the card and the
    // install can never disagree.
    const refusal = await installWorkflowTemplate(deps(), OWNER, "gmail-sweep");
    expect(refusal.ok).toBe(false);
    if (refusal.ok) throw new Error("expected a refusal");
    expect(refusal.error).toBe(reason);
  });

  it("marks a template this organization can install", async () => {
    await connect("gmail");
    const card = (await listWorkflowTemplateSummaries(deps(), OWNER)).find((t) => t.id === "gmail-sweep");
    expect(card?.installable).toBe(true);
    expect(card?.installBlockedReason).toBeUndefined();
  });

  it("refuses a template whose service the caller has not connected", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "gmail-sweep");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("not_connected");
    expect(result.error).toBe("Connect gmail in Integrations, then install this template.");
    // Nothing was written, so the gallery can offer the card again after
    // the person connects.
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
    expect(await db.select().from(workflowSchedules)).toHaveLength(0);
  });

  it("installs a template whose service the ORGANIZATION connected, not the caller", async () => {
    // The gate this pins: an org-mode credential (Settings → Organization)
    // is never on any one member's own credential list, so a personal-list
    // check refuses this install forever — while the gallery, which reads
    // both sources, offers an Install button that then bounces. The two
    // must agree.
    await credentials.save({ type: "org", id: OWNER.orgId }, "chat", {
      type: "bot_token",
      accessToken: "chat-org-token",
    });
    const result = await installWorkflowTemplate(deps([chatPlugin]), OWNER, "chat-note");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(await db.select().from(workflowDefinitions)).toHaveLength(1);
  });

  it("sends an unconfigured service to an admin, not to the Integrations page", async () => {
    // The integrations page HIDES a service the org has not set up, so
    // "Connect chat in Integrations" would send the reader to a screen with
    // no button on it. Only an admin can act here.
    const result = await installWorkflowTemplate(deps([chatPlugin]), OWNER, "chat-note");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("not_connected");
    expect(result.error).toContain("not configured for this organization");
    expect(result.error).toContain("Settings → Organization");
    expect(result.error).not.toContain("Connect chat in Integrations");
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
  });

  it("arms a template's event triggers in the same transaction as the workflow", async () => {
    // The gap this closes: an event template used to install INERT. The
    // definition was correct and nothing ever called it, which reads as a
    // broken workflow rather than an unfinished setup.
    const result = await installWorkflowTemplate(deps([eventPlugin]), OWNER, "notes-on-event", {
      inputs: { watched: "acme/platform" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const subs = await db.select().from(eventSubscriptions);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.eventKeys).toEqual(["notes.written"]);
    expect(subs[0]!.target).toEqual({ kind: "workflow", workflowId: result.workflowId });
    expect(subs[0]!.enabled).toBe(true);
    // The install-time input became the filter value, which is the whole
    // point of `fromInput`: the template knows it needs a filter, and only
    // the installer knows what to filter on.
    expect(subs[0]!.filters).toEqual([{ field: "folder", op: "eq", value: "acme/platform" }]);
    // Suffixed like a schedule name, so two installs stay apart.
    expect(subs[0]!.name).toContain("On a note");
    expect(result.subscriptionIds).toHaveLength(1);
  });

  it("refuses the install when a filter's input has no value, naming the field", async () => {
    // Caught by the required-input gate, which now treats an event
    // template as unattended for the same reason a scheduled one is: the
    // dispatcher merges no `dataSchema` defaults, so a value missing at
    // install is missing forever. The filter-level check downstream is a
    // backstop for a template that names an input its schema never declared.
    const result = await installWorkflowTemplate(deps([eventPlugin]), OWNER, "notes-on-event");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    if (result.code !== "invalid_input") throw new Error(`expected invalid_input, got ${result.code}`);
    expect(result.errors.join("\n")).toContain("watched");
    // Nothing armed, and nothing written.
    expect(await db.select().from(eventSubscriptions)).toHaveLength(0);
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
  });

  it("refuses a template whose filter field the event keys do not declare", async () => {
    // A filter field the catalog does not declare arms a subscription that
    // matches nothing, forever, with nothing to read. Refusing loudly at
    // install is the only moment anybody finds out.
    const result = await installWorkflowTemplate(deps([badFilterPlugin]), OWNER, "notes-bad-filter", {
      inputs: { watched: "acme/platform" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("broken_template");
    expect(await db.select().from(eventSubscriptions)).toHaveLength(0);
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
  });

  it("reports an unknown template id", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "no-such-template");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("not_found");
  });

  it("refuses a template whose definition does not validate", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "broken");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    if (result.code !== "broken_template") throw new Error(`expected broken_template, got ${result.code}`);
    expect(result.errors.join(" ")).toContain("ghost");
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
  });

  it("writes nothing when a later write in the transaction fails", async () => {
    await connect("gmail");
    // Force the LAST of the three writes to fail. Without one transaction
    // the definition and its version would survive, and the gallery would
    // show an installed workflow that never runs.
    await pgdb.query("ALTER TABLE workflow_schedules ADD CONSTRAINT no_writes CHECK (false) NOT VALID");

    try {
      await expect(installWorkflowTemplate(deps(), OWNER, "gmail-sweep")).rejects.toThrow();

      expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
      expect(await db.select().from(workflowVersions)).toHaveLength(0);
      expect(await db.select().from(workflowSchedules)).toHaveLength(0);
    } finally {
      // Drop the constraint also when an assertion above fails. The tests in
      // this package share one database, so a constraint that stays makes
      // every later write to this table fail.
      await pgdb.query("ALTER TABLE workflow_schedules DROP CONSTRAINT no_writes");
    }
  });

  it("installs the same template twice as two independent workflows", async () => {
    await connect("gmail");
    const first = await installWorkflowTemplate(deps(), OWNER, "gmail-sweep");
    const second = await installWorkflowTemplate(deps(), OWNER, "gmail-sweep");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected both installs to succeed");

    expect(second.workflowId).not.toBe(first.workflowId);
    expect(first.workflowName).toBe("Inbox sweeper");
    expect(second.workflowName).toBe("Inbox sweeper (2)");

    const defs = await db.select().from(workflowDefinitions);
    expect(defs).toHaveLength(2);
    // The first install is untouched: same id, same name, same definition.
    const firstRow = defs.find((d) => d.id === first.workflowId);
    expect(firstRow?.name).toBe("Inbox sweeper");
    expect(firstRow?.definition).toEqual(sweepDefinition);

    const schedules = await db.select().from(workflowSchedules);
    expect(schedules).toHaveLength(2);
    expect(new Set(schedules.map((s) => s.id)).size).toBe(2);
    // Distinct names are the whole point of the suffix: two rows called
    // "Inbox sweeper" cannot be told apart in the schedules list.
    expect(new Set(schedules.map((s) => s.name)).size).toBe(2);
    expect(new Set(schedules.map((s) => s.workflowId))).toEqual(new Set([first.workflowId, second.workflowId]));
  });

  it("bakes a supplied input into the installed definition", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-echo", { inputs: { noteId: "n_42" } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const row = (await db.select().from(workflowDefinitions))[0]!;
    const stored: unknown = row.definition;
    expect(JSON.stringify(stored)).toContain('"id":"n_42"');
    expect(JSON.stringify(stored)).not.toContain("trigger.data.noteId");
  });

  it("rejects an input of the wrong type before it writes anything", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-echo", { inputs: { noteId: 7 } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    if (result.code !== "invalid_input") throw new Error(`expected invalid_input, got ${result.code}`);
    expect(result.errors.join(" ")).toContain("must be a string");
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
  });

  it("rejects an input the template does not take, and names the ones it does", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-echo", { inputs: { noteid: "n_42" } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    if (result.code !== "invalid_input") throw new Error(`expected invalid_input, got ${result.code}`);
    expect(result.errors[0]).toContain('"noteid" is not an input of this template');
    expect(result.errors[0]).toContain("noteId");
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
  });

  it("keeps an unsupplied input as a run-time field", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-echo");
    expect(result.ok).toBe(true);
    const row = (await db.select().from(workflowDefinitions))[0]!;
    expect(JSON.stringify(row.definition)).toContain("trigger.data.noteId");
  });

  it("refuses a scheduled install with no value for a required input, and names the field", async () => {
    // The same omission on a manual template is harmless — its run form
    // collects the value later. On a schedule there is no later: the cron
    // run gets no defaults and no form, so the reference would read null
    // every night with nothing to report it.
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-nightly");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    if (result.code !== "invalid_input") throw new Error(`expected invalid_input, got ${result.code}`);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Missing value for "noteId"');
    // Worded for both unattended kinds now — a cron schedule and an event
    // subscription have the same problem and the same fix.
    expect(result.errors[0]).toContain("an unattended run applies no input defaults");
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
    expect(await db.select().from(workflowSchedules)).toHaveLength(0);
  });

  it("bakes a scheduled template's own default without being asked for it", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-nightly", { inputs: { noteId: "n_9" } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const row = (await db.select().from(workflowDefinitions))[0]!;
    const stored = JSON.stringify(row.definition);
    // Both fields are literals now, and both are gone from the schema, so
    // the nightly run reads no input at all.
    expect(stored).toContain('"id":"n_9"');
    expect(stored).toContain('"depth":3');
    expect(stored).not.toContain("trigger.data");
    expect(await db.select().from(workflowSchedules)).toHaveLength(1);
  });
});

describe("installWorkflowTemplate ownership", () => {
  it("installs into a team the caller belongs to", async () => {
    await seedTeam("team-1", [OWNER.userId]);
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-echo", { teamId: "team-1" });
    expect(result.ok).toBe(true);

    const defs = await db.select().from(workflowDefinitions);
    expect(defs[0]!.ownerType).toBe("team");
    expect(defs[0]!.ownerId).toBe("team-1");
  });

  it("reports a team the caller does not belong to as not found, and writes nothing", async () => {
    await seedTeam("team-2", ["someone-else"]);
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-echo", { teamId: "team-2" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("team_not_found");
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
    expect(await db.select().from(workflowVersions)).toHaveLength(0);
  });

  it("treats an unknown team the same as one the caller cannot reach", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-echo", { teamId: "team-nope" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("team_not_found");
  });

  it("refuses a scheduled team template when the team has no credential, naming the service", async () => {
    // The caller's personal Gmail does not fund a team run. Readiness looks
    // at the team row, org-provided services, and App pins — not Integrations.
    await connect("gmail");
    await seedTeam("team-3", [OWNER.userId]);
    const result = await installWorkflowTemplate(deps(), OWNER, "gmail-sweep", { teamId: "team-3" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("not_connected");
    // The readiness reason is caller-neutral; the install path adds the
    // step that follows the fix here and nowhere else.
    expect(result.error).toBe("Connect gmail for this team, then install this template.");
    expect(await db.select().from(workflowSchedules)).toHaveLength(0);
  });

  it("reports a team the caller does not belong to before it reads that team's credentials", async () => {
    // The refusal a non-member sees must not change with the team's
    // connections, or it would tell them which services the team holds.
    await seedTeam("team-3c", ["someone-else"]);
    const result = await installWorkflowTemplate(deps(), OWNER, "gmail-sweep", { teamId: "team-3c" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("team_not_found");
  });

  it("sends a team install of an App-pinned template to the admin when no App is configured", async () => {
    // "Connect github for this team" names a control a member does not
    // have: no team connection satisfies an App pin. The readiness reason
    // already says who acts, and the team refusal must carry it.
    await seedTeam("team-3d", [OWNER.userId]);
    const result = await installWorkflowTemplate(deps([githubPlugin]), OWNER, "github-app-issues", {
      teamId: "team-3d",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("not_connected");
    expect(result.error).toContain("active installation");
    expect(result.error).toContain("Settings → Organization");
    expect(result.error).not.toContain("for this team");
  });

  it("sends a team install of an unconfigured service to the admin, as the personal path does", async () => {
    await seedTeam("team-3e", [OWNER.userId]);
    const result = await installWorkflowTemplate(deps([chatPlugin]), OWNER, "chat-note", { teamId: "team-3e" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("not_connected");
    expect(result.error).toContain("not configured for this organization");
    expect(result.error).toContain("Settings → Organization");
    expect(result.error).not.toContain("for this team");
  });

  it("installs a scheduled team template when the team credential is ready", async () => {
    await credentials.save({ type: "team", id: "team-3b" }, "gmail", {
      type: "oauth2",
      accessToken: "team-gmail",
    });
    await seedTeam("team-3b", [OWNER.userId]);
    const result = await installWorkflowTemplate(deps(), OWNER, "gmail-sweep", { teamId: "team-3b" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const defs = await db.select().from(workflowDefinitions);
    expect(defs[0]!.ownerType).toBe("team");
    expect(defs[0]!.ownerId).toBe("team-3b");
    expect(await db.select().from(workflowSchedules)).toHaveLength(1);
  });

  it("files a team install's event subscription with the team", async () => {
    await seedTeam("team-5", [OWNER.userId]);
    const result = await installWorkflowTemplate(deps([eventPlugin]), OWNER, "notes-on-event", {
      teamId: "team-5",
      inputs: { watched: "acme/platform" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    // The subscription follows the workflow it starts, so the team that
    // owns the workflow can find the automation that calls it.
    const subs = await db.select().from(eventSubscriptions);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.ownerType).toBe("team");
    expect(subs[0]!.ownerId).toBe("team-5");
    expect(subs[0]!.createdBy).toBe(OWNER.userId);
  });

  it("files a team install's schedule with the team", async () => {
    await seedTeam("team-6", [OWNER.userId]);
    const result = await installWorkflowTemplate(deps([schedulePlugin]), OWNER, "nightly-no-tools", {
      teamId: "team-6",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const schedules = await db.select().from(workflowSchedules);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]!.ownerType).toBe("team");
    expect(schedules[0]!.ownerId).toBe("team-6");
    expect(schedules[0]!.createdBy).toBe(OWNER.userId);
  });

  it("counts repeat installs per owner, not across owners", async () => {
    await seedTeam("team-4", [OWNER.userId]);
    await installWorkflowTemplate(deps(), OWNER, "notes-echo");
    const teamInstall = await installWorkflowTemplate(deps(), OWNER, "notes-echo", { teamId: "team-4" });
    expect(teamInstall.ok).toBe(true);
    if (!teamInstall.ok) throw new Error(teamInstall.error);
    expect(teamInstall.workflowName).toBe("Notes echo");

    const teamRows = await db
      .select()
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.ownerType, "team"), eq(workflowDefinitions.ownerId, "team-4")));
    expect(teamRows).toHaveLength(1);
  });
});

// ─── The shipped assign-reviewers install, end to end ────────────────────

/**
 * A real run failed with `unresolved template path "trigger.data.rosterOwner"`,
 * because an event run's `trigger.data` is the dispatcher's envelope
 * (`{ key, refs, payload, summary }`) and carries no install fields. Those
 * fields are supposed to be BAKED into the definition at install. These pin
 * both halves of that: a blank required field is refused, and a supplied one
 * is written in as a literal.
 */
describe("github.assign-reviewers — install bakes its roster location", () => {
  const ID = "github.assign-reviewers";

  function inputs(over: Record<string, string> = {}): Record<string, string> {
    return {
      repository: "tkhq/valet",
      codeownersPath: ".github/CODEOWNERS",
      rosterOwner: "tkhq",
      rosterRepository: "valet",
      rosterPath: ".github/reviewer-roster.csv",
      ...over,
    };
  }

  /** The credential gate runs BEFORE input resolution, so every service the
   * template needs must be connected or the refusal under test never
   * happens. `slack` is org-provided, so it is saved at org scope. */
  async function connectAll(): Promise<void> {
    await connect("github");
    await connect("google_calendar");
    await credentials.save({ type: "org", id: OWNER.orgId }, "slack", {
      type: "bot_token",
      accessToken: "xoxb-test",
    });
  }

  it("refuses the install when a required roster field is blank", async () => {
    await connectAll();
    const partial = inputs();
    delete partial.rosterOwner;
    const result = await installWorkflowTemplate(deps(bundledPlugins), OWNER, ID, { inputs: partial });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    if (result.code !== "invalid_input") throw new Error(`expected invalid_input, got ${result.code}`);
    expect(result.errors.join("\n")).toContain("rosterOwner");
  });

  it("bakes the supplied roster location into the node that reads it", async () => {
    await connectAll();
    const result = await installWorkflowTemplate(deps(bundledPlugins), OWNER, ID, { inputs: inputs() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const rows = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, result.workflowId));
    const definition = rows[0]!.definition as WorkflowDefinition;
    const roster = definition.nodes.find((n) => n.id === "roster");
    const params = roster && "params" in roster ? (roster.params as Record<string, unknown>) : {};
    // Literals, not template reads — an event run has nothing to resolve
    // `{{ trigger.data.rosterOwner }}` against.
    expect(params.owner).toBe("tkhq");
    expect(params.repo).toBe("valet");
    expect(JSON.stringify(definition)).not.toContain("trigger.data.rosterOwner");
    expect(JSON.stringify(definition)).not.toContain("trigger.data.rosterRepository");
  });
});


describe("team GitHub template repository prerequisites", () => {
  async function setup() {
    await seedTeam("review-team", [OWNER.userId]);
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    await credentials.save({ type: "org", id: OWNER.orgId }, "github_app", {
      type: "api_key", apiKey: privateKey, accessToken: "test-client", refreshToken: "test-webhook",
      metadata: { appId: "1", appSlug: "test", oauthClientId: "iv1", htmlUrl: "https://github.com/apps/test" },
    });
    await db.insert(githubInstallations).values({
      id: "review-app", orgId: OWNER.orgId, installationId: 1, accountLogin: "acme",
      accountType: "Organization", repositorySelection: "selected", suspended: false,
      createdAt: 1000, updatedAt: 1000,
    });
  }

  it.each([
    { status: 200, body: { id: 1, suspended_at: null }, ok: true },
    { status: 404, body: {}, ok: false },
    { status: 503, body: {}, ok: false },
    { status: 200, body: { id: 1, suspended_at: "2026-09-01" }, ok: false },
    { status: 200, body: {}, ok: false },
  ])("checks the exact App installation and leaves no rows on refusal: $status $body", async ({ status, body, ok }) => {
    await setup();
    let checks = 0;
    const dependencies = deps(bundledPlugins);
    dependencies.github = { fetchImpl: async (url, init) => {
      checks++;
      expect(String(url)).toBe("https://api.github.com/repos/acme/platform/installation");
      expect(new Headers(init?.headers).get("Authorization")).toMatch(/^Bearer ey/);
      return Response.json(body, { status });
    } };
    const list = await listWorkflowTemplateSummaries(dependencies, OWNER, { teamId: "review-team" });
    expect(list.find((entry) => entry.id === "github.pull-request-review")?.requires).toContainEqual({
      service: "github", connected: true, organizationProvided: true, repositoryCheckOnInstall: true,
    });
    expect(checks).toBe(0); // Gallery is a local readiness read, not a provider probe.
    const result = await installWorkflowTemplate(dependencies, OWNER, "github.pull-request-review", {
      teamId: "review-team", inputs: { repository: "acme/platform", mention: "@review" },
    });
    expect(result.ok).toBe(ok);
    expect(checks).toBe(1);
    expect(await db.select().from(workflowDefinitions)).toHaveLength(ok ? 1 : 0);
    expect(await db.select().from(eventSubscriptions)).toHaveLength(ok ? 1 : 0);
    expect(await db.select().from(workflowVersions)).toHaveLength(ok ? 1 : 0);
  });
});
