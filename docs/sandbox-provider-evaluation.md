# Cloud Sandbox Provider Evaluation

**Author:** Conner | **Date:** March 9, 2026 | **Audience:** CTO, Security Team, Infrastructure

**Related:** `docs/ai-agent-data-governance.md` (data classification), `docs/sandbox-credential-isolation.md` (bastion architecture)

---

## Purpose

Valet runs AI agent sessions inside ephemeral cloud sandboxes -- isolated containers with a full dev environment (IDE, terminal, browser, AI agent). This document evaluates the tradeoff space for where those sandboxes run: managed third-party platforms vs. self-hosted infrastructure.

Data access policies (governance framework) and credential isolation (bastion design) apply regardless of where sandboxes run. This document focuses on **where the sandboxes run and what the security, cost, and operational implications are for each option.**

---

## What a Sandbox Needs

Each Valet session requires:

| Requirement | Details |
|-------------|---------|
| **Container isolation** | Each session runs in its own container. Sessions must not be able to observe or interfere with each other. |
| **Ephemeral lifecycle** | Containers are created on demand and destroyed when sessions end. No persistent state except explicit volume mounts. |
| **Full Linux environment** | The sandbox runs VS Code (code-server), a virtual display (Xvfb + noVNC), a web terminal (TTYD), and the AI agent process. Needs a real Linux userspace, not a function runtime. |
| **Custom images** | We build our own container images with specific toolchains, dependencies, and configurations per repository. |
| **Persistent volumes** | The workspace directory survives container restarts (hibernation/restore). Shared volumes are needed for the bastion model (agent + controller sandboxes sharing `/workspace`). |
| **Network ingress** | Users access sandbox services (IDE, terminal, VNC) via HTTPS through an auth gateway. |
| **Network egress control** | The agent sandbox should only reach LLM APIs. The controller sandbox should only reach our API and GitHub. Unrestricted egress is a data exfiltration risk. |
| **Programmatic lifecycle API** | Our worker (Cloudflare) must be able to create, stop, restart, and destroy sandboxes via API. |
| **Reasonable cold start** | Sessions should be usable within ~30 seconds of creation. Sub-10s is ideal. |
| **Snapshot/restore** | Ability to hibernate a running sandbox to storage and restore it later (cost optimization for idle sessions). |

---

## Option Space

### A. Managed Sandbox Platforms

Third-party platforms built for running ephemeral dev/agent containers.

**Examples:** Modal, E2B, Fly Machines, Daytona, Gitpod Flex

**How it works:** We define container images and call an API to create/destroy sandboxes. The provider manages the underlying compute, networking, and orchestration. We don't operate any infrastructure.

**Strengths:**
- Zero infrastructure operations. No clusters to manage, no nodes to patch, no capacity planning.
- Fast iteration. The platform handles image builds, scaling, and lifecycle management.
- APIs designed for this exact use case (ephemeral containers with programmatic control).
- Some providers offer built-in snapshot/restore and volume management.
- Lets the team focus on the product instead of infra.

**Weaknesses:**
- **Data residency and compliance.** Our code and session data runs on third-party infrastructure. We don't control where it physically runs or who has access at the infrastructure layer.
- **Vendor lock-in.** Each platform has its own API, image format quirks, networking model, and volume semantics. Migrating is non-trivial.
- **Limited network controls.** Most managed platforms don't offer fine-grained egress filtering (e.g., "this container can only reach api.anthropic.com"). Some offer no egress controls at all.
- **Blast radius of provider compromise.** If the provider is breached, all our sandboxes are potentially exposed. We inherit their security posture.
- **Shared tenancy.** Our containers run on shared physical infrastructure alongside other customers. Isolation depends on the container runtime (typically gVisor or Firecracker microVMs), not dedicated machines.
- **Observability gaps.** Limited visibility into the host layer. No way to run our own intrusion detection, audit host-level access, or independently verify isolation guarantees.

**Best for:** Teams without dedicated infra engineering, or when iterating on the sandbox experience quickly matters more than full control.

---

### B. Self-Hosted on Major Cloud (AWS / GCP / Azure)

We run our own container orchestration on infrastructure we control within a major cloud provider.

**Examples:** AWS ECS/Fargate, AWS EKS, GCP Cloud Run, GCP GKE, Azure Container Apps

**How it works:** We deploy a container orchestration layer (ECS, Kubernetes, or a serverless container service) in our own cloud account. We define VPCs, security groups, IAM roles, and network policies. Sandboxes run as containers/tasks within this infrastructure.

**Strengths:**
- **Full control over networking.** VPC security groups, NACLs, and network policies give us precise egress filtering per container. We can enforce "agent sandbox only reaches these IPs" at the infrastructure layer.
- **Data residency.** We choose the region. Data stays in our account. We control encryption keys (KMS).
- **Compliance story.** SOC 2, HIPAA, PCI -- major clouds have certifications we can inherit. We can point auditors at our own account configuration.
- **No shared tenancy (Fargate/dedicated).** Fargate tasks run on dedicated microVMs. Dedicated instances eliminate noisy neighbors entirely.
- **Observability.** Full access to VPC flow logs, CloudTrail, container-level metrics, and host-level auditing.
- **Firecracker microVM isolation** (Fargate) provides stronger isolation than most managed sandbox platforms offer.

