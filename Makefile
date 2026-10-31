# Thin wrappers over the same commands as the root npm scripts (Go port spec §8).
#
# UNVERIFIED on the dev machine: make is not installed there (Windows, Git Bash).
# Every target runs a command that WAS run there through npm or Bash; the
# Makefile itself has never been executed. Use the npm scripts on Windows.

STATICCHECK_VERSION := v0.8.2

.PHONY: test vet fmt staticcheck lint dev-api dev-mcp demo eval smoke npm-gates docker-build compose-up

test:
	go test ./...

vet:
	go vet ./...

# gofmt -l exits 0 either way: fail when it lists a file
fmt:
	@out="$$(gofmt -l .)"; if [ -n "$$out" ]; then echo "$$out"; exit 1; fi

staticcheck:
	go run honnef.co/go/tools/cmd/staticcheck@$(STATICCHECK_VERSION) ./...

lint: vet fmt staticcheck

dev-api:
	go run ./services/api

# needs MCP_API_TOKENS, or MCP_ALLOW_NO_AUTH=1 on a loopback address
dev-mcp:
	go run ./services/mcp

# the API in mock + fixture mode whatever .env says
demo:
	MODEL_PROVIDER=mock REFERENCE_PROVIDER=fixture go run ./services/api

# live Muse Spark calls: they cost money; never in CI
eval:
	go run ./services/eval

# make smoke IMAGE=path/to/label.jpg [FDA_TERM=biogesic]
smoke:
	go run ./services/smoke $(IMAGE) $(FDA_TERM)

npm-gates:
	npm test && npm run typecheck && npm run lint

# UNVERIFIED as well: Docker is not installed on the dev machine
docker-build:
	docker build -f Dockerfile.api -t medilens-api .
	docker build -f Dockerfile.mcp -t medilens-mcp .

compose-up:
	docker compose up --build
