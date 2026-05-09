#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

# ─── Config ──────────────────────────────────────────────────────────────────

# Source deploy config if it exists
if [ -f .env.deploy ]; then
    set -a; source .env.deploy; set +a
fi

: "${PROJECT_NAME:?Set PROJECT_NAME in .env.deploy (e.g. valet-yourname)}"

# Derived names (all overridable via .env.deploy)
CF_WORKER_NAME="${CF_WORKER_NAME:-$PROJECT_NAME}"
PAGES_PROJECT_NAME="${PAGES_PROJECT_NAME:-${PROJECT_NAME}-client}"
D1_DATABASE_NAME="${D1_DATABASE_NAME:-${PROJECT_NAME}-db}"
R2_BUCKET_NAME="${R2_BUCKET_NAME:-${PROJECT_NAME}-storage}"
ALLOWED_EMAILS="${ALLOWED_EMAILS:-}"
MODAL_DEPLOY_CMD="${MODAL_DEPLOY_CMD:-uv run --project backend modal deploy}"

# ─── Shared Helpers ──────────────────────────────────────────────────────────

# Discover D1 database ID. Fails if DB doesn't exist.
discover_d1_id() {
    _resolve_d1_id
    if [ -z "${D1_DATABASE_ID:-}" ] || [ "$D1_DATABASE_ID" = "null" ]; then
        echo -e "${RED}Could not discover D1 database ID for '${D1_DATABASE_NAME}'.${NC}"
        echo "Run: wrangler d1 create ${D1_DATABASE_NAME}"
        exit 1
    fi
    echo -e "${GREEN}✓ D1: ${D1_DATABASE_NAME} (${D1_DATABASE_ID})${NC}"
}

# Discover or create D1 database. Used by cmd_all for first-time setup.
ensure_d1() {
    _resolve_d1_id
    if [ -z "${D1_DATABASE_ID:-}" ] || [ "$D1_DATABASE_ID" = "null" ]; then
        echo "  Creating ${D1_DATABASE_NAME}..."
        wrangler d1 create "$D1_DATABASE_NAME" >/dev/null
        D1_DATABASE_ID=$(wrangler d1 list --json \
            | jq -r --arg name "$D1_DATABASE_NAME" '.[] | select(.name==$name) | .uuid')
    fi
    echo -e "${GREEN}✓ D1: ${D1_DATABASE_NAME} (${D1_DATABASE_ID})${NC}"
}

# Internal: resolve D1_DATABASE_ID from wrangler if not already set.
_resolve_d1_id() {
    if [ -z "${D1_DATABASE_ID:-}" ] || [ "${D1_DATABASE_ID}" = "your-d1-database-id" ]; then
        D1_DATABASE_ID=$(wrangler d1 list --json 2>/dev/null \
            | jq -r --arg name "$D1_DATABASE_NAME" '.[] | select(.name==$name) | .uuid' 2>/dev/null) || true
    fi
}

# Discover Modal backend URL. Required=true (default) exits on failure;
# required=false warns and leaves MODAL_BACKEND_URL empty.
discover_modal_url() {
    local required="${1:-true}"
    if [ -z "${MODAL_BACKEND_URL:-}" ]; then
        if ! command -v modal >/dev/null 2>&1; then
            if [ "$required" = "true" ]; then
                echo -e "${RED}modal CLI not found. Install: uv tool install modal${NC}"; exit 1
            else
                echo -e "${YELLOW}modal CLI not found — MODAL_BACKEND_URL will be empty${NC}"
                MODAL_BACKEND_URL=""
                return
            fi
        fi
        MODAL_WS=$(modal profile current 2>/dev/null | head -1 | awk '{print $1}') || true
        if [ -z "${MODAL_WS:-}" ]; then
            if [ "$required" = "true" ]; then
                echo -e "${RED}Cannot detect Modal workspace. Run: modal token set${NC}"; exit 1
            else
                echo -e "${YELLOW}Cannot detect Modal workspace — MODAL_BACKEND_URL will be empty${NC}"
                MODAL_BACKEND_URL=""
                return
            fi
        fi
        MODAL_BACKEND_URL="https://${MODAL_WS}--{label}.modal.run"
        echo -e "${GREEN}✓ Modal (workspace: ${MODAL_WS})${NC}"
    else
        echo -e "${GREEN}✓ Modal URL: ${MODAL_BACKEND_URL}${NC}"
    fi
}

