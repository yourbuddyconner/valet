# AI Agent Data Governance Framework

**Executive Summary for Security Review**

**Author:** Conner | **Date:** March 10, 2026 | **Audience:** CTO, Security Team

---

## Context

We run AI coding agents in two contexts: Valet (our hosted agent, running in cloud sandboxes) and developer-local agents like Claude Code and Copilot (running on laptops). These have different runtime models but share the same risk: agents observe, reason over, and sometimes retain context from the data they interact with. Our existing policies don't explicitly cover this class of data exposure.

**This document proposes a data classification framework for AI agent contexts.** It gives us a shared vocabulary to make fast, consistent decisions about what information AI agents can reason over, and a clear architectural position on credentials.

---

## Why This Matters for Turnkey

Turnkey's core security guarantee is that **raw private keys never leave secure enclaves** -- not to Turnkey, not to customer software, not to anyone. AI agents introduce new vectors that could undermine this guarantee if not governed:

- **Cloud-hosted agents** (Valet sandboxes) run in isolated cloud sandboxes with access to repos, APIs, and potentially credentials
- **Developer-machine agents** (Claude Code, Copilot, etc.) operate in the local environment with access to whatever the developer can see
- **Third-party model providers** (Anthropic, OpenAI, Google) process prompts server-side, meaning anything in the agent's context window is transmitted to external infrastructure

The question isn't whether to use AI agents -- we already do. The question is: **what guardrails ensure we don't accidentally feed sensitive data into contexts where it shouldn't exist?**

---

## Credential isolation

Agents process untrusted input and can be manipulated via prompt injection, so we keep credentials out of the agent process entirely. We've designed a bastion model for Valet's cloud sandboxes where the agent sandbox holds only LLM API keys and a separate controller sandbox holds all other credentials. This is not yet implemented -- until it is, Valet sandboxes should not hold company information (e.g., proprietary source code). On developer laptops, credentials should live in 1Password or system keychains, and `.env` files should be in `.gitignore` and `.claudeignore`.

---

## Reading vs. writing code

Agents reading source code is a T3 activity -- it's how they do useful work. Agents *writing* code and pushing it to a remote repository is a different risk class: it changes shared state, can introduce vulnerabilities, and affects production systems downstream.

Turnkey requires all git commits to be signed by a hardware security key (YubiKey). This is an existing company policy that applies equally to agent-written code. An agent can write and locally commit code, but those commits cannot be pushed to a remote branch without a human producing a hardware-backed signature. In Valet, we've designed (but not yet implemented) a push approval flow that enforces this. On developer laptops, the existing signing requirement already applies -- Claude Code or any other agent produces unsigned local commits, and the developer signs before pushing.

The governance implication: agents can read freely (within tier restrictions), but agent-written code never reaches a remote without a hardware-key signature from a human.

---

## Data classification tiers

With credentials handled architecturally, the tiers below govern what **information and context** agents are allowed to reason over:

| Tier | Classification | Description | AI Agent Policy |
|------|---------------|-------------|-----------------|
| **T0** | **Forbidden** | Raw private keys, key shares, seed phrases, enclave secrets, HSM credentials, raw credential values | **Never.** Must never appear in any AI agent context, cloud or local. Hard-blocked at tooling level where possible. Credentials are isolated at the architecture level. |
| **T1** | **Restricted** | Customer PII (emails, account metadata), production data snapshots, internal security configurations, audit logs containing user actions | **Cloud sandboxes only.** Acceptable for the agent to reason over when debugging or analyzing, but should not be pasted into prompts unnecessarily. Never on developer laptops via AI agents. |
| **T2** | **Anonymized** | Anonymized or aggregated customer data (stripped of emails, names, account identifiers), redacted logs, synthetic datasets derived from production patterns | **Permitted** in both cloud and local AI agents. Preferred over T1 data whenever possible -- if an agent needs customer data to debug an issue, anonymize it first. |
| **T3** | **Internal** | Source code, architecture docs, internal API schemas, non-customer test data, org configuration, on-chain/semi-public customer identifiers (org IDs, public keys, wallet addresses) | **Permitted** in both cloud and local AI agents. This is what agents work with day-to-day. Standard NDA/employment protections apply. |
| **T4** | **Open** | Public docs, open-source dependencies, published API specs, marketing content | **Unrestricted.** No special handling needed. |

