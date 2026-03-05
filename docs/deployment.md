# Deployment Guide

From zero to deployed in 4 steps. You need accounts on three services, one config value, and one command.

## Prerequisites

Install these tools locally. Commands below are for macOS with [Homebrew](https://brew.sh/) -- adjust for your platform.

```bash
# Node.js 22+
brew install node@22

# pnpm
brew install pnpm

# uv (Python package manager, used for Modal backend)
brew install uv

# Bun
brew install oven-sh/bun/bun

# Wrangler CLI (Cloudflare)
npm install -g wrangler

# Modal CLI
uv tool install modal

# jq (used by deploy script)
brew install jq
```

## Step 1: Create Accounts

You need three accounts:

| Service | What it does | Sign up |
|---------|-------------|---------|
| **Cloudflare** | Hosts the API (Worker), database (D1), storage (R2), and frontend (Pages) | [dash.cloudflare.com](https://dash.cloudflare.com) |
| **Modal** | Runs sandbox containers (the coding environments) | [modal.com](https://modal.com) |
| **GitHub** | OAuth login for users + repo access inside sandboxes | [github.com/settings/developers](https://github.com/settings/developers) |

**Cloudflare** -- Workers paid plan required for Durable Objects. R2 must be enabled in the Cloudflare dashboard (Workers & Pages > R2) before deploying.

**GitHub OAuth App** -- Create one at [Settings > Developer settings > OAuth Apps](https://github.com/settings/developers):

| Field | Value |
|-------|-------|
| Homepage URL | `https://your-domain.com` (or `http://localhost:5173` for dev) |
| Callback URL | `https://<PROJECT_NAME>.<your-subdomain>.workers.dev/auth/github/callback` |

Save the **Client ID** and **Client Secret**.

Optional: [Google OAuth](oauth-setup.md) for Google sign-in and integrations.

## Step 2: Authenticate CLIs

```bash
wrangler login
modal token set
```

## Step 3: Configure

```bash
cp .env.deploy.example .env.deploy
```

Edit `.env.deploy` and set one value:

```bash
PROJECT_NAME=valet-yourname
```

All Cloudflare resource names derive from this automatically:

| Resource | Name |
|----------|------|
| Worker | `valet-yourname` |
| Pages | `valet-yourname-client` |
| D1 | `valet-yourname-db` |
| R2 | `valet-yourname-storage` |

## Step 4: Deploy

```bash
pnpm install
make deploy
```

This automatically:

1. Creates D1 database and R2 bucket if they don't exist
2. Discovers your Modal workspace from the CLI
3. Deploys the **Cloudflare Worker** (API + Durable Objects)
4. Runs **D1 migrations**
5. Deploys the **Modal backend** (sandbox orchestration)
6. Builds the **frontend** with the correct Worker URL and deploys to Cloudflare Pages

After the first deploy, set worker secrets:

```bash
wrangler secret put ENCRYPTION_KEY --name valet-yourname        # Any string, 32+ chars
wrangler secret put GITHUB_CLIENT_ID --name valet-yourname      # From your GitHub OAuth app
wrangler secret put GITHUB_CLIENT_SECRET --name valet-yourname  # From your GitHub OAuth app
wrangler secret put FRONTEND_URL --name valet-yourname          # e.g. https://valet-yourname-client.pages.dev
```

Visit `https://valet-yourname-client.pages.dev` and sign in with GitHub.

## Individual Deployments

For incremental updates after the initial deploy:

```bash
make deploy-worker        # Cloudflare Worker only
make deploy-modal         # Modal backend only (sandbox orchestration)
make deploy-client        # Frontend only (builds + deploys to Pages)
make deploy               # Full deploy (auto-discovers everything)
```

There's also `make release`, which runs a more comprehensive pipeline: install, typecheck, build and push the OpenCode Docker image to GHCR, deploy Worker, run D1 migrations, and deploy Pages.

## Forcing a Sandbox Image Rebuild

Sandbox images are built and cached by Modal (defined in `backend/images/base.py`). To force a rebuild after changing `docker/` or `packages/runner/`:

1. Bump `IMAGE_BUILD_VERSION` in `backend/images/base.py`
2. Redeploy: `make deploy-modal`
3. New sessions will use the updated image (existing sandboxes are not affected)

## Quick Reference

| What | Where |
|------|-------|
| Worker URL | `https://<PROJECT_NAME>.<subdomain>.workers.dev` |
| Frontend URL | `https://<PROJECT_NAME>-client.pages.dev` |
| Modal dashboard | `https://modal.com/apps/<workspace>/main/deployed` |
| D1 console | Cloudflare dashboard > Workers & Pages > D1 |
| Worker logs | `wrangler tail` (from `packages/worker/`) |
| Worker secrets | `wrangler secret list` (from `packages/worker/`) |