generate_wrangler_config() {
    sed -e "s|\${CF_WORKER_NAME}|${CF_WORKER_NAME}|g" \
        -e "s|\${D1_DATABASE_NAME}|${D1_DATABASE_NAME}|g" \
        -e "s|\${D1_DATABASE_ID}|${D1_DATABASE_ID}|g" \
        -e "s|\${R2_BUCKET_NAME}|${R2_BUCKET_NAME}|g" \
        -e "s|\${ALLOWED_EMAILS}|${ALLOWED_EMAILS}|g" \
        -e "s|\${MODAL_BACKEND_URL}|${MODAL_BACKEND_URL}|g" \
        packages/worker/wrangler.toml > packages/worker/wrangler.deploy.toml
}

cleanup_wrangler_config() {
    rm -f packages/worker/wrangler.deploy.toml
}
trap cleanup_wrangler_config EXIT

preflight() {
    echo "Preflight..."
    for cmd in "$@"; do
        command -v "$cmd" >/dev/null || { echo -e "${RED}${cmd} not found${NC}"; exit 1; }
    done
    wrangler whoami >/dev/null 2>&1 || { echo -e "${RED}Not logged into Cloudflare. Run: wrangler login${NC}"; exit 1; }
    echo -e "${GREEN}✓ Cloudflare${NC}"
}

# ─── Subcommands ─────────────────────────────────────────────────────────────

cmd_worker() {
    echo -e "${GREEN}Deploying Worker...${NC}"
    preflight wrangler jq bun
    discover_d1_id
    discover_modal_url
    echo ""

    # Generate registries
    (cd packages/worker && bun scripts/generate-plugin-registry.ts)

    # Generate config and deploy
    generate_wrangler_config
    DEPLOY_OUT=$(cd packages/worker && wrangler deploy -c wrangler.deploy.toml 2>&1) || {
        echo -e "${RED}Worker deploy failed:${NC}"
        echo "$DEPLOY_OUT"
        exit 1
    }
    echo "$DEPLOY_OUT"

    # Capture worker URL from deploy output
    WORKER_URL=$(echo "$DEPLOY_OUT" | grep -o 'https://[^ ]*\.workers\.dev' | head -1) || true
    if [ -z "${WORKER_URL:-}" ]; then
        WORKER_URL="https://${CF_WORKER_NAME}.workers.dev"
    fi
    echo -e "${GREEN}✓ Worker: ${WORKER_URL}${NC}"
}

cmd_migrate() {
    echo -e "${GREEN}Applying D1 migrations...${NC}"
    preflight wrangler jq
    discover_d1_id
    discover_modal_url false
    echo ""

    generate_wrangler_config
    (cd packages/worker && wrangler d1 migrations apply "$D1_DATABASE_NAME" --remote -c wrangler.deploy.toml)
    echo -e "${GREEN}✓ Migrations applied${NC}"
}

cmd_modal() {
    echo -e "${GREEN}Deploying Modal backend...${NC}"
    $MODAL_DEPLOY_CMD backend/app.py
    echo -e "${GREEN}✓ Modal backend deployed${NC}"
}

cmd_client() {
    echo -e "${GREEN}Building and deploying client...${NC}"
    preflight wrangler pnpm

    # Discover worker URL: use WORKER_PROD_URL override, or ask wrangler for the deployed URL
    if [ -n "${WORKER_PROD_URL:-}" ]; then
        WORKER_URL="${WORKER_PROD_URL}"
    else
        # Try to get the URL from the existing deployment
        WORKER_URL=$(wrangler deployments list --name "${CF_WORKER_NAME}" 2>/dev/null \
            | grep -o 'https://[^ ]*\.workers\.dev' | head -1) || true
        if [ -z "${WORKER_URL:-}" ]; then
            # Fall back to subdomain discovery via wrangler deploy --dry-run isn't available,
            # so use the standard pattern. The user can override with WORKER_PROD_URL.
            echo -e "${YELLOW}Could not auto-detect worker URL. Using https://${CF_WORKER_NAME}.workers.dev${NC}"
            echo -e "${YELLOW}Set WORKER_PROD_URL in .env.deploy if this is wrong.${NC}"
            WORKER_URL="https://${CF_WORKER_NAME}.workers.dev"
        fi
    fi
    echo -e "${GREEN}✓ Using API URL: ${WORKER_URL}/api${NC}"
    echo ""

    (cd packages/client && VITE_API_URL="${WORKER_URL}/api" pnpm run build)
    (cd packages/client && wrangler pages deploy dist --project-name="$PAGES_PROJECT_NAME")
    echo -e "${GREEN}✓ Client deployed: https://${PAGES_PROJECT_NAME}.pages.dev${NC}"
}

