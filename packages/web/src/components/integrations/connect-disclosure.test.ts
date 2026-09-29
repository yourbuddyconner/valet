/**
 * `connect-disclosure`: what the pre-connect screen is allowed to claim.
 *
 * The rule under test is that copy comes from manifest metadata and stops
 * where the metadata stops. A connect screen that fills a gap with friendly
 * filler makes a privacy promise the product does not keep, so the "cannot
 * say" arm is asserted as carefully as the populated one.
 *
 * The fixtures mirror real shapes in the fleet: gmail (13 tools, 4 gated),
 * slack (11 tools, none gated), linear (tools resolve after connecting) and
 * a skewed plugin (declares a credential key its own tools never read).
 */
import { describe, expect, it } from "vitest";
import type { PluginActionSummary, PluginServiceSummary } from "@valet/api/wire";
import { capabilityLines, reachLines, summaryLines, toolDisclosure } from "./connect-disclosure";

function action(name: string, requiresApproval = false): PluginActionSummary {
  return {
    id: `svc.${name}`,
    name,
    riskLevel: requiresApproval ? "high" : "low",
    requiresApproval,
  };
}

function service(overrides: Partial<PluginServiceSummary> = {}): PluginServiceSummary {
  return {
    service: "gmail",
    type: "oauth2",
    configKeys: ["accessToken"],
    connected: false,
    connect: "oauth",
    actions: [],
    ...overrides,
  };
}

describe("toolDisclosure", () => {
  it("splits declared actions into the ones the gate stops and the ones it does not", () => {
    const result = toolDisclosure(
      service({ actions: [action("Read Message"), action("Send Email", true)] }),
    );

    expect(result.kind).toBe("known");
    if (result.kind !== "known") return;
    expect(result.total).toBe(2);
    expect(result.asking.map((a) => a.name)).toEqual(["Send Email"]);
    expect(result.running.map((a) => a.name)).toEqual(["Read Message"]);
  });

  it("reports that a dynamic service resolves its tools only after connecting", () => {
    expect(toolDisclosure(service({ service: "linear", dynamic: true })).kind).toBe("on-connect");
  });

  it("refuses to describe a service that declares no actions and resolves none", () => {
    // The skewed shape: the credential key it writes is not the key its
    // actions read, so the wire reports no actions for it.
    expect(toolDisclosure(service({ service: "skewed" })).kind).toBe("unknown");
  });
});

describe("summaryLines", () => {
  it("counts the tools and how many stop to ask", () => {
    const lines = summaryLines(
      toolDisclosure(service({ actions: [action("a"), action("b"), action("c", true)] })),
      "Gmail",
    );
    expect(lines[0]).toBe("Valet gives your assistant 3 Gmail tools.");
    expect(lines[1]).toBe("1 of them stops and asks you before it runs.");
  });

  it("says plainly when nothing stops to ask", () => {
    // Slack's real shape — every action is low risk, so the gate never opens.
    const lines = summaryLines(toolDisclosure(service({ actions: [action("Read History")] })), "Slack");
    expect(lines[1]).toBe("None of them stop to ask you before they run.");
  });

  it("names the gap instead of guessing when the metadata supports no claim", () => {
    const lines = summaryLines(toolDisclosure(service({ service: "skewed" })), "Skewed");
    expect(lines[0]).toBe("Valet cannot confirm which tools this connection unlocks.");
    // The repo rule: a user-facing problem names the corrective action.
    expect(lines.some((l) => l.includes("until a maintainer corrects that name"))).toBe(true);
    // And it must never print a tool count it does not have.
    expect(lines.join(" ")).not.toMatch(/\d+ tools?/);
  });

  it("tells a dynamic service's reader that no list exists yet", () => {
    const lines = summaryLines(toolDisclosure(service({ dynamic: true })), "Linear");
    expect(lines.join(" ")).toContain("after you connect");
    expect(lines.join(" ")).not.toMatch(/\d+ tools?/);
  });
});

describe("capabilityLines", () => {
  it("names every tool the gate stops", () => {
    const lines = capabilityLines(
      toolDisclosure(
        service({ actions: [action("Read"), action("Send Email", true), action("Trash Message", true)] }),
      ),
      "Gmail",
    );
    expect(lines[0]).toBe("These tools stop and ask you first: Send Email and Trash Message.");
    expect(lines[1]).toBe("The other 1 tool runs without asking you.");
  });

  it("says outright when every tool runs unattended, and names some of them", () => {
    // The count alone would hide that reading history and sending DMs never
    // pause, so the copy has to state it.
    const lines = capabilityLines(
      toolDisclosure(
        service({ actions: [action("Read History"), action("Read Thread"), action("DM User")] }),
      ),
      "Slack",
    );
    expect(lines[0]).toBe("Every one of these 3 tools runs without asking you.");
    expect(lines[1]).toBe("That includes Read History, Read Thread and DM User.");
  });

  it("claims nothing when the metadata supports nothing", () => {
    const lines = capabilityLines(toolDisclosure(service({ service: "skewed" })), "Skewed");
    expect(lines).toEqual(["Valet cannot list what this connection lets your assistant do."]);
  });
});

describe("reachLines", () => {
  it("says the connection is the user's alone when they are in no team", () => {
    const lines = reachLines([], "Gmail");
    expect(lines).toEqual([
      "Valet saves this connection for your account.",
      "Only runtimes that you start can use it.",
    ]);
  });

  it("names the team exposure, the team and its size", () => {
    const lines = reachLines([{ name: "Platform", memberCount: 6 }], "Gmail");
    const text = lines.join(" ");
    expect(text).toContain("You are in Platform (6 people).");
    expect(text).toContain("runs on the connection of the member who starts it");
    expect(text).toContain("read its replies");
  });

  it("differs from the personal case rather than softening it", () => {
    const personal = reachLines([], "Gmail").join(" ");
    const team = reachLines([{ name: "Platform", memberCount: 6 }], "Gmail").join(" ");
    expect(team).not.toBe(personal);
    expect(personal).toContain("Only runtimes that you start can use it.");
    expect(team).not.toContain("Only runtimes that you start can use it.");
  });

  it("names every team the user belongs to", () => {
    const text = reachLines(
      [
        { name: "Platform", memberCount: 6 },
        { name: "Design", memberCount: 2 },
      ],
      "Gmail",
    ).join(" ");
    expect(text).toContain("Platform (6 people)");
    expect(text).toContain("Design (2 people)");
  });

  it("counts a single-member team in the singular", () => {
    expect(reachLines([{ name: "Solo", memberCount: 1 }], "Gmail").join(" ")).toContain(
      "Solo (1 person)",
    );
  });
});

// GitHub's org-wide reach moved to `github-org-app.test.ts` when the fixed
// sentence became a claim derived from the organisation's real App state.