T0 includes raw credential values of any kind. The tiers govern what *information the agent reasons over*. Agents hold no credentials (except LLM API keys, which are a cost risk, not a security risk). When customer data is needed in an agent context, prefer T2 (anonymized) over T1 (raw PII).

---

## Approved model providers

Every prompt sent to an AI agent transits through a model provider's infrastructure. The provider sees the full context window, which may include source code, architecture details, and (if mishandled) T1 data. Which providers we trust with that data is a security decision.

### T1 data and model providers

Our position: T1 data (customer PII, production data) may be sent to approved providers when the provider's contract explicitly precludes training on our prompts and outputs. The contractual no-training commitment, combined with business-tier data retention policies, is sufficient protection for now.

That said, anonymization remains the preferred path. If an agent needs customer data to debug an issue, strip PII first and work with T2 data. Sending raw T1 should be the exception, not the default.

Long-term, the terminal step for trust minimization is preventing T1 data from reaching any remote model endpoint. If we reach that conclusion, the path is aggressive anonymization at the tooling level (scrub before it enters the context window) combined with self-hosted inference for cases where anonymization isn't practical. See "Self-hosted model infrastructure" below.

### Approved provider list

We maintain a formal approved-provider list. Adding a new provider requires security review confirming: (1) a business-tier agreement with a contractual no-training clause, and (2) a documented data retention policy.

| Provider | Account tier | Data retention policy | Used by |
|----------|-------------|----------------------|---------|
| **Anthropic (Claude)** | Claude Team | No training on inputs. 90-day retention for trust & safety, deletable on request. | Claude Code (developer laptops), Valet cloud sandboxes |
| **OpenAI (GPT)** | ChatGPT Business | No training on inputs. 30-day retention for abuse monitoring. | ChatGPT web UI (ad hoc use by employees) |
| **Google (Gemini)** | Gemini Enterprise | No training on inputs. Data processed in-region, deletable on request. | Valet cloud sandboxes (multi-model routing) |

All listed tiers include contractual commitments that inputs are not used for model training. This is the minimum bar for any provider handling T3 or below data.

**Unapproved providers:** Any model provider not listed above is unapproved for T1, T2, or T3 data. This includes free tiers of approved providers (which typically do train on inputs), self-hosted open-source models on unvetted infrastructure, and any provider without a clear data retention policy. Developers should not paste source code or internal docs into unapproved tools.

### Multi-model strategy

Valet's architecture supports routing tasks to different models. The reason to include multiple providers is pragmatic: models improve at different rates across different tasks, and the best way to find the right model for a given job is to let users choose and measure outcomes. Valet already tracks model usage internally. Over time, we can use that data to identify which models produce the best results for specific task types and pare down to smaller, cheaper models where quality allows.

This avoids a lowest-common-denominator situation. Instead of picking one model and living with its weaknesses, we use the best available model per task and continuously re-evaluate as the field moves.

### Self-hosted model infrastructure (future)

If we decide T1 data should never reach a third-party model endpoint, or if we want to fine-tune on proprietary data, self-hosted open-source models are the path. Running inference on our own cloud infrastructure (e.g. GPU instances on GCP/AWS) eliminates the trust dependency on external providers for sensitive workloads.

This is not a priority today. We're optimizing for proof-of-value, and the best models are not open-source. At small-to-medium volume (under ~25 daily users), self-hosted inference is manageable. Beyond that, throughput management and cloud GPU costs become real operational overhead. This is a team effort, not a one-person project.

When we're ready, the approach would be: start with a single open-source model (e.g. Llama) on managed GPU infrastructure, route only T1-adjacent workloads to it, and keep third-party providers for everything else. Fine-tuning on our own data is a further step that compounds the value of self-hosting.

---

## Policy decisions

The following questions were raised in the initial draft. Decisions and current positions are noted.

### 1. Source code in third-party model contexts

**Decision: Permitted (T3) with approved providers only.** Source code is already going to Anthropic and OpenAI under business agreements. This is acceptable. On-premise/VPC model hosting is not needed at this time but remains a future option (see "Self-hosted model infrastructure" above).

### 2. Customer identifiers in agent contexts

**Decision: Deferred pending compliance review.** Customer org IDs, public keys, and wallet addresses are T3 (on-chain, semi-public). Email addresses and account metadata are T1. Anonymized/aggregated versions are T2.

There's an open question about whether some identifiers (e.g. addresses) constitute PII under regulations like GDPR or CCPA. We don't currently operate under those regimes, but we should be conscious of this if that changes. Compliance should weigh in before we finalize the T1/T2 boundary for customer data.

