/**
 * What the connect screen is allowed to say about a service, derived from
 * the service's own manifest metadata and nothing else.
 *
 * This module exists to keep one rule enforceable: the screen tells a user
 * what they are about to hand over, BEFORE they hand it over, and every
 * sentence traces to a fact the server sent. A connect screen that reassures
 * a reader with an invented list is worse than no screen — it reads as a
 * privacy promise while promising nothing. So the derivation below has an
 * explicit "cannot say" arm, and callers must render it rather than fall
 * back to friendly filler.
 *
 * The three arms map to three real conditions in the fleet:
 *
 *   `known`     — the credential declaration and the plugin's ActionPlugin
 *                 agree on a key, so `PluginServiceSummary.actions` lists
 *                 exactly the tools this token unlocks (gmail, github, slack).
 *   `on-connect`— the plugin resolves its actions from an upstream MCP
 *                 server, so no list exists until a credential is connected
 *                 (linear, notion).
 *   `unknown`   — the plugin declares actions, but none read the key this
 *                 credential writes, so connecting unlocks nothing the
 *                 client can name. This is always a plugin bug: a credential
 *                 decl missing `service`, so the store key falls back to the
 *                 plugin name while actions read their own service id. The
 *                 api's credential-service-alignment suite fails on it; this
 *                 arm is the honest client-side rendering if one ships anyway.
 */
import type { PluginActionSummary, PluginServiceSummary } from "@valet/api/wire";

export type ToolDisclosure =
  | {
      kind: "known";
      total: number;
      /** Actions the approval gate stops before they run. */
      asking: PluginActionSummary[];
      /** Actions that run without stopping. */
      running: PluginActionSummary[];
      /** The plugin ALSO resolves actions upstream, so more may appear. */
      mayLoadMore: boolean;
    }
  | { kind: "on-connect" }
  | { kind: "unknown" };

export function toolDisclosure(service: PluginServiceSummary): ToolDisclosure {
  const actions = service.actions;
  if (actions.length > 0) {
    return {
      kind: "known",
      total: actions.length,
      asking: actions.filter((a) => a.requiresApproval),
      running: actions.filter((a) => !a.requiresApproval),
      mayLoadMore: service.dynamic === true,
    };
  }
  return service.dynamic === true ? { kind: "on-connect" } : { kind: "unknown" };
}

/** Joins names as prose: "a", "a and b", "a, b and c". */
function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * The paragraph under the title: what Valet will do, in future tense.
 * Returns one sentence per array entry so the caller can space them.
 */
export function summaryLines(disclosure: ToolDisclosure, title: string): string[] {
  if (disclosure.kind === "on-connect") {
    return [
      `Valet reads the ${title} tool list after you connect.`,
      `Until then Valet cannot name the tools your assistant gets.`,
    ];
  }
  if (disclosure.kind === "unknown") {
    return [
      `Valet cannot confirm which tools this connection unlocks.`,
      `The ${title} plugin saves this token under a name its own tools do not read.`,
      `Do not connect ${title} here until a maintainer corrects that name.`,
    ];
  }
  const { total, asking, mayLoadMore } = disclosure;
  const lines = [
    `Valet gives your assistant ${total} ${title} ${plural(total, "tool", "tools")}.`,
    asking.length === 0
      ? `None of them stop to ask you before they run.`
      : asking.length === 1
        ? `1 of them stops and asks you before it runs.`
        : `${asking.length} of them stop and ask you before they run.`,
    `Your assistant uses these tools only in a thread or a workflow you start.`,
  ];
  if (mayLoadMore) {
    lines.push(`${title} may add more tools after you connect.`);
  }
  return lines;
}

/**
 * Card one: what the assistant can do. Names the actions the gate stops, so
 * a reader can check the claim against the tool list beside it.
 */
export function capabilityLines(disclosure: ToolDisclosure, title: string): string[] {
  if (disclosure.kind === "on-connect") {
    return [`Valet lists the ${title} tools, and which of them ask you first, after you connect.`];
  }
  if (disclosure.kind === "unknown") {
    return [`Valet cannot list what this connection lets your assistant do.`];
  }
  const { asking, running } = disclosure;
  if (asking.length === 0) {
    // The slack shape. Every action is low risk, so the approval gate never
    // opens — including for tools that read history or send messages. A tool
    // count alone would hide that, so name what runs unattended.
    const sample = running.slice(0, 3).map((a) => a.name);
    return [
      `Every one of these ${running.length} tools runs without asking you.`,
      `That includes ${list(sample)}.`,
    ];
  }
  const named = list(asking.map((a) => a.name));
  const lines = [
    asking.length === 1
      ? `This tool stops and asks you first: ${named}.`
      : `These tools stop and ask you first: ${named}.`,
  ];
  if (running.length > 0) {
    lines.push(
      `The other ${running.length} ${plural(running.length, "tool runs", "tools run")} without asking you.`,
    );
  }
  return lines;
}

/** A team the signed-in user actually belongs to. */
export interface ReachableTeam {
  name: string;
  memberCount: number;
}

/**
 * Card two: who can reach the connection.
 *
 * The exposure this names is real and is the reason the screen exists. A
 * team assistant is reachable by every member of the team, and it runs on
 * the credentials of whichever member started it. So connecting a personal
 * mailbox here can put that mailbox behind an agent the rest of the team can
 * instruct. Nothing else in the product says so.
 */
export function reachLines(teams: ReachableTeam[], title: string): string[] {
  if (teams.length === 0) {
    return [
      `Valet saves this connection for your account.`,
      `Only runtimes that you start can use it.`,
    ];
  }
  const names = list(teams.map((t) => t.name));
  const memberships = teams
    .map((t) => `${t.name} (${t.memberCount} ${plural(t.memberCount, "person", "people")})`)
    .join(", ");
  return [
    `You are in ${memberships}.`,
    `A team assistant runs on the connection of the member who starts it.`,
    `If you start the assistant for ${names}, it uses this ${title} connection.`,
    `Every member can then send that assistant instructions and read its replies.`,
  ];
}

// GitHub's org-wide reach used to be one fixed sentence here. It now comes
// from `github-org-app.ts`, which reads the organisation's actual App state
// — a claim about an App installation has to be checked before it is made.
