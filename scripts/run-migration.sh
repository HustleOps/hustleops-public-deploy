#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.prod.yml"
MANIFEST_FILE="$PROJECT_ROOT/release-manifest.json"
TIMEOUT_SECONDS=600

usage() {
  cat <<'EOF'
Usage: ./scripts/run-migration.sh [--env-file PATH] [--compose-file PATH] [--manifest-file PATH] [--timeout-seconds SECONDS]

Run the one-shot backend migration service and write a release-linked migration
success marker only after Prisma reports a successful or no-op migration.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '==> %s\n' "$*"
}

print_sanitized_output() {
  sed -E 's#(postgres(ql)?://[^:/[:space:]]+):[^@[:space:]]+@#\1:***@#g' "$1"
}

resolve_path() {
  local value="$1"

  if [[ "$value" = /* ]]; then
    printf '%s\n' "$value"
    return
  fi

  printf '%s\n' "$PWD/${value#./}"
}

write_success_marker() {
  local output_file="$1"
  local exit_code="$2"

  node "$SCRIPT_DIR/lib/migration-marker.mjs" write-success \
    --manifest-file "$MANIFEST_FILE" \
    --output-file "$output_file" \
    --timeout-seconds "$TIMEOUT_SECONDS" \
    --exit-code "$exit_code"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ $# -ge 2 ]] || fail "Missing value for --env-file."
      ENV_FILE="$2"
      shift 2
      ;;
    --compose-file)
      [[ $# -ge 2 ]] || fail "Missing value for --compose-file."
      COMPOSE_FILE="$2"
      shift 2
      ;;
    --manifest-file)
      [[ $# -ge 2 ]] || fail "Missing value for --manifest-file."
      MANIFEST_FILE="$2"
      shift 2
      ;;
    --timeout-seconds)
      [[ $# -ge 2 ]] || fail "Missing value for --timeout-seconds."
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

[[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || fail "--timeout-seconds must be a positive integer."
[[ "$TIMEOUT_SECONDS" -gt 0 ]] || fail "--timeout-seconds must be greater than zero."

command -v docker >/dev/null 2>&1 || fail "docker must be installed and on PATH."
command -v node >/dev/null 2>&1 || fail "node must be installed and on PATH."
command -v timeout >/dev/null 2>&1 || fail "timeout must be installed and on PATH."

ENV_FILE="$(resolve_path "$ENV_FILE")"
COMPOSE_FILE="$(resolve_path "$COMPOSE_FILE")"
MANIFEST_FILE="$(resolve_path "$MANIFEST_FILE")"

[[ -f "$ENV_FILE" ]] || fail "Env file not found: $ENV_FILE"
[[ -f "$COMPOSE_FILE" ]] || fail "Compose file not found: $COMPOSE_FILE"
[[ -f "$MANIFEST_FILE" ]] || fail "Release manifest file not found: $MANIFEST_FILE"

output_file="$(mktemp)"
cleanup() {
  rm -f "$output_file"
}
trap cleanup EXIT

note "Running backend migration service"
set +e
timeout "$TIMEOUT_SECONDS" docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  --profile migration \
  run \
  -T \
  backend-migrate </dev/null 2>&1 | tee "$output_file"
exit_code=${PIPESTATUS[0]}
set -e

# Remove the stopped migration container explicitly; --rm can hang on cleanup
docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  --profile migration \
  rm -f backend-migrate >/dev/null 2>&1 || true

if [[ "$exit_code" -eq 124 ]]; then
  fail "Migration timed out after $TIMEOUT_SECONDS seconds."
fi

if [[ "$exit_code" -ne 0 ]]; then
  fail "Migration failed with exit code $exit_code."
fi

write_success_marker "$output_file" "$exit_code"
note "Migration completed successfully"