**Weaknesses:**
- **Operational burden.** We now own cluster management, capacity planning, image registry, load balancing, autoscaling, health checks, log aggregation, and on-call for infrastructure issues.
- **Slower iteration.** Every infrastructure change is a Terraform/CDK change, reviewed and deployed through our pipeline. No "just call an API."
- **Cold start.** ECS/Fargate cold starts are 30-60s+ depending on image size. Kubernetes pod scheduling adds overhead. Pre-warming pools mitigate but add cost and complexity.
- **Snapshot/restore.** No built-in sandbox hibernation. We'd need to build checkpoint/restore (CRIU) or volume snapshot pipelines ourselves.
- **Cost.** We pay for idle capacity if we pre-warm. We pay for infrastructure engineering time. The fully-loaded cost of self-hosting is higher than managed platforms for small-to-medium scale.
- **Distraction.** Every hour spent on infrastructure is an hour not spent on the product.

**Best for:** Organizations with strict compliance requirements, existing cloud infrastructure teams, or scale where the operational overhead is amortized.

---

### C. Hybrid: Managed Platform with Self-Hosted Fallback

Use a managed platform as the primary sandbox provider, with the architecture designed to be portable.

**How it works:** We abstract the sandbox lifecycle behind an internal interface (create, destroy, connect, snapshot, restore). The primary implementation calls the managed platform's API. A secondary implementation targets ECS/Fargate or similar. We can migrate workloads between them.

**Strengths:**
- Move fast now with a managed platform
- Maintain optionality to self-host later if compliance or cost demands it
- The abstraction layer forces clean separation between our application logic and infrastructure specifics
- Can run specific high-sensitivity workloads on self-hosted while keeping the majority on managed

**Weaknesses:**
- The abstraction layer is only as good as the lowest common denominator. Platform-specific features (fast snapshot/restore, GPU passthrough, built-in volumes) may not translate cleanly.
- Maintaining two backends doubles infrastructure testing surface
- "We'll migrate later" can become permanent technical debt if the abstraction isn't kept honest

**Best for:** Teams that need to ship now but expect compliance requirements to tighten over time.

---

## Comparison Matrix

| Dimension | Managed Platform | Self-Hosted (AWS/GCP) | Hybrid |
|-----------|:---:|:---:|:---:|
| **Time to production** | Days-weeks | Weeks-months | Days (managed) + weeks (self-hosted backend) |
| **Ops burden** | Minimal | Significant | Moderate (two backends) |
| **Network egress control** | Limited / varies | Full (VPC, security groups) | Full on self-hosted; limited on managed |
| **Data residency control** | Vendor-dependent | Full | Split |
| **Compliance posture** | Inherit vendor's | Build your own (stronger) | Mixed |
| **Isolation guarantee** | Vendor-dependent (gVisor, Firecracker) | Firecracker (Fargate) or dedicated hosts | Varies by backend |
| **Cold start** | Fast (sub-10s some platforms) | 30-60s+ (Fargate) | Depends on backend |
| **Snapshot/restore** | Some platforms support | Build it yourself | Platform-dependent |
| **Cost at low scale (<100 concurrent)** | Lower | Higher (infra eng + idle capacity) | Moderate |
| **Cost at high scale (1000+ concurrent)** | Higher (per-unit pricing) | Lower (bulk compute) | Optimizable |
| **Vendor lock-in risk** | High | Low (portable containers) | Medium (abstraction helps) |
| **Blast radius of provider breach** | All sandboxes | Our account only | Split |

---

## Key Questions for the Security Meeting

### 1. What's our compliance floor?
Do we have (or expect) customer contracts, certifications, or regulatory requirements that mandate data stays on infrastructure we control? If yes, self-hosted is likely required for production workloads. If no, managed platforms are defensible.

### 2. Is shared tenancy acceptable?
Managed platforms run our containers alongside other customers' workloads on shared physical infrastructure. The isolation is at the container/microVM level. For a company whose core product is secure key management, is this an acceptable trust boundary?

### 3. How important is network egress control?
The bastion model isolates credentials from the agent, but a compromised agent could still exfiltrate *context* (source code, T1-T3 data) to arbitrary endpoints if egress is unrestricted. Self-hosted gives us VPC-level egress control. Most managed platforms don't offer per-container egress filtering.

### 4. What's our operational appetite?
Self-hosting means we need infrastructure engineering capacity: someone to own the ECS/K8s cluster, on-call for infra issues, capacity planning, image pipeline, networking. Do we have (or plan to hire) this capacity?

### 5. Is the hybrid approach worth the abstraction cost?
Building a sandbox provider abstraction layer adds engineering effort now. Is the optionality worth it, or should we commit to one path and revisit if requirements change?

---

## Recommendation

**Start managed, design for portability, migrate self-hosted if/when compliance requires it (Option C).**

Rationale:
- We're a small team. Managed platforms let us ship faster.
- The bastion architecture (credential isolation) is the primary security control and works regardless of where sandboxes run.
- The data classification tiers are also infrastructure-agnostic.
- The real compliance trigger will likely come from a specific customer contract or certification pursuit (SOC 2 Type II, for example). When that happens, we'll have concrete requirements to design against rather than speculating now.
- The abstraction layer is a modest upfront investment that prevents vendor lock-in.

**What we should do now:**
1. Define a clean internal sandbox lifecycle interface (create, destroy, connect, exec, snapshot, restore)
2. Implement the managed platform backend first
3. Restrict the managed platform to non-production customer data (our own sessions and internal testing)
4. Document the migration path to self-hosted so we can execute it within a sprint when needed
5. Evaluate network egress controls available on the managed platform -- if they're insufficient, this may accelerate the self-hosted timeline
