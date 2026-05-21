# Action Policy Overrides

> Personal tool approval overrides that let users customize which integration tools auto-run, prompt for confirmation, or are blocked — without touching org-level policy.

## How It Works

Every tool call goes through a three-layer policy resolution before it runs:

1. **Org policy** — admin-set rules at three specificity levels: exact tool, entire service, or risk level. An org **deny is absolute** and cannot be overridden by anything below.
2. **User override** — personal rules at the same three specificity levels with the same precedence (exact tool beats service beats risk level). These can loosen or tighten system defaults and non-deny org policies.
3. **System default** — fallback when neither org nor user has an opinion: low-risk tools auto-allow, medium/high require approval, critical denies.

The first layer to produce a definitive result wins, with one hard rule: **explicit org deny always wins, period.**

## Override Lifetimes

| Lifetime | Created from | Expires when | Scope |
|----------|-------------|--------------|-------|
| **Persistent** | User settings UI, or "Always Allow" in approval prompt | Never (manual delete only) | All sessions |
| **Session** | "Allow for Session" in approval prompt | Session hibernates, refreshes, or terminates | Single session |
| **Timed** | Reserved for future use | Explicit `expiresAt` timestamp | All sessions |

Session overrides are tied to the sandbox lifecycle, not the logical session record. When the sandbox is recycled — whether by idle hibernation (15 min), explicit refresh, or terminal shutdown — session overrides expire. The reasoning: the user is no longer actively supervising, and the fresh OpenCode instance should start from a clean approval slate.

## The Approval Prompt

When a tool call requires approval, the user sees four choices:

| Choice | What happens |
|--------|-------------|
| **Allow** | Run this one call. No override saved. |
| **Allow for Session** | Run this call and auto-allow future identical calls until the sandbox recycles. |
| **Always Allow** | Run this call and auto-allow future identical calls permanently. |
| **Cancel** | Deny this call. No override saved. |

"Allow for Session" and "Always Allow" create exact-tool overrides only (service + actionId). Broad service or risk-level overrides are only available through the user settings UI.

## Specificity Rules

When multiple overrides could apply to a single tool call, the most specific one wins:

1. **Exact tool** (`gmail` + `draft.create`) — highest priority
2. **Service** (`gmail`) — middle priority
3. **Risk level** (`medium`) — lowest priority

Within the same specificity, persistent overrides rank above session overrides, and ties break by most-recently-updated.

## Audit Trail

Every tool invocation records the full policy resolution chain: which org policy matched, what the base mode was before user overrides, which user override applied (if any), its lifetime and scope, and the final resolved mode. This makes it possible to answer "why did this tool run without prompting?" after the fact.

## Key Constraints

- User overrides are strictly personal — they never affect other org members.
- Org deny cannot be bypassed. A user "always allow" on a tool that the org explicitly denies will still be denied at execution time.
- Approval prompt shortcuts are exact-tool only. You cannot create a broad "allow all Gmail" override from an approval card.
- Override rows are soft-expired (`expiresAt` set to now), not deleted, preserving the audit trail.
