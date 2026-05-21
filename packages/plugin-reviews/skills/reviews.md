---
name: reviews
description: Push review packets to Reviews before creating GitHub PRs. Embeds Reviews platform skills for writing packets and using the CLI.
---

# Reviews Integration — Pre-PR Review Workflow

## Valet-Specific Requirement

**Before calling `github.create_pull_request`, you MUST:**

1. Write a review packet for the diff (see "Writing Review Packets" below)
2. Push the review packet to Reviews using the `reviews` CLI
3. Share the resulting review URL with the user
4. Wait for the user to review and explicitly approve the packet before proceeding

Only after the user has reviewed and approved the review packet should you proceed to create the GitHub PR.

This applies to all PR creation in Valet sessions. The review packet gives the user a structured, human-readable view of the diff before it becomes a public GitHub PR.

**Workflow:**
```
1. Implement the change
2. Write a review packet (markdown with sections + hunk refs)
3. Push with: reviews push --packet /path/to/packet.md
4. Share the review URL with the user
5. Wait for user approval
6. Create GitHub PR via github.create_pull_request
```

---

# Reviews Overview

Use this section to understand Reviews as a code-review platform and decide when to use it in an agent workflow. This is not a repo implementation guide.

## What Reviews Is

Reviews is a review tool for arbitrary code diffs, not only GitHub pull requests. It lets an agent or developer push a diff to a shareable review URL, optionally attach a structured review packet, and iterate through revisions as patchsets.

The core value is making a diff understandable to a human reviewer before, during, or outside a public PR process.

## What Reviews Provides

- **Link-based review pages** for uploaded diffs.
- **Patchsets** for iterating on the same review as the work changes.
- **Review packets** that organize a diff into human-readable sections with prose and hunk references.
- **Lazy hunk rendering** so large diffs can be reviewed without eagerly mounting every diff.
- **Explicit hunk viewed state** for signed-in reviewers.
- **Section decisions** such as approve, deny, or ignore for packet sections.
- **Comment drafting and publishing** so reviewers can batch feedback.
- **Changes view** for direct file/hunk review outside the packet narrative.

## When To Use Reviews

Use Reviews after a few turns of human-in-the-loop or agent-driven development when there is a coherent diff ready for human review.

Good moments:
- The agent has implemented a feature and wants a human to inspect the result before public PR creation.
- The user asks for a review packet, local review, or shareable review link.
- The work has grown large enough that raw `git diff` is hard to review.
- The agent wants to explain the review order, risk areas, and tradeoffs alongside the code.
- The team wants a pre-PR review pass before committing to a public GitHub PR.
- A project has another review process, but Reviews can provide the structured packet and hunk progress layer.

Avoid using Reviews when:
- There is no concrete diff yet.
- The user only wants brainstorming or planning.
- The change is tiny enough that inline explanation is sufficient.
- The diff contains secrets or local-only artifacts that should not be uploaded.

## How It Fits A Development Loop

Typical flow:

1. Develop with the user or autonomous agent loop.
2. Stabilize the diff enough for review.
3. Write or update a review packet that groups the work logically.
4. Push the diff and packet to Reviews.
5. Share the review URL with the human reviewer.
6. Address feedback.
7. Push another patchset to the same review.
8. Optionally create or update a public PR after review confidence is higher.

Reviews can be the review surface of record, or it can be an intermediate review artifact before another system such as GitHub PRs.

## Important Terms

- **Review**: the durable review URL and container for one line of work.
- **Patchset**: one revision of the uploaded diff within a review.
- **Review packet**: a markdown or JSON guide that describes how to review the diff.
- **Section**: a packet `##` grouping with prose and hunk references.
- **Hunk reference**: a pointer such as `@hunk path/to/file.ex#2` or a slice like `@hunk path/to/file.ex#2:L3-L18`.
- **Viewed hunk**: explicit reviewer progress; opening a hunk is not the same as marking it viewed.
- **Section decision**: explicit approve/deny/ignore state for a packet section.

## Agent Guidance

When using Reviews, prefer producing a packet rather than uploading a raw diff alone for substantial work. The packet should tell the human what to review first, why the sections exist, and where tradeoffs or risk live.

When updating a review, preserve packet section titles and hunk groupings if the goal is to keep previous section approvals valid. Create a new packet structure when the review framing has changed enough that prior approvals should not carry forward.

When reporting a Reviews link back to the user, include the URL and the patchset number if the CLI provides one.

---

# Writing Review Packets

