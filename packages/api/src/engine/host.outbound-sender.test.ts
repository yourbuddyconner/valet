import { createTeam } from "../services/teams.js";
import { seedWorkspaceAssistant } from "../test-helpers/assistant-fixture.js";
/**
 * Session-backed agent actions must resolve their sender identity when they
 * post through a Slack action. `Session.options` is the engine's public seam.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import slackPlugin from "@valet/plugin-slack/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";

import { actionPolicies, teams } from "../schema/index.js";

const USER = "local-user";
const ORG = "local-org";

let faux: FauxProviderRegistration | undefined;

async function senderFor(session: { options: { resolveOutboundSender?: () => Promise<{ displayName?: string; avatarUrl?: string } | undefined> } }) {
  const resolve = session.options.resolveOutboundSender;
  if (!resolve) throw new Error("session has no outbound sender resolver");
  return resolve();
}

async function allowSlackSend(api: TestApi): Promise<void> {
  const now = Date.now();
  await api.providers.db.insert(actionPolicies).values({
    id: "test:allow:slack.send_message",
    orgId: ORG,
    principalType: "org",
    principalId: ORG,
    service: null,
    actionId: "slack.send_message",
    riskLevel: null,
    mode: "allow",
    paramMatchers: [],
    appliesIn: "session",
    origin: "admin",
    managedBy: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await api.providers.engineCredentials.save(
    { type: "org", id: ORG },
    "slack",
    { type: "bot_token", accessToken: "xoxb-test-token" },
  );
}

function queueSlackSend(): void {
  if (!faux) throw new Error("faux model is not registered");
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(
          "call_tool",
          {
            tool_id: "slack.send_message",
            params: { channel: "C1", text: "from a workflow session" },
            summary: "Send the workflow result",
          },
          { id: "tc-slack-send" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("sent"),
  ]);
}

function mockSlackPost(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  fetchMock
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, channel: { id: "C1", is_private: false, is_im: false, is_mpim: false } })),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ts: "1.2", channel: "C1" })));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function postThroughSession(session: { prompt(content: string): Promise<unknown> }): Promise<Record<string, unknown>> {
  queueSlackSend();
  const fetchMock = mockSlackPost();
  await session.prompt("Send the workflow result.");
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
  expect(url).toBe("https://slack.com/api/chat.postMessage");
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("EngineHost outbound sender identity", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    faux?.unregister();
    faux = undefined;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await api?.cleanup();
    api = undefined;
  });

  it("uses the bot identity for a personal workflow session", async () => {
    api = await bootTestApi({ plugins: [] });
    const assistant = await seedWorkspaceAssistant(api.providers.db, ORG, { type: "user", id: USER });


    const session = await api.providers.engineHost.workflowSessionFor("wf:run1:node1", {
      actorUserId: USER,
      orgId: ORG,
      owner: { type: "user", id: USER },
      workspace: "/tmp",
    });

    expect(await senderFor(session)).toBeUndefined();
  });

  it("uses the current team name for a child-agent session", async () => {
    api = await bootTestApi({ plugins: [] });
    const team = await createTeam(api.providers.db, { orgId: ORG, name: "Release team", creatorUserId: USER });
    const assistant = await seedWorkspaceAssistant(api.providers.db, ORG, { type: "team", id: team.id });


    const session = await api.providers.engineHost.childSessionFor("child:release", {
      parentSessionId: assistant.sessionId,
      parentThreadId: "thread:parent",
      actorUserId: USER,
      orgId: ORG,
      owner: { type: "team", id: team.id },
      workspace: "/tmp",
    });


    await api.providers.db.update(teams).set({ name: "Release team renamed" }).where(eq(teams.id, team.id));
    expect(await senderFor(session)).toEqual({ displayName: "Release team renamed" });
  });

  it("posts a personal workflow action with org credentials and the bot identity", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    api = await bootTestApi({ plugins: [slackPlugin] });
    await allowSlackSend(api);
    const assistant = await seedWorkspaceAssistant(api.providers.db, ORG, { type: "user", id: USER });


    const session = await api.providers.engineHost.workflowSessionFor("wf:run1:node1", {
      actorUserId: USER,
      orgId: ORG,
      owner: { type: "user", id: USER },
      workspace: "/tmp",
    });

    await expect(postThroughSession(session)).resolves.toMatchObject({
      channel: "C1",
      text: "from a workflow session",
    });
  });

  it("uses Slack's bot identity when the workflow session has no assistant", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    api = await bootTestApi({ plugins: [slackPlugin] });
    await allowSlackSend(api);

    const session = await api.providers.engineHost.workflowSessionFor("wf:run1:node1", {
      actorUserId: USER,
      orgId: ORG,
      owner: { type: "user", id: USER },
      workspace: "/tmp",
    });

    const body = await postThroughSession(session);
    expect(body).toMatchObject({ channel: "C1", text: "from a workflow session" });
    expect(body.username).toBeUndefined();
    expect(body.icon_url).toBeUndefined();
  });
});
