#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

# ─── Config ──────────────────────────────────────────────────────────────────

# Require ENVIRONMENT to select which config file to source
: "${ENVIRONMENT:?Set ENVIRONMENT (dev|prod). Usage: ENVIRONMENT=prod $0 [command]}"

DEPLOY_CONFIG=".env.deploy.${ENVIRONMENT}"
if [ ! -f "$DEPLOY_CONFIG" ]; then
    # Migration hint for old .env.deploy users
    if [ -f .env.deploy ]; then
        echo -e "${RED}Found .env.deploy but ENVIRONMENT=${ENVIRONMENT} requires ${DEPLOY_CONFIG}${NC}"
        echo "Rename .env.deploy to .env.deploy.dev (or .env.deploy.prod) to migrate."
    else
        echo -e "${RED}Config file not found: ${DEPLOY_CONFIG}${NC}"
        echo "Copy .env.deploy.example to ${DEPLOY_CONFIG} and set PROJECT_NAME."
    fi
    exit 1
fi

set -a; source "$DEPLOY_CONFIG"; set +a

: "${PROJECT_NAME:?Set PROJECT_NAME in ${DEPLOY_CONFIG} (e.g. valet-prod)}"

# Derived names (all overridable via config file)
CF_WORKER_NAME="${CF_WORKER_NAME:-$PROJECT_NAME}"
PAGES_PROJECT_NAME="${PAGES_PROJECT_NAME:-${PROJECT_NAME}-client}"
PAGES_DEPLOY_BRANCH="${PAGES_DEPLOY_BRANCH:-main}"
FRONTEND_PREVIEW_ORIGIN_SUFFIX="${FRONTEND_PREVIEW_ORIGIN_SUFFIX:-${PAGES_PROJECT_NAME}.pages.dev}"
D1_DATABASE_NAME="${D1_DATABASE_NAME:-${PROJECT_NAME}-db}"
R2_BUCKET_NAME="${R2_BUCKET_NAME:-${PROJECT_NAME}-storage}"
MODAL_APP_NAME="${MODAL_APP_NAME:-${PROJECT_NAME}-backend}"
MODAL_LABEL_PREFIX="${MODAL_LABEL_PREFIX:-${ENVIRONMENT}-}"
ALLOWED_EMAILS="${ALLOWED_EMAILS:-}"
MODAL_DEPLOY_CMD="${MODAL_DEPLOY_CMD:-uv run --project backend modal deploy}"
API_PUBLIC_URL="${API_PUBLIC_URL:-}"

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
        MODAL_BACKEND_URL="https://${MODAL_WS}--${MODAL_LABEL_PREFIX}{label}.modal.run"
        echo -e "${GREEN}✓ Modal (workspace: ${MODAL_WS})${NC}"
    else
        echo -e "${GREEN}✓ Modal URL: ${MODAL_BACKEND_URL}${NC}"
    fi
}

resolve_worker_url() {
    if [ -n "${API_PUBLIC_URL:-}" ]; then
        WORKER_URL="${API_PUBLIC_URL}"
    else
        echo -e "${RED}API_PUBLIC_URL is required in ${DEPLOY_CONFIG}.${NC}"
        echo "Set it to the public Worker origin, e.g. https://${CF_WORKER_NAME}.<account>.workers.dev"
        exit 1
    fi
}

