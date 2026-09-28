import { seedWorkspaceAssistant } from "../test-helpers/assistant-fixture.js";
/**
 * Per-assistant behavior threads all the way to a built session
 * (`docs/specs/2026-08-18-assistant-editor-design.md`).
 *
 * `buildAssistantSession` reads the row's `behavior` and `personality` and
 * applies them: the integration allowlist shapes the tool list, the skills
 * allowlist shapes both plugin skills and the `skillsProvider` re-read, and
 * the row personality wins over the memory-file fallback in the persona
 * prefix. These tests hold that seam end to end, from an `assistants` row to
 * `session.options`, the engine's public seam for a built session.
 *
 * Two fixture services with distinct action ids let one behavior admit one
 * service and drop the other; a fixture plugin skill plus a stored skill let
 * the allowlist keep one of each and drop the rest.
 */
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
import type { AssistantBehavior } from "../wire/types.js";

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

/** Two routing services, each with two actions, plus two plugin skills. The
 * behavior below admits `github` (minus one action) and drops `slack`. */
const fixturePlugin: ValetPlugin = {
  name: "behavior-fixture",
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

describe("assistant behavior on a built session", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("shapes the tool list and skillsProvider from the row's behavior", async () => {
    api = await bootTestApi({ plugins: [fixturePlugin] });
    const { db, engineHost } = api.providers;

    // A stored skill on the allowlist and one off it, to prove the
    // skillsProvider re-read (not just the plugin-skill half) is filtered.
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

    const behavior: AssistantBehavior = {
      skills: { mode: "allowlist", names: ["gh-triage"] },
      integrations: {
        mode: "allowlist",
        entries: [{ service: "github", excludeActions: ["github.delete_repo"] }],
      },
    };
    const row = await seedWorkspaceAssistant(db, ORG, { type: "user", id: USER }, "Triage", {
      behavior,
    });
    const { session } = await ensureDefaultAssistantSession({ db, engineHost }, { type: row.ownerType, id: row.ownerId }, {
      actorUserId: USER,
      orgId: ORG,
    });

    const listed = await listToolIds(session.options.tools);
    // The allowlisted service keeps its non-excluded action.
    expect(listed).toContain("github.create_issue");
    // The excluded action id is gone.
    expect(listed).not.toContain("github.delete_repo");
    // The non-allowlisted service's action is gone.
    expect(listed).not.toContain("slack.post_message");
    expect(listed).toContain("excluded_by_assistant");

    // The skillsProvider re-read returns only allowlisted skills, across both
    // the plugin skill and the stored skill.
    const provider = session.options.skillsProvider;
    expect(provider).toBeDefined();
    const provided = await provider!();
    const providedNames = provided.map((s) => s.name).sort();
    expect(providedNames).toEqual(["gh-triage"]);
  });

  it("never gates pinned workflow actions: an allowlist without 'workflows' keeps the pins", async () => {
    // The workflow editor panel depends on the pinned
    // workflows.get_workflow/patch_workflow pair (plugins/pinned-actions.ts);
    // the spec lists pins under "Never gated". A user who allowlists their
    // default assistant to github-only must not lose workflow saves.
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

    const row = await seedWorkspaceAssistant(db, ORG, { type: "user", id: USER }, "Gated", {
      behavior: {
        integrations: { mode: "allowlist", entries: [{ service: "github" }] },
      },
    });
    const { session } = await ensureDefaultAssistantSession({ db, engineHost }, { type: row.ownerType, id: row.ownerId }, {
      actorUserId: USER,
      orgId: ORG,
    });

    // The pins survive as direct tools (`service__action`)...
    const toolNames = (session.options.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("workflows__get_workflow");
    expect(toolNames).toContain("workflows__patch_workflow");
    // ...while the rest of the non-allowlisted service stays gated.
    const listed = await listToolIds(session.options.tools);
    expect(listed).not.toContain("workflows.save_workflow");
    expect(listed).not.toContain("slack.post_message");
    expect(listed).toContain("github.create_issue");
  });

  it("prefixes the persona with the row personality, not the memory file", async () => {
    api = await bootTestApi({ plugins: [] });
    const { db, engineHost } = api.providers;

    const row = await seedWorkspaceAssistant(db, ORG, { type: "user", id: USER }, "Nova", {
      personality: "You are terse and cite sources.",
    });
    const { session } = await ensureDefaultAssistantSession({ db, engineHost }, { type: row.ownerType, id: row.ownerId }, {
      actorUserId: USER,
      orgId: ORG,
    });

    expect(session.options.systemPrompt).toContain(
      "You are Nova. You are terse and cite sources.",
    );
  });
});
