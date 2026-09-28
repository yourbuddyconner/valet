import type { BriefingEvidence } from "./workspace-briefing-sources.js";

/** Preserve recorded outputs without inferring relationships from shared runtimes. */
export function attachRelatedBriefingEffects(group: BriefingEvidence[], evidence: readonly BriefingEvidence[]): void {
  const context = group.filter(item => ["thread", "workflow", "artifact"].includes(item.source.kind));
  for (const candidate of evidence) {
    if (group.includes(candidate) || !["pull_request", "review", "message"].includes(candidate.source.kind)) continue;
    const source = candidate.source;
    const related = context.some(item =>
      (source.threadId && source.sessionId && source.threadId === item.source.threadId && source.sessionId === item.source.sessionId)
      || (source.runId && source.runId === item.source.runId)
      || (source.url && Array.from(item.content.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g), match => match[0]).includes(source.url)));
    if (related) group.push(candidate);
  }
}
