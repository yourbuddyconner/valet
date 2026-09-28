import { seedWorkspaceAssistant } from "../test-helpers/assistant-fixture.js";
/**
 * The session-delivery seam for stored skills: a row in the `skills` table
 * must reach a real session's `skills` list and the `skill` tool's body
 * lookup, on every one of `EngineHost`'s four session builders.
 *
 * `session.options` is the engine's public seam for a built session, so
 * these assertions read it directly instead of casting private state.
 */
import { describe, it, expect, afterEach } from "vitest";
import githubPlugin from "@valet/plugin-github/plugin";
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  Sandbox,
  SessionEntry,
  ToolContext,
  ToolDef,
} from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { createSkill } from "../services/skills.js";
import { createTeam } from "../services/teams.js";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";

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

function findSkillTool(tools: ToolDef[] | undefined): ToolDef {
  const tool = tools?.find((t) => t.name === "skill");
  if (!tool) throw new Error(`no "skill" tool on the session: ${tools?.map((t) => t.name).join(", ")}`);
  return tool;
}

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("stored skills on a session", () => {
  it("delivers a personal skill to an interactive session", async () => {
    api = await bootTestApi({ plugins: [] });
    await createSkill(api.providers.db, { userId: USER, orgId: ORG }, {
      name: "deploy",
      description: "How to deploy the service.",
      content: "# Deploy\n\nRun `make deploy`.\n",
    });

    const session = await api.providers.engineHost.sessionFor("stored-skill-interactive", {
      userId: USER,
      orgId: ORG,
      workspace: "/tmp",
    });

    expect(session.options.skills?.map((s) => s.name)).toEqual(["deploy"]);

    const tool = findSkillTool(session.options.tools);
    const result = await tool.execute({ name: "deploy" }, makeCtx());
    expect(result.text).toContain("Run `make deploy`.");
  });

  it("builds the session anyway when a stored skill collides with a plugin skill", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    await createSkill(api.providers.db, { userId: USER, orgId: ORG }, {
      name: "github",
      description: "My own GitHub notes.",
      content: "# Mine\n\nNever reaches the model.\n",
    });

    const session = await api.providers.engineHost.sessionFor("stored-skill-collision", {
      userId: USER,
      orgId: ORG,
      workspace: "/tmp",
    });

    // One `github` skill, and it is the plugin's.
    const named = (session.options.skills ?? []).filter((s) => s.name === "github");
    expect(named).toHaveLength(1);

    const tool = findSkillTool(session.options.tools);
    const result = await tool.execute({ name: "github" }, makeCtx());
    expect(result.text).toContain("# GitHub Integration Tools");
    expect(result.text).not.toContain("Never reaches the model.");
  });

  it("delivers a personal skill to an orchestrator session", async () => {
    api = await bootTestApi({ plugins: [] });
    await createSkill(api.providers.db, { userId: USER, orgId: ORG }, {
      name: "deploy",
      description: "How to deploy the service.",
      content: "# Deploy\n",
    });

    const session = await defaultAssistantSessionFor(api.providers, 
      { type: "user", id: USER },
      { actorUserId: USER, orgId: ORG },
    );

    expect(session.options.skills?.map((s) => s.name)).toContain("deploy");
  });

  it("gives a team assistant team and org skills, but not the actor's skill", async () => {
    api = await bootTestApi({ plugins: [] });
    const db = api.providers.db;
    const team = await createTeam(db, { orgId: ORG, name: "Reviewers", creatorUserId: USER });
    await createSkill(db, { userId: USER, orgId: ORG }, {
      name: "personal-review-notes",
      description: "Only mine.",
      content: "# Personal\n",
    });
    await createSkill(db, { userId: USER, orgId: ORG }, {
      name: "team-review-notes",
      description: "The team's notes.",
      content: "# Team\n",
      teamId: team.id,
    });
    await createSkill(db, { userId: USER, orgId: ORG }, {
      ownerType: "org",
      isOrgAdmin: true,
      origin: "repo",
      name: "adversarial-code-review",
      description: "Attack a change and try to prove it wrong.",
      content: "# Adversarial code review\n\nReview the pull request.\n",
    });

    const session = await defaultAssistantSessionFor(
      api.providers,
      { type: "team", id: team.id },
      { actorUserId: USER, orgId: ORG },
    );

    expect(session.options.skills?.map((skill) => skill.name)).toEqual([
      "team-review-notes",
      "adversarial-code-review",
    ]);
    const tool = findSkillTool(session.options.tools);
    const result = await tool.execute({ name: "adversarial-code-review" }, makeCtx());
    expect(result.text).toContain("Review the pull request.");
    expect(result.text).not.toContain("skill_not_found");
  });

  it("keeps an org skill out of a team assistant allowlist that denies it", async () => {
    api = await bootTestApi({ plugins: [] });
    const db = api.providers.db;
    const team = await createTeam(db, { orgId: ORG, name: "Reviewers", creatorUserId: USER });
    await createSkill(db, { userId: USER, orgId: ORG }, {
      ownerType: "org",
      isOrgAdmin: true,
      origin: "repo",
      name: "adversarial-code-review",
      description: "Attack a change and try to prove it wrong.",
      content: "# Adversarial code review\n",
    });
    const assistant = await seedWorkspaceAssistant(db, ORG, { type: "team", id: team.id }, "Restricted", {
      behavior: { skills: { mode: "allowlist", names: ["team-review-notes"] } },
    });

    const { session } = await ensureDefaultAssistantSession(
      { db, engineHost: api.providers.engineHost },
      { type: assistant.ownerType, id: assistant.ownerId },
      { actorUserId: USER, orgId: ORG },
    );

    expect(session.options.skills?.some((skill) => skill.name === "adversarial-code-review") ?? false).toBe(false);
    expect(session.options.tools?.some((tool) => tool.name === "skill") ?? false).toBe(false);
  });

  it("gives a team-owned child session the team's skills, not the actor's", async () => {
    api = await bootTestApi({ plugins: [] });
    const db = api.providers.db;
    const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: USER });
    await createSkill(db, { userId: USER, orgId: ORG }, {
      name: "personal",
      description: "Only mine.",
      content: "# Personal\n",
    });
    await createSkill(db, { userId: USER, orgId: ORG }, {
      name: "shared",
      description: "The team's.",
      content: "# Shared\n",
      teamId: team.id,
    });

    const parent = await api.providers.engineHost.sessionFor("stored-skill-parent", {
      userId: USER,
      orgId: ORG,
      workspace: "/tmp",
    });
    const child = await api.providers.engineHost.childSessionFor("stored-skill-child", {
      parentSessionId: parent.id,
      parentThreadId: "t1",
      actorUserId: USER,
      orgId: ORG,
      owner: { type: "team", id: team.id },
      workspace: "/tmp",
    });

    expect(child.options.skills?.map((s) => s.name)).toEqual(["shared"]);
  });

  it("gives a team-owned workflow session team and org skills only", async () => {
    api = await bootTestApi({ plugins: [] });
    const db = api.providers.db;
    const team = await createTeam(db, { orgId: ORG, name: "Reviewers", creatorUserId: USER });
    await createSkill(db, { userId: USER, orgId: ORG }, {
      name: "personal-review",
      description: "Personal.",
      content: "# Personal\n",
    });
    await createSkill(db, { userId: USER, orgId: ORG }, {
      name: "team-review",
      description: "Current team.",
      content: "# Team\n",
      teamId: team.id,
    });
    await createSkill(db, { userId: USER, orgId: ORG }, {
      ownerType: "org",
      isOrgAdmin: true,
      origin: "repo",
      name: "adversarial-code-review",
      description: "Attack a change and try to prove it wrong.",
      content: "# Adversarial code review\n\nReview the pull request.\n",
    });

    const session = await api.providers.engineHost.workflowSessionFor("wf:team-run:review", {
      actorUserId: USER,
      orgId: ORG,
      owner: { type: "team", id: team.id },
      workspace: "/tmp",
    });

    expect(session.options.skills?.map((skill) => skill.name)).toEqual([
      "team-review",
      "adversarial-code-review",
    ]);
    const result = await findSkillTool(session.options.tools).execute(
      { name: "adversarial-code-review" },
      makeCtx(),
    );
    expect(result.text).toContain("Review the pull request.");
  });

  it("delivers a personal skill to a workflow session", async () => {
    api = await bootTestApi({ plugins: [] });
    await createSkill(api.providers.db, { userId: USER, orgId: ORG }, {
      name: "deploy",
      description: "How to deploy the service.",
      content: "# Deploy\n",
    });

    const session = await api.providers.engineHost.workflowSessionFor("wf:run1:node1", {
      actorUserId: USER,
      orgId: ORG,
      owner: { type: "user", id: USER },
      workspace: "/tmp",
    });

    expect(session.options.skills?.map((s) => s.name)).toEqual(["deploy"]);
  });
});