generate_wrangler_config() {
    sed -e "s|\${CF_WORKER_NAME}|${CF_WORKER_NAME}|g" \
        -e "s|\${D1_DATABASE_NAME}|${D1_DATABASE_NAME}|g" \
        -e "s|\${D1_DATABASE_ID}|${D1_DATABASE_ID}|g" \
        -e "s|\${R2_BUCKET_NAME}|${R2_BUCKET_NAME}|g" \
        -e "s|\${ALLOWED_EMAILS}|${ALLOWED_EMAILS}|g" \
        -e "s|\${API_PUBLIC_URL}|${API_PUBLIC_URL}|g" \
        -e "s|\${FRONTEND_PREVIEW_ORIGIN_SUFFIX}|${FRONTEND_PREVIEW_ORIGIN_SUFFIX}|g" \
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

build_client() {
    local worker_url="$1"
    local build_commit_hash
    local build_version_tag=""
    local build_args=()

    build_commit_hash=$(git rev-parse --short=12 HEAD 2>/dev/null || echo "unknown")

    if [ "${ENVIRONMENT}" = "prod" ]; then
        build_version_tag=$(git describe --tags --exact-match HEAD 2>/dev/null || true)
        if [ -z "${build_version_tag}" ] && [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then
            build_version_tag="${GITHUB_REF_NAME:-}"
        fi
    else
        build_args=(-- --mode development)
        echo -e "${YELLOW}Building client in development mode (ENVIRONMENT=${ENVIRONMENT})${NC}"
    fi

    echo -e "${GREEN}✓ Build metadata: env=${ENVIRONMENT}, commit=${build_commit_hash}${NC}"
    if [ -n "${build_version_tag}" ]; then
        echo -e "${GREEN}✓ Build version: ${build_version_tag}${NC}"
    fi

    (
        cd packages/client
        VITE_API_URL="${worker_url}/api" \
        VITE_DEPLOY_ENVIRONMENT="${ENVIRONMENT}" \
        VITE_BUILD_COMMIT_HASH="${build_commit_hash}" \
        VITE_BUILD_VERSION_TAG="${build_version_tag}" \
        pnpm run build "${build_args[@]}"
    )
}

pages_branch_alias() {
    echo "$1" \
        | tr '[:upper:]' '[:lower:]' \
        | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

pages_deployment_url() {
    if [ "$PAGES_DEPLOY_BRANCH" = "main" ]; then
        echo "https://${PAGES_PROJECT_NAME}.pages.dev"
        return
    fi

    echo "https://$(pages_branch_alias "$PAGES_DEPLOY_BRANCH").${PAGES_PROJECT_NAME}.pages.dev"
}

deploy_client_pages() {
    echo -e "${GREEN}✓ Deploying Pages branch: ${PAGES_DEPLOY_BRANCH}${NC}"
    (
        cd packages/client
        wrangler pages deploy dist \
            --project-name="$PAGES_PROJECT_NAME" \
            --branch="$PAGES_DEPLOY_BRANCH"
    )
}

# ─── Subcommands ─────────────────────────────────────────────────────────────

cmd_worker() {
    echo -e "${GREEN}Deploying Worker...${NC}"
    preflight wrangler jq bun
    discover_d1_id
    discover_modal_url
    resolve_worker_url
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
    echo -e "${GREEN}Deploying Modal backend (${MODAL_APP_NAME}, labels: ${MODAL_LABEL_PREFIX}*)...${NC}"
    MODAL_APP_NAME="$MODAL_APP_NAME" MODAL_LABEL_PREFIX="$MODAL_LABEL_PREFIX" $MODAL_DEPLOY_CMD backend/app.py
    echo -e "${GREEN}✓ Modal backend deployed (${MODAL_APP_NAME})${NC}"
}

cmd_client() {
    echo -e "${GREEN}Building and deploying client...${NC}"
    preflight wrangler pnpm

    resolve_worker_url
    echo -e "${GREEN}✓ Using API URL: ${WORKER_URL}/api${NC}"
    echo ""

    build_client "${WORKER_URL}"
    deploy_client_pages
    echo -e "${GREEN}✓ Client deployed: $(pages_deployment_url)${NC}"
}

cmd_all() {
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Deploying ${PROJECT_NAME} (${ENVIRONMENT})${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""

    preflight wrangler jq pnpm bun
    discover_modal_url
    resolve_worker_url

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
    echo -e "${GREEN}✓ Worker: ${WORKER_URL}${NC}"

    # --- Step 5: Run D1 migrations ---
    echo ""
    echo "Step 5/7: Running migrations..."
    (cd packages/worker && wrangler d1 migrations apply "$D1_DATABASE_NAME" --remote -c wrangler.deploy.toml)
    echo -e "${GREEN}✓ Migrations applied${NC}"

    # --- Step 6: Deploy Modal backend ---
    echo ""
    echo "Step 6/7: Deploying Modal backend (${MODAL_APP_NAME}, labels: ${MODAL_LABEL_PREFIX}*)..."
    MODAL_APP_NAME="$MODAL_APP_NAME" MODAL_LABEL_PREFIX="$MODAL_LABEL_PREFIX" $MODAL_DEPLOY_CMD backend/app.py
    echo -e "${GREEN}✓ Modal backend deployed (${MODAL_APP_NAME})${NC}"

    # --- Step 7: Build and deploy client ---
    echo ""
    echo "Step 7/7: Building and deploying client..."
    build_client "${WORKER_URL}"
    deploy_client_pages
    echo -e "${GREEN}✓ Client deployed${NC}"

    # --- Summary ---
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Deploy complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo "  Worker:  ${WORKER_URL}"
    echo "  Client:  $(pages_deployment_url)"
    echo ""
    echo -e "${YELLOW}If this is your first deploy, set worker secrets:${NC}"
    echo "  wrangler secret put ENCRYPTION_KEY --name ${CF_WORKER_NAME}"
    echo "  wrangler secret put GITHUB_CLIENT_ID --name ${CF_WORKER_NAME}"
    echo "  wrangler secret put GITHUB_CLIENT_SECRET --name ${CF_WORKER_NAME}"
    echo "  wrangler secret put GOOGLE_CLIENT_ID --name ${CF_WORKER_NAME}"
    echo "  wrangler secret put GOOGLE_CLIENT_SECRET --name ${CF_WORKER_NAME}"
    echo "  wrangler secret put FRONTEND_URL --name ${CF_WORKER_NAME}"
    echo ""
    echo -e "${YELLOW}Or run: ENVIRONMENT=${ENVIRONMENT} make bootstrap-secrets${NC}"
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