cmd_all() {
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Deploying ${PROJECT_NAME}${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""

    preflight wrangler jq pnpm bun
    discover_modal_url

    # --- Step 1: Ensure D1 database ---
    echo "Step 1/7: D1 database..."
    ensure_d1

    # --- Step 2: Ensure R2 bucket ---
    echo ""
    echo "Step 2/7: R2 bucket..."
    if ! wrangler r2 bucket list 2>/dev/null | grep -q "$R2_BUCKET_NAME"; then
        echo "  Creating ${R2_BUCKET_NAME}..."
        wrangler r2 bucket create "$R2_BUCKET_NAME" >/dev/null
    fi
    echo -e "${GREEN}✓ R2: ${R2_BUCKET_NAME}${NC}"

    # --- Step 3: Build packages ---
    echo ""
    echo "Step 3/7: Building packages..."
    pnpm --filter '@valet/*' --filter '!@valet/worker' --filter '!@valet/client' run build
    echo -e "${GREEN}✓ Packages built${NC}"

    # --- Step 4: Deploy Worker ---
    echo ""
    echo "Step 4/7: Deploying Worker..."
    (cd packages/worker && bun scripts/generate-plugin-registry.ts)
    generate_wrangler_config

    DEPLOY_OUT=$(cd packages/worker && wrangler deploy -c wrangler.deploy.toml 2>&1) || {
        echo -e "${RED}Worker deploy failed:${NC}"
        echo "$DEPLOY_OUT"
        exit 1
    }
    echo "$DEPLOY_OUT"

    WORKER_URL=$(echo "$DEPLOY_OUT" | grep -o 'https://[^ ]*\.workers\.dev' | head -1) || true
    if [ -z "${WORKER_URL:-}" ]; then
        WORKER_URL="https://${CF_WORKER_NAME}.workers.dev"
    fi
    echo -e "${GREEN}✓ Worker: ${WORKER_URL}${NC}"

    # --- Step 5: Run D1 migrations ---
    echo ""
    echo "Step 5/7: Running migrations..."
    (cd packages/worker && wrangler d1 migrations apply "$D1_DATABASE_NAME" --remote -c wrangler.deploy.toml)
    echo -e "${GREEN}✓ Migrations applied${NC}"

    # --- Step 6: Deploy Modal backend ---
    echo ""
    echo "Step 6/7: Deploying Modal backend..."
    $MODAL_DEPLOY_CMD backend/app.py
    echo -e "${GREEN}✓ Modal backend deployed${NC}"

    # --- Step 7: Build and deploy client ---
    echo ""
    echo "Step 7/7: Building and deploying client..."
    (cd packages/client && VITE_API_URL="${WORKER_URL}/api" pnpm run build)
    (cd packages/client && wrangler pages deploy dist --project-name="$PAGES_PROJECT_NAME")
    echo -e "${GREEN}✓ Client deployed${NC}"

    # --- Summary ---
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Deploy complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo "  Worker:  ${WORKER_URL}"
    echo "  Client:  https://${PAGES_PROJECT_NAME}.pages.dev"
    echo ""
    echo -e "${YELLOW}If this is your first deploy, set worker secrets:${NC}"
    echo "  wrangler secret put ENCRYPTION_KEY --name ${CF_WORKER_NAME}"
    echo "  wrangler secret put GITHUB_CLIENT_ID --name ${CF_WORKER_NAME}"
    echo "  wrangler secret put GITHUB_CLIENT_SECRET --name ${CF_WORKER_NAME}"
    echo "  wrangler secret put FRONTEND_URL --name ${CF_WORKER_NAME}"
}

# ─── Dispatch ────────────────────────────────────────────────────────────────

COMMAND="${1:-all}"
shift || true

case "$COMMAND" in
    worker)   cmd_worker "$@" ;;
    migrate)  cmd_migrate "$@" ;;
    modal)    cmd_modal "$@" ;;
    client)   cmd_client "$@" ;;
    all)      cmd_all "$@" ;;
    *)
        echo "Usage: $0 {worker|migrate|modal|client|all}"
        echo ""
        echo "  worker   - Deploy Cloudflare Worker (generates registries, discovers config)"
        echo "  migrate  - Apply D1 migrations to production"
        echo "  modal    - Deploy Modal backend"
        echo "  client   - Build and deploy client to Cloudflare Pages"
        echo "  all      - Full deploy (default): all of the above"
        exit 1
        ;;
esac