### 3. Production data in cloud agent contexts

**Decision: Permitted in cloud sandboxes with care.** Agents may reason over production data (logs, DB query results) when debugging. The agent reads data passed into its context by the controller/worker -- it never holds database credentials itself.

We should take more care here than the minimum required. Prefer anonymized (T2) data when possible; use raw T1 only when the specific debugging task requires it.

### 4. Agent memory and context retention

**Decision: Auditable, with encrypted memory for T1 data.**

Agent memory is currently stored in Cloudflare D1. The abstractions support migration to Postgres (CloudSQL or similar managed service) if we need stronger isolation or encryption-at-rest guarantees.

For T1 data specifically, we will build an encrypted memory capability: T1 data that enters persistent memory is encrypted at rest, but available to the agent in plaintext during an active session. This lets the agent maintain useful context (e.g. customer IDs, email addresses, contact information) without leaving sensitive data exposed in storage. Implementation details TBD, but the principle is: T2/T3 memory is stored plaintext, T1 memory is encrypted at rest with per-org or per-user keys.

T2/T3 data in memory is acceptable and does not require encryption beyond standard infrastructure protections. All memory stores should be auditable -- we should be able to answer "what does the agent remember about customer X?" on request.

### 5. Developer laptop agent tooling

**Decision: Policy-enforced tooling constraints + Valet MCP Server.**

T0 data should never exist on a developer machine, period. T1 data should be rare, temporary, and never used with a local AI agent. This is enforced by policy, not tooling (for now).

For developer-local agents that need access to internal tools and data: rather than giving agents direct access to production systems, we will build a Valet MCP Server that developers connect their local agent to. This creates a single governed access point -- all data flows through Valet's infrastructure, where tier enforcement, audit logging, and anonymization can be applied consistently. The MCP server exposes safe tool interfaces without giving the local agent direct credentials or raw data access.

Developers may use their preferred agent tooling (Claude Code, Cursor, Copilot, etc.) with standard guardrails (`.gitignore`, `.claudeignore`, 1Password references). The Valet MCP Server is the recommended path for any workflow that touches internal data beyond the local codebase.

---

## Enforcement Mechanisms

| Control | Status | Notes |
|---------|--------|-------|
| Bastion sandbox architecture (credential isolation) | Designed, not yet implemented | Required before Valet sandboxes can work with company information (proprietary source code, etc.) |
| `.gitignore` / `.claudeignore` for secret files | Exists | Prevents agents from reading `.env`, credential files |
| 1Password references (not raw values) for secrets | Exists | Valet sandboxes resolve secrets via controller, not agent |
| Sandbox isolation (no host network, ephemeral containers) | Exists | Cloud sandboxes are destroyed after sessions |
| Pre-commit secret scanning | Exists / Extend | Should cover agent-generated commits too |
| Audit log of agent-accessed files | Planned | Valet tracks tool calls; local agents don't yet |
| T0 pattern detection in agent context | Not started | Regex/heuristic scanning for key material before it enters agent context |
| Network egress restrictions on agent sandbox | Planned | Agent sandbox can only reach LLM APIs; all other external access through controller |

---

## Recommended next steps

1. **Ratify the five-tier classification** and the "no credentials for agents" principle at the next security meeting
2. **Get compliance input on the T1/T2 boundary** for customer identifiers -- specifically whether on-chain addresses or similar data requires T1 treatment under any applicable regulation
3. **Add Google (Gemini) Enterprise agreement** to approved provider list, confirming no-training clause and retention policy
4. **Design the encrypted memory feature** -- define encryption scheme, key management (per-org vs. per-user), and which memory fields are T1-eligible
5. **Spec the Valet MCP Server** for developer-local agent access -- define the tool surface, auth model, and which data tiers are accessible through it
6. **Document the policy** in the internal security handbook and circulate to engineering
7. **Evaluate sandbox infrastructure options** -- managed vs. self-hosted cloud sandboxes have different security and compliance tradeoffs. See accompanying sandbox evaluation framework.
8. **Revisit quarterly** as agent capabilities and usage patterns evolve; re-evaluate the T1-to-remote-providers position as self-hosted inference becomes more practical

---

*The goal is a shared mental model: anyone on the team should be able to answer "Is this T0, T1, T2, T3, or T4?" quickly, and never need to ask "should I give this credential to an agent?" because the answer is always no. If a tier classification is ambiguous, escalate to security.*
