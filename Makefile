.DEFAULT_GOAL := help
.PHONY: help install build db db-stop seed dev admin test lint typecheck check eval-offline eval-smoke eval-real summary docker-build docker-up clean

PNPM ?= COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm
export DATABASE_URL ?= postgresql://switchboard:switchboard@127.0.0.1:55480/switchboard
export TEST_DATABASE_URL ?= postgresql://switchboard:switchboard@127.0.0.1:55480/switchboard_test
MODEL ?= nvidia/nemotron-3-super-120b-a12b:free
FALLBACKS ?= nvidia/nemotron-3-ultra-550b-a55b:free
SB = node packages/cli/dist/main.js

help:  ## Show the targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install:  ## Install dependencies (pnpm through corepack)
	$(PNPM) install

build:  ## Compile every package (tsc -b)
	$(PNPM) build

db:  ## PostgreSQL 17 on 127.0.0.1:55480 with a test database
	docker run -d --name switchboard-dev-db -e POSTGRES_USER=switchboard -e POSTGRES_PASSWORD=switchboard -e POSTGRES_DB=switchboard \
		-p 127.0.0.1:55480:5432 postgres:17-alpine
	@until docker exec switchboard-dev-db pg_isready -U switchboard >/dev/null 2>&1; do sleep 1; done
	docker exec switchboard-dev-db psql -U switchboard -c "CREATE DATABASE switchboard_test" || true

db-stop:  ## Remove the local database container
	docker rm -f switchboard-dev-db

seed: build  ## Schema, Kestrel Cloud demo data, read-only analytics role
	$(SB) seed

dev: build  ## Servers on 7101-7105 and the gateway on 8080 (seeds on first start)
	$(SB) dev

admin:  ## Admin console on http://localhost:3000 (needs the gateway)
	$(PNPM) --filter @switchboard/admin dev

test: build  ## All tests (database tests need TEST_DATABASE_URL, e.g. make db)
	$(PNPM) test

lint:  ## ESLint (typed) for the packages and the admin console
	$(PNPM) lint

typecheck:  ## tsc for packages, tests and the admin console
	$(PNPM) typecheck

check: lint typecheck test  ## Everything CI runs except docker

eval-offline: build  ## Every task with the deterministic offline model (no API calls)
	$(SB) eval run --name fake --provider fake
	$(SB) eval run --name fake_gullible --provider fake --gullible

eval-smoke: build  ## Free models with tool calling, and one call each (needs OPENROUTER_API_KEY)
	$(SB) eval free-models
	$(SB) eval smoke --models $(MODEL),$(FALLBACKS)

eval-real: build  ## Main run, ablation and model comparison with free models (needs OPENROUTER_API_KEY, about 400 calls)
	$(SB) eval run --name main --provider openrouter --model $(MODEL) --fallbacks $(FALLBACKS)
	$(SB) eval run --name ablation_all_tools --subset --expose-all --provider openrouter --model $(MODEL) --fallbacks $(FALLBACKS)
	$(SB) eval run --name model_ling_3_flash --subset --provider openrouter --model inclusionai/ling-3.0-flash-sante:free
	$(SB) eval run --name model_dots_3 --subset --provider openrouter --model dots-studio/dots-3-note-preview:free

summary:  ## results/summary.json and results/calls_summary.json
	$(SB) eval summary
	$(SB) eval ledger

docker-build:  ## Build both images
	docker compose build

docker-up:  ## Everything in Docker: console :3000, gateway :8080
	docker compose up --build

clean:  ## Remove build output and caches (keeps results/)
	rm -rf packages/*/dist apps/admin/.next .cache
