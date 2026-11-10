# Makefile for warehouse-floor-client: thin wrappers over npm so `make check` works in every fleet repo.
.PHONY: help install lint typecheck test build docs check check-all check-fast guide-lint harness-test dev stub-api e2e image
help:
	@echo "targets: install lint typecheck test build docs check check-all check-fast guide-lint harness-test dev stub-api e2e image"
install:
	npm ci
lint:
	npm run lint
typecheck:
	npm run typecheck
test:
	npm test
build:
	npm run build
# Docusaurus site in docs/ (the CI `docs` job runs the same three steps).
docs:
	cd docs && npm ci && npm run typecheck && npm run build
check: lint typecheck test build docs
check-all: check
# Fast local gate: the agent Stop hook (scripts/harness/hook.py stop) runs it.
check-fast: lint typecheck

# --- agent harness (harness-template v4) -----------------------------------
guide-lint: ## lint agent guides: skills load, references resolve, context budget
	python3 scripts/harness/guide_lint.py

harness-test: ## unit-test the agent hooks (pre/post/stop) and the red-issue helper
	python3 scripts/harness/test_hook.py
	python3 scripts/harness/test_red_issue.py
	python3 scripts/harness/test_repo_lint.py

# Dev server (:5174) proxying /api to Kong (http://localhost:8000). Override with FLOOR_API_TARGET=...
dev:
	npm run dev
# In-memory stand-in for fulfillment-execution on :8787, shaped from its OpenAPI examples.
# Use with: FLOOR_API_TARGET=http://localhost:8787 make dev
stub-api:
	npm run stub-api
# Drive the station flow in headless Chromium against E2E_BASE (default http://localhost:5174).
e2e:
	npm run e2e:station
	npm run e2e:receiving
	npm run e2e:yard
# Needs the sibling checkout: ../warehouse-ui-kit
image:
	docker build --build-context uikit=../warehouse-ui-kit -t warehouse-floor-client .
