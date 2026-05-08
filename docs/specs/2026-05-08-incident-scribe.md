# Valet Incident Scribe — High-Level Spec

## Context

Valet is an existing internal context-capture system. Triggers arrive at the existing Trigger Gateway, which dispatches them to the orchestrator with attached context. This spec describes one workflow among many: **Incident Scribing**, triggered by Grafana IRM.

## Problem

When an incident is declared in Grafana IRM, broader teams and stakeholders need to follow along without joining the incident channel firehose or pinging responders. Today, staying informed costs responder attention; postmortem authors also pay a tax reconstructing the timeline after the fact.

## Primary User & Outcome

**Primary user:** broader team / stakeholders watching from outside the incident channel.

**Outcome they get:** a low-noise, continuously-updated view of what's happening, plus a durable timeline doc once it's over — with zero ask of the responders.

## User Stories

### US-1: Stakeholder watching an active incident
> As someone not actively responding, I want a periodic synthesized update on the incident so I can stay informed without joining the incident channel or interrupting responders.

**Acceptance:**
- Within ~1 minute of incident declaration, an initial context post appears in the dedicated scribe channel.
- Every ~15 minutes, a follow-up post summarizes what's changed: new responders, severity changes, key conversation moments, telemetry/alert changes — as structured facts plus a short narrative.
- If nothing meaningful changed, the update says so briefly rather than padding.

### US-2: Postmortem author after resolution
> As whoever writes the postmortem, I want a structured timeline doc waiting for me when the incident resolves so I'm not reconstructing it from Slack scrollback.

**Acceptance:**
- On resolution + grace period, a Google Doc is created in the shared team Drive folder, one doc per incident.
- The doc contains the full timeline assembled from all capture cycles, including post-resolution chatter caught during the grace period.
- Link to the doc is posted in the scribe channel.

### US-3: Anyone wondering "is this thing working?"
> As a Valet operator or curious engineer, I want to know that the scribe ran cleanly for a given incident, or know clearly when it didn't.

**Acceptance:**
- Workflow runs are observable through Valet's existing orchestrator surface.
- Failure modes (Grafana IRM unreachable, Slack post failed, Doc creation failed) are visible and don't silently drop incidents.

## Scope

**In scope (v1):**
- Trigger on every Grafana IRM incident declaration, no filtering.
- Periodic capture every ~15 minutes until resolved.
- Capture sources: Grafana IRM state, incident Slack channel messages, linked telemetry/dashboards/alerts — synthesized into a delta.
- Output to a dedicated scribe Slack channel (separate from incident channels).
- Final Google Doc per incident in a shared team Drive folder.

**Out of scope (v1):**
- Responder interaction with the scribe (notes, manual capture nudges, pause/resume).
- Threaded-in-incident-channel posting mode (deferred; will move there once trust is built).
- Linear ticket creation/organization (explicit later phase).
- Postmortem template formatting beyond a basic timeline structure.
- Filtering by severity, team, or service.

## Surfaces & Their Roles

- **Slack scribe channel** — the live view. Where stakeholders watch.
- **Google Doc** — the archive. Created on resolution, one per incident.
- **Markdown memory** — internal scratch / working state owned by the workflow. Not user-facing.

## Non-Functional Requirements

- **Trigger identity & trust** — incoming webhook must be verifiable as actually from Grafana IRM. (Trigger Gateway concern; spec assumes it's enforced there, calls out the requirement here for completeness.)
- **Low noise** — v1 keeps scribe output out of incident channels entirely by using a dedicated channel. Design should anticipate a later mode that posts a threaded summary in the incident channel with top-level posts only on major state changes.
- **Idempotency** — duplicate triggers for the same incident must not start duplicate workflows or produce duplicate posts/docs.
- **Resilience** — transient failures (Slack rate limits, Grafana API hiccups) should not drop the workflow; the timeline must remain coherent across retries.
- **Observability** — each workflow run, capture cycle, and external write should be inspectable.

## Open Questions for Implementation Design

These are deliberately deferred to the implementation design pass once this is merged with Valet's internal architecture context:

- Exactly how the workflow holds and updates its markdown working state across capture cycles (orchestrator-native state vs. external store).
- Synthesis approach for the 15-min delta — what's deterministic vs. LLM-generated, and how to keep it grounded.
- Grace period duration and how post-resolution chatter is bounded (fixed timeout vs. quiet-period detection).
- Google Doc structure / sectioning for the archive.
- Backpressure / cost behavior if many incidents run concurrently.

## Future Extensions

- Responder-facing controls (manual capture, add-note, pause).
- Threaded-in-channel posting mode once noise profile is trusted.
- Linear ticket creation and organization tied to the incident lifecycle.
- Severity- or service-based routing of scribe output to different channels/folders.
