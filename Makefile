# Makefile for warehouse-floor-client: thin wrappers over npm so `make check` works in every fleet repo.
.PHONY: help install lint typecheck test build docs check check-all check-fast dev stub-api e2e image
help:
	@echo "targets: install lint typecheck test build docs check check-all check-fast dev stub-api e2e image"
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
docs:
	npm run docs:check
check: lint typecheck test build docs
check-all: check
# Fast local gate (the same one an agent Stop hook would run).
check-fast: lint typecheck

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
# Needs the sibling checkout: ../warehouse-ui-kit
image:
	docker build --build-context uikit=../warehouse-ui-kit -t warehouse-floor-client .
