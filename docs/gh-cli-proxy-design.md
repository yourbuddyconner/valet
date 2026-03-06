# GitHub CLI Proxy Design for Sandbox Credential Isolation

## Problem Statement

Valet child sessions run inside isolated sandboxes with full developer tooling, including `gh` (GitHub CLI). Today, enabling `gh` inside a sandbox requires either:

- Injecting long-lived GitHub credentials (PAT, OAuth token) into the sandbox environment, or
- Relying on pre-configured global git credentials tied to a user identity.

Both approaches violate the core sandbox isolation model. Long-lived credentials inside ephemeral compute increase blast radius, complicate revocation, and weaken tenant isolation guarantees.

We need a mechanism that allows `gh` usage inside sandboxed child sessions while:

- Preventing exposure of long-lived GitHub credentials
- Preserving per-user and per-org authorization boundaries
- Maintaining auditability and revocation controls
- Minimizing changes to existing workflows

## Current Credential Isolation Model (Summary)

Valet’s isolation model includes:

- **User-scoped OAuth tokens** stored server-side (Worker/D1/R2) and never directly exposed to clients.
- **Runner ↔ SessionAgentDO WebSocket** as the only control-plane communication channel.
- **Sandbox runtime** with a JWT-authenticated gateway on port 9000.
- **Per-session sandbox containers** without access to global platform secrets.

Currently:

- GitHub API calls made by the agent use server-side integrations (`actions-github`) via controlled API proxy routes.
- The `gh` CLI inside the sandbox cannot safely authenticate without injecting a token.

This creates a gap: GitHub API access is safely proxied in Worker land, but `gh` CLI assumes direct credential access.

## Proposed Architecture: GH CLI Network Proxy

We introduce a **GitHub API Proxy Service** that `gh` communicates with instead of api.github.com directly.

High-level flow:

```
Sandbox (gh CLI)
     |
     | HTTPS (signed request, short-lived token)
     v
Sandbox Gateway (port 9000)
     |
     | Authenticated internal request
     v
Worker (GitHub Proxy Route)
     |
     | Server-side OAuth token
     v
GitHub API
```

### Key Principle

The sandbox never sees the long-lived GitHub OAuth token. It only holds a short-lived, session-scoped capability token.

## Detailed Components

### 1. GH API Proxy Route (Worker)

Add a new Worker route:

```
POST /api/github/proxy
```

Responsibilities:

- Validate sandbox capability token
- Resolve user/org identity
- Fetch stored GitHub OAuth token
- Forward request to GitHub API
- Stream response back to sandbox
- Enforce per-session scope restrictions

### 2. Sandbox Capability Token

On session start:

- SessionAgentDO mints a short-lived JWT (e.g., 5–15 minutes)
- Claims include:
  - sessionId
  - userId
  - orgId (if applicable)
  - allowed repo(s)
  - allowed operations (read, write, PR, etc.)

This token is injected into the sandbox as:

```
VALET_GH_PROXY_TOKEN
```

This token is:

- Short-lived
- Rotatable
- Bound to a single session
- Revocable by invalidating session

### 3. gh CLI Configuration

We configure `gh` to use a custom GitHub hostname:

Option A (preferred):

- Override `GH_HOST` to `valet-proxy`
- Map `https://valet-proxy/api` → sandbox gateway

Option B:

- Provide a lightweight wrapper binary:

```
gh -> gh-proxy-wrapper -> proxy endpoint
```

The wrapper:

- Captures outgoing HTTP
- Signs request with `VALET_GH_PROXY_TOKEN`
- Forwards to Worker proxy

Option A is cleaner if we can rely on GH Enterprise-style host override support.

## Auth Flow

1. User authenticates GitHub via OAuth (server-side storage).
2. Child session starts.
3. SessionAgentDO mints short-lived sandbox capability token.
4. `gh` makes API request to proxy endpoint.
5. Proxy validates capability token:
   - signature
   - expiry
   - session binding
   - repo scope
6. Proxy retrieves server-side OAuth token.
7. Proxy forwards request to GitHub with OAuth token.
8. Response streamed back to sandbox.

Optional hardening:

- HMAC request signing inside sandbox
- Request hash binding inside JWT (nonce-based)

## Trust Boundaries

```
[User Browser]
        |
        v
[Worker + DO Layer]  <-- holds long-lived OAuth tokens
        |
        v
[Sandbox Container]  <-- holds short-lived capability token only
        |
        v
[gh CLI Process]
```

Critical boundary:

- Long-lived OAuth tokens never cross into sandbox.
- Sandbox tokens are useless outside the session.

## Threat Model + Mitigations

### Threat: Sandbox escape

Mitigation:

- Short-lived tokens
- Session-bound validation
- Revocation on session termination

### Threat: Token exfiltration from sandbox

Mitigation:

- Short TTL
- Scope-restricted JWT
- IP/session binding validation

### Threat: Privilege escalation via proxy

Mitigation:

- Enforce repo allowlist from session metadata
- Enforce operation-level restrictions
- Audit all proxied GitHub calls

### Threat: Replay attacks

Mitigation:

- Expiry ≤ 15 minutes
- Optional nonce cache in Worker

## CI and Sandbox Runtime Changes

### Worker

- Add `/api/github/proxy` route
- Add capability token validation utility
- Add structured audit logging

### SessionAgentDO

- Mint short-lived JWT
- Store minimal metadata for validation

### Runner

- Inject `VALET_GH_PROXY_TOKEN`
- Configure `gh` host override

### Sandbox Image

- Preconfigure `gh` to target proxy host
- Remove any baked-in global GitHub credentials

### CI

- Integration tests for proxy route
- End-to-end test: sandbox → proxy → GitHub mock
- Ensure no OAuth token leakage in logs

## Backwards Compatibility + Rollout Plan

Phase 1: Feature flag

- Proxy disabled by default
- Opt-in per org

Phase 2: Dual-mode

- Support legacy direct-token injection
- Prefer proxy for new sessions

Phase 3: Deprecation

- Remove direct token injection
- Enforce proxy-only model

No changes required for:

- Existing Worker-based GitHub integrations
- Git operations via HTTPS (handled separately)

## Trade-offs and Alternatives Considered

### Alternative 1: Inject Short-Lived GitHub Fine-Grained PAT

Pros:

- No proxy infrastructure

Cons:

- Requires GitHub App or token minting flow
- Still exposes credential material in sandbox
- Harder to revoke instantly

### Alternative 2: Disable gh CLI Entirely

Pros:

- Simplest

Cons:

- Poor developer ergonomics
- Breaks common workflows (PR creation, issue triage)

### Alternative 3: GitHub App Per Session

Pros:

- Strong isolation

Cons:

- High operational complexity
- App installation management per repo

### Chosen Approach: Network Proxy with Capability Tokens

Provides:

- Strong isolation
- Centralized audit
- No long-lived credentials in sandbox
- Minimal UX impact

## Recommendation

Implement the GitHub CLI Proxy architecture with:

- Short-lived, session-scoped JWT capability tokens
- Worker-based GitHub API forwarding
- Strict repo and operation scoping
- Audit logging for all proxied calls

This approach preserves Valet’s sandbox isolation guarantees while enabling first-class `gh` CLI workflows inside child sessions.

It aligns with our broader architectural principle: **secrets live in the control plane, not in compute.**
