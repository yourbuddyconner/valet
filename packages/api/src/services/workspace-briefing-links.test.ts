import { expect, it } from "vitest";
import type { BriefingEvidence } from "./workspace-briefing-sources.js";
import { attachRelatedBriefingEffects } from "./workspace-briefing-links.js";
const thread: BriefingEvidence = { source: { id: "thread", kind: "thread", title: "Review", updatedAt: 1, sessionId: "runtime", threadId: "goal" }, content: "Review https://github.com/org/repo/pull/12", state: "updated" };
const pr: BriefingEvidence = { source: { id: "pr", kind: "pull_request", title: "Fix", updatedAt: 2, url: "https://github.com/org/repo/pull/12" }, content: "Opened", state: "updated" };
it("keeps a PR referenced by the source when synthesis omits its ID", () => {
  const group = [thread]; attachRelatedBriefingEffects(group, [thread, pr]); expect(group).toEqual([thread, pr]);
});
it("attaches exact thread and run outputs, never unrelated shared-runtime or URL-prefix matches", () => {
  const sameThread = { ...pr, source: { ...pr.source, id: "same", sessionId: "runtime", threadId: "goal", url: undefined } };
  const otherThread = { ...pr, source: { ...pr.source, id: "other", sessionId: "runtime", threadId: "different", url: undefined } };
  const prefix = { ...pr, source: { ...pr.source, id: "prefix", url: "https://github.com/org/repo/pull/1" } };
  const run: BriefingEvidence = { source: { id: "run", kind: "workflow", title: "Build", updatedAt: 1, runId: "r" }, content: "Ready", state: "updated" };
  const runPr = { ...pr, source: { ...pr.source, id: "run-pr", runId: "r", url: undefined } };
  const group = [thread, run]; attachRelatedBriefingEffects(group, [sameThread, otherThread, prefix, runPr]);
  expect(group.map(item => item.source.id)).toEqual(["thread", "run", "same", "run-pr"]);
});
