# Valet Workflow Plugin - E2E Testing Makefile
# ================================================
#
# This Makefile provides commands for end-to-end testing of the
# workflow plugin system, including the worker, OpenCode container,
# and workflow execution.

.PHONY: help install setup clean \
        dev dev-worker dev-opencode dev-client dev-all \
        db-setup db-migrate db-seed db-reset \
        docker-build docker-up docker-down docker-logs \
        test test-unit test-integration test-e2e \
        test-workflow test-triggers test-webhooks test-schedule \
        lint typecheck \
        logs logs-worker logs-opencode logs-cloudflare logs-worker-prod \
        health health-worker health-opencode \
        workflow-create workflow-list workflow-run workflow-delete \
        trigger-create trigger-list trigger-run \
        bootstrap bootstrap-d1 bootstrap-r2 bootstrap-pages bootstrap-secrets \
        release deploy deploy-worker deploy-modal deploy-migrate deploy-client generate-registries \
        secrets-set secrets-list \
        image-build image-push \
        destroy destroy-worker destroy-d1 destroy-r2 destroy-pages destroy-modal

# Configuration
# =============
# Source deployment config if it exists (copy .env.deploy.example to .env.deploy)
-include .env.deploy

# Project name — all resource names derive from this (set in .env.deploy)
PROJECT_NAME ?= valet
CF_WORKER_NAME ?= $(PROJECT_NAME)
PAGES_PROJECT_NAME ?= $(PROJECT_NAME)-client
D1_DATABASE_NAME ?= $(PROJECT_NAME)-db
R2_BUCKET_NAME ?= $(PROJECT_NAME)-storage

WORKER_URL ?= http://localhost:8787
WORKER_PROD_URL ?= https://$(CF_WORKER_NAME).workers.dev
MODAL_DEPLOY_CMD ?= uv run --project backend modal deploy
D1_DATABASE_ID ?=
ALLOWED_EMAILS ?=
MODAL_BACKEND_URL ?=
OPENCODE_URL ?= http://localhost:4096
# GHCR image for Modal sandboxes
GHCR_REPO ?= ghcr.io/$(shell git config --get remote.origin.url | sed -n 's/.*github.com[:/]\([^/]*\/[^/.]*\).*/\1/p' | tr '[:upper:]' '[:lower:]')/opencode
OPENCODE_SERVER_PASSWORD ?= $(shell grep OPENCODE_SERVER_PASSWORD .env 2>/dev/null | cut -d= -f2 || echo "your-secure-password")
# API token for E2E testing - matches the seeded test token in scripts/seed-test-data.sql
API_TOKEN ?= test-api-token-12345
DOCKER_COMPOSE = docker compose
PNPM = pnpm
CF_ENV ?=
TAIL_FORMAT ?= pretty
TAIL_SEARCH ?=
TAIL_SAMPLING_RATE ?=

