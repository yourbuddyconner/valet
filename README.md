# Valet

**Self-hosted background coding agents with full dev environments.**

Give your AI coding agent its own sandbox — complete with VS Code, a browser, and a terminal — and let it work in the background while you do something else. Watch it think, intervene when needed, or check back when it's done.

<!-- TODO: Add screenshot or GIF of a running session showing the chat + IDE panels -->

## Features

- **Isolated sandboxes** — Every session gets its own container with a full dev environment. No local machine risk, no shared state between tasks.
- **Full dev environment** — VS Code, browser (via VNC), and terminal accessible directly in the web UI. The agent has the same tools a human developer would.
- **Watch or walk away** — Stream the agent's work in real-time, or let it run in the background. Pick up where it left off anytime.
- **Repo-aware** — Connect your GitHub repos. The agent clones, branches, codes, and opens PRs — using your OAuth credentials, scoped to each sandbox.
- **Team-ready** — Invite your team, manage roles, share sessions. Built for collaborative use from day one.
- **Self-hosted** — Deploy on your own Cloudflare + Modal infrastructure. Your code and API keys stay on your accounts.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ and [pnpm](https://pnpm.io/)
- A [Cloudflare](https://dash.cloudflare.com/) account (Workers, D1, R2, Pages)
- A [Modal](https://modal.com/) account (sandbox compute)
- A [GitHub OAuth App](https://github.com/settings/developers) (authentication)

### Setup

```bash
# Install dependencies
pnpm install

# Copy config templates
cp .env.deploy.example .env.deploy    # Deployment config (Cloudflare IDs, Modal workspace)
cp .env.example .env                  # Secrets (API keys)

# Configure OAuth — create packages/worker/.dev.vars with your GitHub OAuth credentials
# See the wiki for detailed OAuth setup instructions

# Set up the database
make db-setup
```

### Run locally

```bash
make dev-all    # Starts worker (:8787), client (:5173), and OpenCode container
```

The first user to sign in is automatically promoted to admin.

### Deploy

```bash
make release    # Full release: typecheck, build, push image, deploy worker + Modal + client
```

## Architecture

```mermaid
flowchart TB
    subgraph Client["Client Layer"]
        React["React SPA"]
    end

    subgraph Edge["Edge Layer (Cloudflare)"]
        Router["Hono Router"]

        subgraph DOs["Durable Objects"]
            SessionAgent["SessionAgent DO"]
            EventBus["EventBus DO"]
            APIKeys["APIKeys DO"]
        end

        subgraph Storage["Storage"]
            D1["D1 (SQLite)"]
            R2["R2 (Files)"]
        end

        Pages["Cloudflare Pages"]
    end

    subgraph Modal["Modal Backend (Python)"]
        App["Modal App"]
        Sandbox["Sandbox Container"]

        subgraph SandboxServices["Sandbox Services"]
            Runner["Runner (Bun/TS)"]
            OpenCode["OpenCode Agent"]
            CodeServer["VS Code (code-server)"]
            VNC["VNC (Xvfb + noVNC)"]
            TTYD["Terminal (TTYD)"]
            Gateway["Auth Gateway :9000"]
        end
    end

    React --> Router
    Pages -.- React
    Router --> DOs
    Router --> Storage
    SessionAgent <-->|WebSocket| Runner
    Runner --> OpenCode
    Gateway --> CodeServer
    Gateway --> VNC
    Gateway --> TTYD
    App --> Sandbox
    EventBus -->|SSE| React
```

**How a session works:** You send a message through the web UI. The Cloudflare Worker routes it to a SessionAgent Durable Object, which forwards it over WebSocket to a Runner process inside a Modal sandbox. The Runner passes the prompt to an OpenCode agent, streams results back through the same chain, and you see the agent's work in real-time.

## Packages

| Package | Description |
|---------|-------------|
| `packages/client` | React SPA — chat UI, session management, embedded IDE panels |
| `packages/worker` | Cloudflare Worker — API routes, session orchestration, Durable Objects |
| `packages/runner` | Bun/TS process inside each sandbox — bridges the DO and OpenCode agent |
| `packages/shared` | Shared TypeScript types and error classes |
| `backend` | Python/Modal — sandbox lifecycle, image builds, compute management |
| `docker` | Sandbox container image — code-server, VNC, TTYD, auth gateway |

## Development

```bash
# Individual services
make dev-worker           # Cloudflare Worker on :8787
make dev-client           # Vite dev server on :5173
make dev-opencode         # OpenCode container on :4096

# Database
make db-migrate           # Run D1 migrations locally
make db-seed              # Seed test data
make db-reset             # Drop and recreate

# Code quality
make typecheck            # TypeScript check (all packages)

# Deploy individually
make deploy-worker        # Cloudflare Worker
make deploy-modal         # Modal backend
make deploy-client        # Cloudflare Pages
```

## Documentation

- **[OAuth Setup](docs/oauth-setup.md)** — GitHub and Google OAuth configuration for dev and production
- **[Environment Variables](docs/environment-variables.md)** — Full reference for all config vars across packages
- **[API Reference](docs/api-reference.md)** — Complete endpoint documentation
- **[Architecture Deep Dive](docs/architecture.md)** — Request flows, auth model, sandbox internals
- **[Deployment Guide](docs/deployment.md)** — Production deployment, secrets management, image rebuilds
- **[Project Structure](docs/project-structure.md)** — Detailed source tree walkthrough

## Contributing

Contributions are welcome. Please open an issue to discuss larger changes before submitting a PR.

```bash
pnpm install              # Install dependencies
make db-setup             # Set up local database
make dev-all              # Start all services
make typecheck            # Verify your changes compile
```

## License

MIT
