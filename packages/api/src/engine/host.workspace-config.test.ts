import { setPluginEntitlement } from "../services/plugin-entitlements.js";
import { seedWorkspaceAssistant } from "../test-helpers/assistant-fixture.js";
/** Workspace capabilities and persona use owner configuration. */
import { describe, it, expect, afterEach } from "vitest";
import { Type } from "typebox";
import type {
  ActionPlugin,
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  PluginAction,
  Sandbox,
  SessionEntry,
  ToolContext,
  ToolDef,
  ValetPlugin,
} from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import { createSkill } from "../services/skills.js";
import { writeFile } from "../services/memory.js";

const USER = "local-user";
const ORG = "local-org";

const stubCredentials: CredentialProvider = {
  get: async (): Promise<Credential | null> => null,
  request: async (): Promise<Credential> => {
    throw new Error("not implemented in test stub");
  },
};

function makeCtx(): ToolContext {
  const sandbox: Partial<Sandbox> & { id: string } = { id: "sb-1" };
  return {
    userId: USER,
    orgId: ORG,
    sessionId: "s1",
    threadId: "t1",
    credentials: stubCredentials,
    sandbox: sandbox as Sandbox,
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error("not implemented in test stub");
    },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
  };
}

/** The `list_tools` catalog tool reports the action ids one session can
 * reach. Behavior filtering runs before the catalog is built, so its text is
 * the seam that proves which actions survived. */
async function listToolIds(tools: ToolDef[] | undefined): Promise<string> {
  const tool = tools?.find((t) => t.name === "list_tools");
  if (!tool) throw new Error("no list_tools tool on the session");
  const result = await tool.execute({}, makeCtx());
  return result.text ?? "";
}

function makeAction(id: string): PluginAction {
  return {
    id,
    name: id,
    description: id,
    riskLevel: "low",
    parameters: Type.Object({}),
    execute: async () => ({ success: true }),
  };
}

/** Two services and plugin skills exercise the workspace capability catalog. */
const fixturePlugin: ValetPlugin = {
  name: "workspace-fixture",
  version: "0.0.1",
  actions: [
    {
      service: "github",
      actions: [makeAction("github.create_issue"), makeAction("github.delete_repo")],
    } satisfies ActionPlugin,
    {
      service: "slack",
      actions: [makeAction("slack.post_message")],
    } satisfies ActionPlugin,
  ],
  skills: [
    { name: "gh-triage", content: "triage content" },
    { name: "slack-notes", content: "slack content" },
  ],
};

describe("workspace runtime configuration", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("exposes all owner-accessible actions and skills without a profile filter", async () => {
    api = await bootTestApi({ plugins: [fixturePlugin] });
    const { db, engineHost } = api.providers;

    await createSkill(db, { userId: USER, orgId: ORG }, {
      name: "gh-triage",
      description: "How to triage.",
      content: "# Triage\n",
    });
    await createSkill(db, { userId: USER, orgId: ORG }, {
      name: "deploy",
      description: "How to deploy.",
      content: "# Deploy\n",
    });

    const row = await seedWorkspaceAssistant(db, ORG, { type: "user", id: USER });
    const { session } = await ensureDefaultAssistantSession({ db, engineHost }, { type: row.ownerType, id: row.ownerId }, {
      actorUserId: USER,
      orgId: ORG,
    });

    const listed = await listToolIds(session.options.tools);
    expect(listed).toContain("github.create_issue");
    expect(listed).toContain("github.delete_repo");
    expect(listed).toContain("slack.post_message");
    expect(listed).not.toContain("excluded_by_assistant");

    const provider = session.options.skillsProvider;
    expect(provider).toBeDefined();
    const provided = await provider!();
    const providedNames = provided.map((s) => s.name).sort();
    expect(providedNames).toEqual(["deploy", "gh-triage", "slack-notes"]);
  });

  it("keeps workflow pins and ordinary owner-accessible actions", async () => {
    // The workflow editor panel depends on the pinned
    // workflows.get_workflow/patch_workflow pair (plugins/pinned-actions.ts);
    const workflowsPlugin: ValetPlugin = {
      name: "workflows-fixture",
      version: "0.0.1",
      actions: [
        {
          service: "workflows",
          actions: [
            makeAction("workflows.get_workflow"),
            makeAction("workflows.patch_workflow"),
            makeAction("workflows.save_workflow"),
          ],
        } satisfies ActionPlugin,
      ],
    };
    api = await bootTestApi({ plugins: [fixturePlugin, workflowsPlugin] });
    const { db, engineHost } = api.providers;

    const row = await seedWorkspaceAssistant(db, ORG, { type: "user", id: USER });
    const { session } = await ensureDefaultAssistantSession({ db, engineHost }, { type: row.ownerType, id: row.ownerId }, {
      actorUserId: USER,
      orgId: ORG,
    });

    // The pins survive as direct tools (`service__action`)...
    const toolNames = (session.options.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("workflows__get_workflow");
    expect(toolNames).toContain("workflows__patch_workflow");
    const listed = await listToolIds(session.options.tools);
    expect(listed).toContain("workflows.save_workflow");
    expect(listed).toContain("slack.post_message");
    expect(listed).toContain("github.create_issue");
  });

  it("reads persona directly from owner memory without a profile name", async () => {
    api = await bootTestApi({ plugins: [] });
    const { db, engineHost } = api.providers;

    await writeFile(db, { owner: { type: "user", id: USER }, actorUserId: USER }, { path: "assistant/personality.md", content: "You are terse and cite sources." });
    const row = await seedWorkspaceAssistant(db, ORG, { type: "user", id: USER });
    const { session } = await ensureDefaultAssistantSession({ db, engineHost }, { type: row.ownerType, id: row.ownerId }, {
      actorUserId: USER,
      orgId: ORG,
    });

    expect(session.options.systemPrompt).toContain(
      "You are terse and cite sources.",
    );
  });
  it("keeps organization plugin restrictions after profile filters are removed", async () => {
    api = await bootTestApi({ plugins: [{ ...fixturePlugin, gate: { label: "Fixture", description: "Test access" } }] });
    const { db, engineHost } = api.providers;
    await setPluginEntitlement(db, ORG, fixturePlugin.name, { mode: "off", teamIds: [] });
    const { session } = await ensureDefaultAssistantSession({ db, engineHost }, { type: "user", id: USER }, { actorUserId: USER, orgId: ORG });
    const listed = await listToolIds(session.options.tools);
    expect(listed).toContain("disabled_by_org");
    expect(listed).not.toContain("github.create_issue");
    expect(await session.options.skillsProvider?.()).toEqual([]);
  });

});