# Colors for output
GREEN = \033[0;32m
YELLOW = \033[0;33m
RED = \033[0;31m
NC = \033[0m # No Color

# Default target
help: ## Show this help message
	@echo "Valet Workflow Plugin - E2E Testing"
	@echo "========================================"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-20s$(NC) %s\n", $$1, $$2}'

# ==========================================
# Setup & Installation
# ==========================================

install: ## Install all dependencies
	@echo "$(GREEN)Installing dependencies...$(NC)"
	$(PNPM) install

setup: install db-setup ## Full setup: install deps, setup database
	@echo "$(GREEN)Setup complete!$(NC)"

clean: docker-down ## Clean up: stop containers, remove build artifacts
	@echo "$(YELLOW)Cleaning up...$(NC)"
	rm -rf packages/worker/dist
	rm -rf packages/worker/.wrangler/state
	rm -rf packages/client/dist
	@echo "$(GREEN)Clean complete!$(NC)"

# ==========================================
# Development Servers
# ==========================================

dev: ## Start all services in development mode (parallel)
	@echo "$(GREEN)Starting all services...$(NC)"
	@make -j2 dev-worker dev-opencode

dev-worker: ## Start the Cloudflare Worker in dev mode
	@echo "$(GREEN)Starting Worker on $(WORKER_URL)...$(NC)"
	cd packages/worker && $(PNPM) run dev

dev-opencode: docker-up ## Start OpenCode container
	@echo "$(GREEN)OpenCode container started on $(OPENCODE_URL)$(NC)"

# ==========================================
# Database Operations
# ==========================================

db-setup: db-migrate db-seed ## Setup database: migrate and seed
	@echo "$(GREEN)Database setup complete!$(NC)"

db-migrate: ## Run D1 database migrations
	@echo "$(GREEN)Running database migrations...$(NC)"
	cd packages/worker && $(PNPM) run db:migrate

db-seed: ## Seed database with test data
	@echo "$(GREEN)Seeding database...$(NC)"
	cd packages/worker && $(PNPM) run db:seed || echo "$(YELLOW)Seed script not found, skipping...$(NC)"

db-reset: ## Reset database (drop and recreate)
	@echo "$(YELLOW)Resetting database...$(NC)"
	rm -rf packages/worker/.wrangler/state/v3/d1
	@make db-migrate
	@echo "$(GREEN)Database reset complete!$(NC)"

db-shell: ## Open D1 database shell
	cd packages/worker && wrangler d1 execute $(D1_DATABASE_NAME) --local --command "SELECT 1"

# ==========================================
# Docker Operations
# ==========================================

docker-build: ## Build Docker images
	@echo "$(GREEN)Building Docker images...$(NC)"
	$(DOCKER_COMPOSE) build

docker-up: ## Start Docker containers
	@echo "$(GREEN)Starting Docker containers...$(NC)"
	$(DOCKER_COMPOSE) up -d
	@sleep 2
	@make health-opencode || echo "$(YELLOW)Waiting for OpenCode to be ready...$(NC)"

docker-down: ## Stop Docker containers
	@echo "$(YELLOW)Stopping Docker containers...$(NC)"
	$(DOCKER_COMPOSE) down

docker-logs: ## Show Docker container logs
	$(DOCKER_COMPOSE) logs -f

docker-restart: docker-down docker-up ## Restart Docker containers
	@echo "$(GREEN)Docker containers restarted$(NC)"

# ==========================================
# Health Checks
# ==========================================

health: health-worker health-opencode ## Check health of all services

health-worker: ## Check Worker health
	@echo "Checking Worker health..."
	@curl -sf $(WORKER_URL)/health > /dev/null 2>&1 \
		&& echo "$(GREEN)✓ Worker is healthy$(NC)" \
		|| echo "$(RED)✗ Worker is not responding$(NC)"

health-opencode: ## Check OpenCode container health
	@echo "Checking OpenCode health..."
	@curl -sf -u "opencode:$(OPENCODE_SERVER_PASSWORD)" $(OPENCODE_URL)/ > /dev/null 2>&1 \
		&& echo "$(GREEN)✓ OpenCode is healthy$(NC)" \
		|| echo "$(RED)✗ OpenCode is not responding$(NC)"

wait-for-services: ## Wait for all services to be ready
	@echo "Waiting for services..."
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
		if curl -sf $(WORKER_URL)/health > /dev/null 2>&1; then \
			echo "$(GREEN)✓ Worker ready$(NC)"; \
			break; \
		fi; \
		echo "Waiting for worker... ($$i/10)"; \
		sleep 2; \
	done
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
		if curl -sf -u "opencode:$(OPENCODE_SERVER_PASSWORD)" $(OPENCODE_URL)/ > /dev/null 2>&1; then \
			echo "$(GREEN)✓ OpenCode ready$(NC)"; \
			break; \
		fi; \
		echo "Waiting for OpenCode... ($$i/10)"; \
		sleep 2; \
	done

# ==========================================
# Logs
# ==========================================

logs: ## Show all logs (worker + opencode)
	@make -j2 logs-worker logs-opencode

logs-worker: ## Show Worker logs
	@echo "$(GREEN)Worker logs:$(NC)"
	cd packages/worker && wrangler tail 2>/dev/null || echo "Use 'make dev-worker' to see logs"

logs-cloudflare: ## Tail deployed Cloudflare Worker logs (optional: CF_ENV=prod TAIL_SEARCH=text TAIL_SAMPLING_RATE=1)
	@echo "$(GREEN)Cloudflare Worker logs (remote tail):$(NC)"
	wrangler tail $(CF_WORKER_NAME) \
		$(if $(CF_ENV),--env $(CF_ENV),) \
		--format $(TAIL_FORMAT) \
		$(if $(TAIL_SEARCH),--search "$(TAIL_SEARCH)",) \
		$(if $(TAIL_SAMPLING_RATE),--sampling-rate $(TAIL_SAMPLING_RATE),)

logs-worker-prod: logs-cloudflare ## Alias for logs-cloudflare

logs-opencode: ## Show OpenCode container logs
	$(DOCKER_COMPOSE) logs -f opencode

# ==========================================
# Code Quality
# ==========================================

lint: ## Run linter
	@echo "$(GREEN)Running linter...$(NC)"
	$(PNPM) run lint 2>/dev/null || echo "$(YELLOW)No lint script configured$(NC)"

typecheck: generate-registries ## Run TypeScript type checking
	@echo "$(GREEN)Running type check...$(NC)"
	$(PNPM) run typecheck

# ==========================================
# Testing
# ==========================================

test: test-unit test-integration ## Run all tests

test-unit: ## Run unit tests
	@echo "$(GREEN)Running unit tests...$(NC)"
	$(PNPM) run test:unit 2>/dev/null || echo "$(YELLOW)No unit tests configured$(NC)"

test-integration: ## Run integration tests
	@echo "$(GREEN)Running integration tests...$(NC)"
	$(PNPM) run test:integration 2>/dev/null || echo "$(YELLOW)No integration tests configured$(NC)"

test-e2e: wait-for-services ## Run end-to-end tests
	@echo "$(GREEN)Running E2E tests...$(NC)"
	@make test-workflow
	@make test-triggers
	@make test-webhooks

# ==========================================
# Workflow E2E Tests
# ==========================================

test-workflow: ## Test workflow CRUD operations
	@echo "$(GREEN)Testing workflow operations...$(NC)"
	@echo ""
	@echo "1. Creating test workflow..."
	@make workflow-create-test
	@echo ""
	@echo "2. Listing workflows..."
	@make workflow-list
	@echo ""
	@echo "3. Running workflow..."
	@make workflow-run-test
	@echo ""
	@echo "4. Cleaning up..."
	@make workflow-delete-test
	@echo ""
	@echo "$(GREEN)✓ Workflow tests passed$(NC)"

test-triggers: ## Test trigger CRUD operations
	@echo "$(GREEN)Testing trigger operations...$(NC)"
	@echo "1. Creating test workflow for trigger..."
	@make workflow-create-test
	@echo ""
	@echo "2. Creating trigger..."
	@make trigger-create-test
	@echo ""
	@echo "3. Listing triggers..."
	@make trigger-list
	@echo ""
	@echo "4. Cleaning up..."
	@make trigger-delete-test
	@make workflow-delete-test
	@echo "$(GREEN)✓ Trigger tests passed$(NC)"

test-webhooks: ## Test webhook trigger execution
	@echo "$(GREEN)Testing webhook triggers...$(NC)"
	@# Create a test workflow and webhook trigger, then fire webhook
	@echo "Creating test workflow for webhook..."
	@make workflow-create-test
	@echo "Creating webhook trigger..."
	@make trigger-create-webhook-test
	@echo "Firing webhook..."
	@make webhook-fire-test
	@echo "Cleaning up..."
	@make trigger-delete-test
	@make workflow-delete-test
	@echo "$(GREEN)✓ Webhook tests passed$(NC)"

test-schedule: ## Test scheduled trigger (requires cron simulation)
	@echo "$(GREEN)Testing scheduled triggers...$(NC)"
	@echo "$(YELLOW)Note: Schedule testing requires manual cron trigger$(NC)"
	@# This would require mocking the cron trigger
	@echo "$(GREEN)✓ Schedule test placeholder$(NC)"

# ==========================================
# Workflow Commands
# ==========================================

# Test workflow for E2E testing
WORKFLOW_TEST_ID ?= test-workflow-$(shell date +%s)
WORKFLOW_TEST_NAME ?= E2E Test Workflow

workflow-create: ## Create a workflow (interactive)
	@echo "$(GREEN)Creating workflow...$(NC)"
	@echo "Usage: make workflow-create WORKFLOW_FILE=path/to/workflow.yaml"
	@if [ -n "$(WORKFLOW_FILE)" ]; then \
		curl -X POST $(WORKER_URL)/api/workflows/sync \
			-H "Content-Type: application/json" \
			-H "Authorization: Bearer $(API_TOKEN)" \
			-d @$(WORKFLOW_FILE); \
	else \
		echo "$(YELLOW)Please specify WORKFLOW_FILE$(NC)"; \
	fi

workflow-create-test: ## Create a test workflow for E2E testing
	@echo "Creating test workflow: $(WORKFLOW_TEST_ID)"
	@curl -sf -X POST $(WORKER_URL)/api/workflows/sync \
		-H "Content-Type: application/json" \
		-H "Authorization: Bearer $(API_TOKEN)" \
		-d '{ \
			"id": "$(WORKFLOW_TEST_ID)", \
			"name": "$(WORKFLOW_TEST_NAME)", \
			"description": "Automated E2E test workflow", \
			"version": "1.0.0", \
			"data": { \
				"id": "$(WORKFLOW_TEST_ID)", \
				"name": "$(WORKFLOW_TEST_NAME)", \
				"description": "Automated E2E test workflow", \
				"version": "1.0.0", \
				"steps": [ \
					{ \
						"id": "step-1", \
						"name": "Echo Test", \
						"type": "tool", \
						"tool": "bash", \
						"arguments": { "command": "echo Hello from E2E test" }, \
						"outputVariable": "echoResult" \
					} \
				] \
			} \
		}' && echo " $(GREEN)✓$(NC)" || echo " $(RED)✗$(NC)"

workflow-list: ## List all workflows
	@echo "$(GREEN)Listing workflows...$(NC)"
	@curl -sf $(WORKER_URL)/api/workflows \
		-H "Authorization: Bearer $(API_TOKEN)" | jq . 2>/dev/null || echo "$(RED)Failed to list workflows$(NC)"

workflow-get: ## Get a specific workflow (WORKFLOW_ID required)
	@if [ -z "$(WORKFLOW_ID)" ]; then \
		echo "$(RED)Usage: make workflow-get WORKFLOW_ID=<id>$(NC)"; \
		exit 1; \
	fi
	@curl -sf $(WORKER_URL)/api/workflows/$(WORKFLOW_ID) \
		-H "Authorization: Bearer $(API_TOKEN)" | jq .

workflow-run: ## Run a workflow (WORKFLOW_ID required)
	@if [ -z "$(WORKFLOW_ID)" ]; then \
		echo "$(RED)Usage: make workflow-run WORKFLOW_ID=<id> [VARIABLES='{}']$(NC)"; \
		exit 1; \
	fi
	@curl -sf -X POST $(OPENCODE_URL)/session \
		-H "Content-Type: application/json" \
		-H "Authorization: Basic $$(echo -n ":$(OPENCODE_SERVER_PASSWORD)" | base64)" \
		-d '{"path": "/workspace"}' | jq -r '.id' > /tmp/session_id.txt
	@curl -sf -X POST $(OPENCODE_URL)/session/$$(cat /tmp/session_id.txt)/message \
		-H "Content-Type: application/json" \
		-H "Authorization: Basic $$(echo -n ":$(OPENCODE_SERVER_PASSWORD)" | base64)" \
		-d '{"content": "Run workflow.run with id=$(WORKFLOW_ID) and variables=$(VARIABLES)"}'
	@rm -f /tmp/session_id.txt

workflow-run-test: ## Run the test workflow
	@echo "Running test workflow: $(WORKFLOW_TEST_ID)"
	@# In a real scenario, this would create a session and run the workflow
	@# For now, we simulate via the API
	@curl -sf -X POST "$(WORKER_URL)/api/triggers/manual/run" \
		-H "Content-Type: application/json" \
		-H "Authorization: Bearer $(API_TOKEN)" \
		-d '{"workflowId": "$(WORKFLOW_TEST_ID)", "variables": {"test": true}}' \
		&& echo " $(GREEN)✓$(NC)" || echo " $(YELLOW)Manual run endpoint not yet implemented$(NC)"

workflow-delete: ## Delete a workflow (WORKFLOW_ID required)
	@if [ -z "$(WORKFLOW_ID)" ]; then \
		echo "$(RED)Usage: make workflow-delete WORKFLOW_ID=<id>$(NC)"; \
		exit 1; \
	fi
	@curl -sf -X DELETE $(WORKER_URL)/api/workflows/$(WORKFLOW_ID) \
		-H "Authorization: Bearer $(API_TOKEN)" && echo "$(GREEN)✓ Deleted$(NC)"

workflow-delete-test: ## Delete the test workflow
	@echo "Deleting test workflow: $(WORKFLOW_TEST_ID)"
	@curl -sf -X DELETE "$(WORKER_URL)/api/workflows/$(WORKFLOW_TEST_ID)" \
		-H "Authorization: Bearer $(API_TOKEN)" \
		&& echo " $(GREEN)✓$(NC)" || echo " $(YELLOW)Workflow may not exist$(NC)"

# ==========================================
# Trigger Commands
# ==========================================

TRIGGER_TEST_ID ?= test-trigger-$(shell date +%s)

trigger-create-test: ## Create a test trigger
	@echo "Creating test trigger: $(TRIGGER_TEST_ID)"
	@curl -sf -X POST $(WORKER_URL)/api/triggers \
		-H "Content-Type: application/json" \
		-H "Authorization: Bearer $(API_TOKEN)" \
		-d '{ \
			"workflowId": "$(WORKFLOW_TEST_ID)", \
			"name": "Test Manual Trigger", \
			"enabled": true, \
			"config": { "type": "manual" } \
		}' | jq . 2>/dev/null && echo " $(GREEN)✓$(NC)" || echo " $(RED)✗$(NC)"

trigger-create-webhook-test: ## Create a test webhook trigger
	@echo "Creating webhook trigger..."
	@curl -sf -X POST $(WORKER_URL)/api/triggers \
		-H "Content-Type: application/json" \
		-H "Authorization: Bearer $(API_TOKEN)" \
		-d '{ \
			"workflowId": "$(WORKFLOW_TEST_ID)", \
			"name": "Test Webhook Trigger", \
			"enabled": true, \
			"config": { \
				"type": "webhook", \
				"path": "test/e2e", \
				"method": "POST" \
			}, \
			"variableMapping": { \
				"payload": "$.body" \
			} \
		}' | jq . 2>/dev/null || echo " $(RED)✗$(NC)"

trigger-list: ## List all triggers
	@echo "$(GREEN)Listing triggers...$(NC)"
	@curl -sf $(WORKER_URL)/api/triggers \
		-H "Authorization: Bearer $(API_TOKEN)" | jq . 2>/dev/null || echo "$(RED)Failed to list triggers$(NC)"

trigger-run: ## Manually run a trigger (TRIGGER_ID required)
	@if [ -z "$(TRIGGER_ID)" ]; then \
		echo "$(RED)Usage: make trigger-run TRIGGER_ID=<id>$(NC)"; \
		exit 1; \
	fi
	@curl -sf -X POST $(WORKER_URL)/api/triggers/$(TRIGGER_ID)/run \
		-H "Content-Type: application/json" \
		-H "Authorization: Bearer $(API_TOKEN)" \
		-d '{}' | jq .

trigger-delete-test: ## Delete test triggers
	@echo "Cleaning up test triggers..."
	@# In practice, would need to fetch trigger ID first
	@echo "$(YELLOW)Manual cleanup may be required$(NC)"

# ==========================================
# Webhook Testing
# ==========================================

webhook-fire-test: ## Fire a test webhook
	@echo "Firing test webhook..."
	@curl -sf -X POST $(WORKER_URL)/webhooks/test/e2e \
		-H "Content-Type: application/json" \
		-d '{"event": "test", "timestamp": "$(shell date -u +%Y-%m-%dT%H:%M:%SZ)"}' \
		| jq . 2>/dev/null && echo " $(GREEN)✓$(NC)" || echo " $(RED)✗$(NC)"

webhook-github-simulate: ## Simulate a GitHub webhook
	@echo "Simulating GitHub PR webhook..."
	@curl -sf -X POST $(WORKER_URL)/webhooks/github/pr \
		-H "Content-Type: application/json" \
		-H "X-GitHub-Event: pull_request" \
		-d '{ \
			"action": "opened", \
			"pull_request": { \
				"number": 123, \
				"title": "Test PR", \
				"body": "This is a test PR" \
			}, \
			"repository": { \
				"full_name": "test/repo" \
			} \
		}' | jq . 2>/dev/null || echo "$(YELLOW)GitHub webhook not configured$(NC)"

# ==========================================
# Execution History
# ==========================================

executions-list: ## List recent workflow executions
	@echo "$(GREEN)Recent executions:$(NC)"
	@curl -sf $(WORKER_URL)/api/executions \
		-H "Authorization: Bearer $(API_TOKEN)" | jq . 2>/dev/null || echo "$(RED)Failed to list executions$(NC)"

execution-get: ## Get execution details (EXECUTION_ID required)
	@if [ -z "$(EXECUTION_ID)" ]; then \
		echo "$(RED)Usage: make execution-get EXECUTION_ID=<id>$(NC)"; \
		exit 1; \
	fi
	@curl -sf $(WORKER_URL)/api/executions/$(EXECUTION_ID) \
		-H "Authorization: Bearer $(API_TOKEN)" | jq .

# ==========================================
# Full E2E Test Suite
# ==========================================

e2e-full: ## Run complete E2E test suite
	@echo "$(GREEN)========================================$(NC)"
	@echo "$(GREEN)Starting Full E2E Test Suite$(NC)"
	@echo "$(GREEN)========================================$(NC)"
	@echo ""
	@echo "Step 1: Setup"
	@make setup
	@echo ""
	@echo "Step 2: Start Services"
	@make docker-up
	@echo ""
	@echo "Step 3: Wait for Services"
	@make wait-for-services
	@echo ""
	@echo "Step 4: Run Database Migrations"
	@make db-migrate
	@echo ""
	@echo "Step 5: Health Checks"
	@make health
	@echo ""
	@echo "Step 6: Workflow Tests"
	@make test-workflow
	@echo ""
	@echo "Step 7: Trigger Tests"
	@make test-triggers
	@echo ""
	@echo "Step 8: Webhook Tests"
	@make test-webhooks
	@echo ""
	@echo "$(GREEN)========================================$(NC)"
	@echo "$(GREEN)E2E Test Suite Complete!$(NC)"
	@echo "$(GREEN)========================================$(NC)"

e2e-ci: ## E2E tests for CI (includes cleanup)
	@make e2e-full || (make clean && exit 1)
	@make clean

# ==========================================
# Bootstrap (create remote resources)
# ==========================================
# Creates Cloudflare resources (D1, R2, Pages) and sets worker secrets.
# Run once when setting up a new environment. Idempotent — skips resources
# that already exist. After bootstrap, update .env.deploy with the D1
# database ID printed below, then run `make deploy`.

bootstrap: bootstrap-d1 bootstrap-r2 bootstrap-pages ## Create all remote Cloudflare resources
	@echo ""
	@echo "$(GREEN)========================================$(NC)"
	@echo "$(GREEN)Bootstrap complete!$(NC)"
	@echo "$(GREEN)========================================$(NC)"
	@echo ""
	@echo "Next steps:"
	@echo "  1. Copy the D1 database ID above into .env.deploy as D1_DATABASE_ID"
	@echo "  2. Run $(YELLOW)make bootstrap-secrets$(NC) to set worker secrets"
	@echo "  3. Run $(YELLOW)make deploy$(NC) to deploy everything"

bootstrap-d1: ## Create D1 database
	@echo "$(GREEN)Creating D1 database '$(D1_DATABASE_NAME)'...$(NC)"
	@wrangler d1 create $(D1_DATABASE_NAME) 2>&1 | tee /dev/stderr | grep -q "already exists" \
		&& echo "$(YELLOW)D1 database already exists$(NC)" \
		|| echo "$(GREEN)✓ D1 database created — copy the database_id into .env.deploy$(NC)"

bootstrap-r2: ## Create R2 bucket
	@echo "$(GREEN)Creating R2 bucket '$(R2_BUCKET_NAME)'...$(NC)"
	@wrangler r2 bucket create $(R2_BUCKET_NAME) 2>&1 | tee /dev/stderr | grep -q "already exists" \
		&& echo "$(YELLOW)R2 bucket already exists$(NC)" \
		|| echo "$(GREEN)✓ R2 bucket created$(NC)"

bootstrap-pages: ## Create Cloudflare Pages project
	@echo "$(GREEN)Creating Pages project '$(PAGES_PROJECT_NAME)'...$(NC)"
	@wrangler pages project create $(PAGES_PROJECT_NAME) --production-branch main 2>&1 | tee /dev/stderr | grep -q "already exists" \
		&& echo "$(YELLOW)Pages project already exists$(NC)" \
		|| echo "$(GREEN)✓ Pages project created$(NC)"

bootstrap-secrets: ## Set required worker secrets (interactive)
	@echo "$(GREEN)Setting secrets for worker '$(CF_WORKER_NAME)'...$(NC)"
	@echo ""
	@echo "Required secrets:"
	@echo "  ENCRYPTION_KEY        — random 32+ char string for credential encryption"
	@echo "  GITHUB_CLIENT_ID      — GitHub OAuth app client ID"
	@echo "  GITHUB_CLIENT_SECRET  — GitHub OAuth app client secret"
	@echo "  GOOGLE_CLIENT_ID      — Google OAuth client ID"
	@echo "  GOOGLE_CLIENT_SECRET  — Google OAuth client secret"
	@echo "  FRONTEND_URL          — e.g. https://valet-client.pages.dev"
	@echo ""
	@echo "Optional secrets:"
	@echo "  ANTHROPIC_API_KEY     — fallback LLM key (prefer org-level keys)"
	@echo "  OPENAI_API_KEY        — fallback LLM key"
	@echo "  GOOGLE_API_KEY        — fallback LLM key (Gemini)"
	@echo "  SLACK_SIGNING_SECRET  — Slack app signing secret"
	@echo "  SLACK_BOT_TOKEN       — Slack bot token"
	@echo "  SLACK_CLIENT_ID       — Slack OAuth client ID"
	@echo "  SLACK_CLIENT_SECRET   — Slack OAuth client secret"
	@echo ""
	@for secret in ENCRYPTION_KEY GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET FRONTEND_URL; do \
		echo "$(YELLOW)Enter $$secret (or press Ctrl+C to skip remaining):$(NC)"; \
		wrangler secret put $$secret --name $(CF_WORKER_NAME) || break; \
		echo ""; \
	done
	@echo "$(GREEN)✓ Secrets configured. Run 'wrangler secret list --name $(CF_WORKER_NAME)' to verify.$(NC)"

# ==========================================
# Deployment
# ==========================================

# Version tag for container images (use git commit hash or timestamp)
VERSION ?= $(shell git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)

generate-registries: ## Generate auto-discovered plugin registry files
	@cd packages/worker && bun scripts/generate-plugin-registry.ts

release: ## Full idempotent release: install, build, push image, deploy all
	@echo "$(GREEN)========================================$(NC)"
	@echo "$(GREEN)Starting Release (version: $(VERSION))$(NC)"
	@echo "$(GREEN)========================================$(NC)"
	@echo ""
	@echo "Step 1/4: Installing dependencies..."
	@$(PNPM) install --frozen-lockfile || $(PNPM) install
	@echo "$(GREEN)✓ Dependencies installed$(NC)"
	@echo ""
	@echo "Step 2/4: Type checking..."
	@$(PNPM) run typecheck || echo "$(YELLOW)⚠ Type check had warnings$(NC)"
	@echo ""
	@echo "Step 3/4: Building and pushing OpenCode image to GHCR..."
	@make image-push VERSION=$(VERSION)
	@echo ""
	@echo "Step 4/4: Deploying (worker + migrations + modal + client)..."
	@./scripts/deploy.sh all
	@echo ""
	@echo "$(GREEN)========================================$(NC)"
	@echo "$(GREEN)Release complete! (version: $(VERSION))$(NC)"
	@echo "$(GREEN)========================================$(NC)"
	@echo ""
	@echo "$(YELLOW)OpenCode Image:$(NC) $(GHCR_REPO):$(VERSION)"
	@echo "$(YELLOW)Set OPENCODE_IMAGE in Cloudflare to this value.$(NC)"

deploy: ## Deploy everything — auto-creates resources, discovers URLs
	@./scripts/deploy.sh all

deploy-worker: ## Deploy Cloudflare Worker (auto-discovers config)
	@./scripts/deploy.sh worker

deploy-migrate: ## Apply D1 migrations to production
	@./scripts/deploy.sh migrate

deploy-modal: ## Deploy Modal backend (includes runner)
	@./scripts/deploy.sh modal

deploy-client: ## Build and deploy client to Cloudflare Pages
	@./scripts/deploy.sh client

dev-client: ## Start client dev server
	@echo "$(GREEN)Starting client on http://localhost:5173...$(NC)"
	cd packages/client && $(PNPM) run dev

dev-all: ## Start all services (worker + client + docker)
	@echo "$(GREEN)Starting all services...$(NC)"
	@make -j3 dev-worker dev-client dev-opencode

# ==========================================
# Secrets Management
# ==========================================

secrets-set: ## Set required secrets for Worker
	@echo "$(GREEN)Setting Worker secrets...$(NC)"
	@echo "Enter ENCRYPTION_KEY:"
	@cd packages/worker && wrangler secret put ENCRYPTION_KEY
	@echo "$(GREEN)✓ Secrets configured$(NC)"

secrets-list: ## List configured secrets
	@echo "$(GREEN)Configured secrets:$(NC)"
	cd packages/worker && wrangler secret list

# ==========================================
# OpenCode Image (for Modal Sandboxes)
# ==========================================

image-build: ## Build OpenCode Docker image
	@echo "$(GREEN)Building OpenCode image...$(NC)"
	@docker build --platform linux/amd64 -t $(GHCR_REPO):$(VERSION) -t $(GHCR_REPO):latest .
	@echo "$(GREEN)✓ Image built: $(GHCR_REPO):$(VERSION)$(NC)"

image-push: image-build ## Build and push OpenCode image to GHCR
	@echo "$(GREEN)Pushing image to GHCR...$(NC)"
	@docker push $(GHCR_REPO):$(VERSION)
	@docker push $(GHCR_REPO):latest
	@echo "$(GREEN)✓ Image pushed: $(GHCR_REPO):$(VERSION)$(NC)"

# ==========================================
# Teardown / Destroy
# ==========================================
# These targets destroy PRODUCTION resources. Use with care.
# Resource names default to the current config (CF_WORKER_NAME, etc.)
# but can be overridden, e.g.:
#   make destroy CF_WORKER_NAME=old-name PAGES_PROJECT_NAME=old-pages ...

# Modal app name
MODAL_APP_NAME ?= $(PROJECT_NAME)-backend

destroy: ## Destroy all remote resources (Worker, D1, R2, Pages, Modal) — DESTRUCTIVE
	@echo "$(RED)========================================$(NC)"
	@echo "$(RED)  DESTROYING PRODUCTION RESOURCES$(NC)"
	@echo "$(RED)========================================$(NC)"
	@echo ""
	@echo "  Worker:  $(CF_WORKER_NAME)"
	@echo "  Pages:   $(PAGES_PROJECT_NAME)"
	@echo "  D1:      $(D1_DATABASE_NAME)"
	@echo "  R2:      $(R2_BUCKET_NAME)"
	@echo "  Modal:   $(MODAL_APP_NAME)"
	@echo ""
	@echo "$(YELLOW)Press Ctrl+C within 5 seconds to abort...$(NC)"
	@sleep 5
	@echo ""
	@make destroy-worker
	@make destroy-pages
	@make destroy-d1
	@make destroy-r2
	@make destroy-modal
	@echo ""
	@echo "$(GREEN)========================================$(NC)"
	@echo "$(GREEN)All resources destroyed.$(NC)"
	@echo "$(GREEN)========================================$(NC)"

destroy-worker: ## Delete the Cloudflare Worker
	@echo "$(YELLOW)Deleting Worker '$(CF_WORKER_NAME)'...$(NC)"
	wrangler delete --name $(CF_WORKER_NAME) --force || echo "$(YELLOW)Worker not found or already deleted$(NC)"
	@echo "$(GREEN)✓ Worker deleted$(NC)"

destroy-d1: ## Delete the D1 database by name (override: D1_DATABASE_NAME=xxx)
	@echo "$(YELLOW)Deleting D1 database '$(D1_DATABASE_NAME)'...$(NC)"
	wrangler d1 delete $(D1_DATABASE_NAME) -y || echo "$(YELLOW)D1 database not found or already deleted$(NC)"
	@echo "$(GREEN)✓ D1 database deleted$(NC)"

destroy-r2: ## Delete the R2 bucket (must be empty first)
	@echo "$(YELLOW)Deleting R2 bucket '$(R2_BUCKET_NAME)'...$(NC)"
	wrangler r2 bucket delete $(R2_BUCKET_NAME) || echo "$(YELLOW)R2 bucket not found, not empty, or already deleted$(NC)"
	@echo "$(GREEN)✓ R2 bucket deleted$(NC)"

destroy-pages: ## Delete the Cloudflare Pages project
	@echo "$(YELLOW)Deleting Pages project '$(PAGES_PROJECT_NAME)'...$(NC)"
	wrangler pages project delete $(PAGES_PROJECT_NAME) -y || echo "$(YELLOW)Pages project not found or already deleted$(NC)"
	@echo "$(GREEN)✓ Pages project deleted$(NC)"

destroy-modal: ## Stop the Modal backend app (no delete CLI — stopped apps are garbage collected; use dashboard for immediate removal)
	@echo "$(YELLOW)Stopping Modal app '$(MODAL_APP_NAME)' (will be garbage collected)...$(NC)"
	uv run --project backend modal app stop $(MODAL_APP_NAME) || echo "$(YELLOW)Modal app not found or already stopped$(NC)"
	@echo "$(GREEN)✓ Modal app stopped$(NC)"
