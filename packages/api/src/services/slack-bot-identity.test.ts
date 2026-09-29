import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSlackBotIdentity } from "./slack-bot-identity.js";


const input = { orgId: "org-1", accessToken: "xoxb-old", teamId: "T1", botUserId: "U1" };
const identity = { teamId: "T1", botId: "B1", botUserId: "U1", grantedScopes: null };
function slackResponse(changed: Partial<typeof identity> = {}): Response {
  const value = { ...identity, ...changed };
  return Response.json({ ok: true, team_id: value.teamId, bot_id: value.botId, user_id: value.botUserId });
}
beforeEach(() => { vi.spyOn(globalThis, "fetch").mockImplementation(async () => slackResponse()); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("legacy Slack bot identity", () => {
  it("shares an in-flight lookup and caches the verified identity", async () => {
    const owner = {};
    expect(await Promise.all([
      resolveSlackBotIdentity(owner, input), resolveSlackBotIdentity(owner, input),
    ])).toEqual([identity, identity]);
    expect(await resolveSlackBotIdentity(owner, input)).toEqual(identity);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { teamId: "T_OTHER", botUserId: "U1" },
    { teamId: "T1", botUserId: "U_OTHER" },
  ])("rejects an identity inconsistent with the stored installation: %j", async (changed) => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => slackResponse(changed));
    expect(await resolveSlackBotIdentity({}, input)).toBeUndefined();
  });

  it("resolves credentials missing both bot identity fields", async () => {
    expect(await resolveSlackBotIdentity({}, { ...input, botUserId: undefined })).toEqual(identity);
  });

  it("isolates applications and invalidates cached identity when the credential changes", async () => {
    const owner = {};
    await resolveSlackBotIdentity(owner, input);
    await resolveSlackBotIdentity({}, input);
    await resolveSlackBotIdentity(owner, { ...input, accessToken: "xoxb-new" });
    await resolveSlackBotIdentity(owner, { ...input, orgId: "org-2" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });

  it("backs off failed lookups, then retries without reconnecting", async () => {
    vi.useFakeTimers();
    const owner = {};
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(Response.json({ ok: false, error: "unavailable" }));
    expect(await resolveSlackBotIdentity(owner, input)).toBeUndefined();
    expect(await resolveSlackBotIdentity(owner, input)).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_001);
    expect(await resolveSlackBotIdentity(owner, input)).toEqual(identity);
    vi.advanceTimersByTime(10 * 60_000 + 1);
    expect(await resolveSlackBotIdentity(owner, input)).toEqual(identity);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("does not cache a rejected lookup forever", async () => {
    vi.useFakeTimers();
    const owner = {};
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("network failure"));
    expect(await resolveSlackBotIdentity(owner, input)).toBeUndefined();
    vi.advanceTimersByTime(60_001);
    expect(await resolveSlackBotIdentity(owner, input)).toEqual(identity);
  });
});