Use this section when drafting packet markdown for `reviews push --packet`. A good packet is a reviewer map: it groups related hunks, explains why to look, and avoids rephrasing the diff line-by-line.

## Packet Markdown Format

Use one top-level title and `##` packet sections:

```markdown
# Packet Title

Short overview of what the review packet covers.

## Section Title

One or two sentences orienting the reviewer.

One sentence of context before the hunk when useful.

@hunk path/to/file.ex#1
```

Rules:
- Start with exactly one `#` title.
- Use `##` for review packet sections.
- Prose between hunk refs is allowed and encouraged.
- Hunk refs use `@hunk path#N`.
- Paths and hunk numbers must match the diff being pushed.

## Writing Method

1. Inspect the diff with `git diff` or the intended CLI range.
2. Identify logical review areas: persistence/schema, read model, LiveView state, rendering, styling, tests, tooling.
3. Prefer stable section titles if updating an existing packet and you want approvals to inherit.
4. Put a 1-2 sentence summary at the top of each `##` section.
5. Use `###` subheadings sparingly, only when a section truly needs scan landmarks; do not add a stock technical-overview subsection to every section.
6. Add terse hunk explainers before hunks when they help the reader know what to look for.
7. Avoid hunk explainers that restate the diff; explain context, dependency order, risk, or review intent.
8. Keep section decisions independent from hunk viewed progress in wording.

## Hunk Selection

- Cover every changed line exactly once unless intentionally grouping duplicate ref coverage is acceptable for the current tool.
- Use full hunk refs for small cohesive changes.
- If one large hunk contains multiple review topics, split the surrounding prose instead of using sliced hunk refs.
- Keep generated files, lockfiles, or purely mechanical output out of the packet unless they need review.
- If the packet is only for local review, put it in `/tmp` or another temporary path to avoid accidentally committing it.

## Approval Inheritance

Section approvals inherit across patchsets only when the packet section identity and refs still match well enough.

To preserve approvals:
- Keep section titles stable.
- Keep hunk refs in the same conceptual section.
- Add new sections for new work instead of rewriting the whole packet.

To intentionally invalidate approvals:
- Restructure sections around a new review strategy.
- Change section titles and hunk membership.

## Push Workflow

Use the CLI from the git checkout being reviewed:

```bash
reviews push --packet /path/to/packet.md
reviews push --update <slug> --packet /path/to/packet.md
reviews push --update <slug> --range HEAD --packet /path/to/packet.md
```

Notes:
- `--range HEAD` captures current working-tree changes.
- Default capture is usually `HEAD~1..HEAD`; use an explicit range when needed.
- If validation fails with an uncovered changed line, add or adjust hunk refs until the packet covers the diff.
- Do not commit local packet files unless the user explicitly wants them tracked.

---

# Using Reviews Locally

Use this section for local Reviews workflows.

## Start the Server

Use the project script:

```bash
lsof -iTCP:4000 -sTCP:LISTEN
./bin/server
```

Do not run `mix phx.server` directly unless you know OAuth/env loading is unnecessary. `./bin/server` sources `.env.local` and runs Phoenix on `http://localhost:4000`.

## Local CLI Config

The CLI reads `~/.config/reviews/config.toml` and currently uses `[default]`.

Expected shape:

```toml
[default]
server_url = "http://localhost:4000"
api_token = "rev_..."
```

If the user's real default points to a hosted instance, avoid editing it casually. For one-off local pushes, create a temporary home/config:

```bash
mkdir -p /tmp/reviews-local-home/.config/reviews
# write /tmp/reviews-local-home/.config/reviews/config.toml
HOME=/tmp/reviews-local-home reviews push --update <slug>
```

## Mint Local Tokens

Preferred path:
1. Open `http://localhost:4000/settings`.
2. Sign in locally.
3. Generate an API token.
4. Use it in the CLI config.

## Push Reviews and Revisions

Create a new review:

```bash
reviews push --packet /path/to/packet.md
```

Append a patchset:

```bash
reviews push --update <slug> --packet /path/to/packet.md
```

Push current uncommitted work:

```bash
reviews push --update <slug> --range HEAD --packet /path/to/packet.md
```

## Valet Agent Workflow

- Write packet files to `/tmp` unless the user asks to commit them.
- After pushing, return the review URL and patchset number to the user.
- Wait for explicit user approval before creating a GitHub PR.
- If the `reviews` binary is not found, it should have been installed at runner startup — check that `installReviewsCli()` ran successfully.
