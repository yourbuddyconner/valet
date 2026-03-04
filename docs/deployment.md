# Deployment Guide

From zero to deployed in 4 steps. You need accounts on three services, a handful of secrets, and one command.

## Prerequisites

Install these tools locally. Commands below are for macOS with [Homebrew](https://brew.sh/) -- adjust for your platform.

```bash
# Node.js 22+
brew install node@22

# pnpm
brew install pnpm

# uv (Python package manager, used for Modal backend)
brew install uv

# Wrangler CLI (Cloudflare)
npm install -g wrangler

# Modal CLI
uv tool install modal
```

## Step 1: Create Accounts

You need three accounts:

| Service | What it does | Sign up |
|---------|-------------|---------|
| **Cloudflare** | Hosts the API (Worker), database (D1), storage (R2), and frontend (Pages) | [dash.cloudflare.com](https://dash.cloudflare.com) |
| **Modal** | Runs sandbox containers (the coding environments) | [modal.com](https://modal.com) |
| **GitHub** | OAuth login for users + repo access inside sandboxes | [github.com/settings/developers](https://github.com/settings/developers) |

**Cloudflare** -- Workers paid plan required for Durable Objects.

**Modal** -- Note your **workspace name** from the dashboard (e.g. `yourname`).

**GitHub OAuth App** -- Create one at [Settings > Developer settings > OAuth Apps](https://github.com/settings/developers):

| Field | Value |
|-------|-------|
| Homepage URL | `https://your-domain.com` (or `http://localhost:5173` for dev) |
| Callback URL | `https://<your-worker>.workers.dev/auth/github/callback` |

Save the **Client ID** and **Client Secret**.

Optional: [Google OAuth](oauth-setup.md) for Google sign-in and integrations.

## Step 2: Create Cloudflare Resources

Log in to Wrangler and create the database and storage bucket:

```bash
wrangler login

# Create D1 database -- save the ID it prints
wrangler d1 create valet-db

# Create R2 bucket
wrangler r2 bucket create valet-storage
```

## Step 3: Configure

### `.env.deploy`

Copy `.env.deploy.example` to `.env.deploy` and fill in your values:

```bash
WORKER_PROD_URL=https://valet.your-subdomain.workers.dev
PAGES_PROJECT_NAME=my-valet                # Must be globally unique on Cloudflare Pages
MODAL_BACKEND_URL=https://your-modal-workspace--{label}.modal.run
D1_DATABASE_ID=<id-from-step-2>
R2_BUCKET_NAME=valet-storage
ALLOWED_EMAILS=you@example.com
```

`PAGES_PROJECT_NAME` must be unique across all of Cloudflare Pages -- pick something like `valet-yourname`. The project is created automatically on first deploy.

`MODAL_BACKEND_URL` uses `{label}` as a placeholder -- the Makefile substitutes endpoint names at deploy time. Use the format `https://<workspace>--{label}.modal.run`.

### Worker Secrets

These are sensitive values stored in Cloudflare, not in your repo:

```bash
cd packages/worker

# Required
npx wrangler secret put ENCRYPTION_KEY        # Any string, 32+ characters
npx wrangler secret put GITHUB_CLIENT_ID      # From your GitHub OAuth app
npx wrangler secret put GITHUB_CLIENT_SECRET   # From your GitHub OAuth app
npx wrangler secret put FRONTEND_URL           # Your Pages URL, e.g. https://my-valet.pages.dev

# Optional -- needed for Google OAuth sign-in and Google integrations
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET

# Optional -- fallback LLM keys (users can also set org-level keys in the UI)
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GOOGLE_API_KEY

cd ../..
```

### Modal Auth

```bash
modal token set
# Paste your token ID and secret from modal.com > Settings > API Tokens
```

## Step 4: Deploy

```bash
make deploy
```

This deploys all three components:

1. **Cloudflare Worker** -- API and Durable Objects
2. **Modal backend** -- sandbox orchestration (create, hibernate, restore, terminate)
3. **Cloudflare Pages** -- frontend (builds with `vite`, then deploys)

On first deploy, also run D1 migrations to create the database tables:

```bash
make _wrangler-config && cd packages/worker && wrangler d1 migrations apply valet-db --remote -c wrangler.deploy.toml
```

Visit your Pages URL and sign in with GitHub.

## Individual Deployments

For incremental updates, you don't need the full deploy:

```bash
make deploy-worker        # Cloudflare Worker only
make deploy-modal         # Modal backend only (sandbox orchestration)
make deploy-client        # Frontend only (builds + deploys to Pages)
make deploy               # All three (worker + modal + client)
```

There's also `make release`, which runs a more comprehensive pipeline: install, typecheck, build and push the OpenCode Docker image to GHCR, deploy Worker, run D1 migrations, and deploy Pages. Note that `make release` does **not** deploy the Modal backend -- use `make deploy` or `make deploy-modal` for that.

## Forcing a Sandbox Image Rebuild

Sandbox images are built and cached by Modal (defined in `backend/images/base.py`). To force a rebuild after changing `docker/` or `packages/runner/`:

1. Bump `IMAGE_BUILD_VERSION` in `backend/images/base.py`
2. Redeploy: `make deploy-modal`
3. New sessions will use the updated image (existing sandboxes are not affected)

## Quick Reference

| What | Where |
|------|-------|
| Worker URL | `https://<name>.<subdomain>.workers.dev` |
| Frontend URL | `https://<pages-project>.pages.dev` |
| Modal dashboard | `https://modal.com/apps/<workspace>/main/deployed/valet-backend` |
| D1 console | Cloudflare dashboard > Workers & Pages > D1 |
| Worker logs | `wrangler tail` (from `packages/worker/`) |
| Worker secrets | `wrangler secret list` (from `packages/worker/`) |
