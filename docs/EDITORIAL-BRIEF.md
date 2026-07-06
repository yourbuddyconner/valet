# Valet Docs — Editorial Brief (docs overhaul)

**This file is a working brief for the docs overhaul. It is deleted before merge — do not link to it.**

## Thesis

The docs are organized around **what work Valet owns for a team**, not around features.
Three layers:

1. **Use cases** (`docs/use-cases/`) — solution verticals. Each is a playbook: real scenarios,
   the workflows that automate them, the integrations involved, and the approval/team setup
   that makes them safe. This is the front door for evaluators and new teams.
2. **Product docs** (`docs/product/`) — how each surface works (tasks, workflows, memory,
   approvals, teams, integrations). Verticals link down into these.
3. **Engineering** (`docs/engineering/`, top-level `docs/*.md`) — runtime internals for
   operators and contributors. Product pages link down when a reader asks "but how".

Every page should answer, in its first two sentences, *who it is for* and *what they can do
after reading it*.

## Voice and style

- Second person ("you"), present tense, plain declarative sentences. No marketing fluff,
  no "simply", no "powerful", no exclamation marks.
- Concrete over abstract: name the trigger, the integration, the approval that fires.
  "Every weekday at 9am, Valet reads the on-call Slack channel…" beats "Valet can automate
  recurring communication."
- Prose-first. Bullets for genuinely enumerable lists; tables only for short parallel facts.
- Mintlify MDX: frontmatter `title` + `description` required. Components available:
  `<Note>`, `<Tip>`, `<Warning>`, `<Steps>/<Step>`, `<Card>/<CardGroup>`, `<Accordion>`,
  plus repo snippets in `/snippets/` (`use-case-card.mdx`, `feature-card.mdx`,
  `mascot-note.mdx`). Use components sparingly — one or two per page.
- Internal links are root-relative without extension: `/product/workflows`, `/use-cases/operations`.

## Product facts to build on

- **Workflows** is a shipped, central product: repeatable multi-step automations with a
  visual editor, versions, and three trigger types — webhook, schedule, manual — plus
  approval gates (a workflow pauses at a gate until a human approves). Workflow runs
  execute on a Cloudflare Workflow interpreter; each step can call integration tools or
  run agent steps in a sandbox. Source of truth: `docs/specs/workflows.md`.
- **Triggers** also exist on orchestrator schedules (recurring prompts) — distinct from
  workflow triggers; keep the distinction crisp.
- **Teams (rolling out)**: named groups inside an org. A team owns resources — most
  importantly a **team orchestrator** every member can talk to in the web UI and in bound
  Slack channels. Team roles are `admin` and `member` (richer role-based access is in
  progress). Team-owned: sessions, memory, channel bindings, integrations/credentials,
  workflows. Personal orchestrators get read-only access to their teams' memory; writes
  never cross scopes. Slack: one binding per channel, the binding routes `@valet` to that
  team's orchestrator. Source of truth: `git show origin/conner/teams-design:docs/specs/2026-07-05-teams-design.md`.
  Frame team features with a short `<Note>` that they are rolling out — do not present
  in-progress RBAC granularity as shipped.
- **Approvals**: sensitive tools pause for human approval; policies/rules control what
  needs approval; approvals can be answered from web, Slack, or Telegram.
- **Orchestrator**: each user (and each team) has a long-lived orchestrator agent that
  routes messages across channels, keeps memory, spawns child sessions for focused work.
- **Integrations**: GitHub, Slack, Telegram, Gmail, Google Calendar/Drive/Sheets/Docs,
  Linear, Notion, Stripe, Cloudflare, Sentry, Socket, and more (see `product/integrations/`).

## Accuracy rules

- Do not invent features. When in doubt, check `docs/specs/*.md` or the code, or describe
  the capability at the level you can verify.
- Shipped vs rolling out: workflows, triggers, approvals, memory, channels, integrations
  are shipped. Teams/team orchestrators are rolling out (note it). Fine-grained RBAC is
  explicitly in progress — describe the admin/member model and say richer roles are coming.
- Keep existing accurate content; rewrite for structure and depth, don't discard good material.

## Length targets

- Use-case verticals: 900–1,400 words. Substantive playbooks, not stubs.
- Product pages: whatever the surface needs; tighten rambling pages rather than pad thin ones.

## Cross-linking conventions

- Verticals link to: the product surfaces they rely on, 2–3 specific integrations, and each
  play's workflow/trigger/approval pages.
- Product pages link sideways sparingly and down to Engineering pages where relevant.
- Every vertical ends with a "Set this up" section: 3–5 steps linking quickstart, tools,
  workflows, approvals, and (where relevant) teams.
