# Valet Mintlify Docs Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up the docs structure needed for a Turnkey-style Mintlify site before the final Valet brand kit arrives.

**Architecture:** Keep Mintlify's built-in documentation system for normal pages, and add a custom homepage plus reusable MDX snippets for branded wayfinding. Use scoped `valet-*` CSS classes and dedicated asset folders so future brand-kit changes stay localized.

**Tech Stack:** Mintlify `docs.json`, MDX, scoped CSS, static assets under `docs/images`.

---

### Task 1: Navigation and Homepage Shell

**Files:**
- Modify: `docs/docs.json`
- Modify: `docs/index.mdx`

- [ ] Restore `theme: "mint"` and use tabbed navigation for `Home`, `Use cases`, `Product docs`, `Engineering reference`, and `Brand system`.
- [ ] Convert `docs/index.mdx` into a custom homepage using `mode: "custom"`.
- [ ] Keep homepage copy general-audience friendly and leave brand-kit-specific visuals behind reusable CSS hooks.

### Task 2: Shared Components and Styles

**Files:**
- Create: `docs/styles.css`
- Create: `docs/snippets/feature-card.mdx`
- Create: `docs/snippets/use-case-card.mdx`

- [ ] Add scoped `valet-*` styles for the custom homepage, cards, dark/light image utilities, and responsive behavior.
- [ ] Add reusable cards for feature and use-case wayfinding.
- [ ] Avoid styling normal technical pages beyond shared component classes.

### Task 3: Use-Case Starter Pages and Brand Assets

**Files:**
- Create: `docs/use-cases/overview.mdx`
- Create: `docs/use-cases/software-engineering.mdx`
- Create: `docs/use-cases/operations.mdx`
- Create: `docs/use-cases/customer-workflows.mdx`
- Create: `docs/images/brand/README.md`
- Create: `docs/images/brand/.gitkeep`
- Create: `docs/images/home/README.md`
- Create: `docs/images/home/.gitkeep`
- Create: `docs/images/icons/README.md`
- Create: `docs/images/icons/.gitkeep`

- [ ] Add concise starter content for the public use-case tab.
- [ ] Add documented asset drop zones for the later brand kit.
- [ ] Reference existing character assets without requiring final art.

### Task 4: Verification

**Files:**
- Validate all changed docs files.

- [ ] Parse `docs/docs.json`.
- [ ] Verify every navigation page exists.
- [ ] Verify local MDX links and image references resolve.
- [ ] Run `git diff --check`.
