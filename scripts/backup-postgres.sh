#!/usr/bin/env bash

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.prod.yml"
OUTPUT_DIR="$PROJECT_ROOT/backups"
RELEASE_TAG=""
POSTGRES_USER=""
POSTGRES_DB=""
HUSTLEOPS_RELEASE_TAG=""

usage() {
  cat <<'EOF'
Usage: ./scripts/backup-postgres.sh [--env-file PATH] [--compose-file PATH] [--output-dir PATH] [--tag RELEASE_TAG]

Capture a custom-format PostgreSQL backup from the deployed postgres service.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '==> %s\n' "$*"
}

trim() {
  local value="$1"

  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

resolve_path() {
  local value="$1"

  if [[ "$value" = /* ]]; then
    printf '%s\n' "$value"
    return
  fi

  printf '%s\n' "$PWD/${value#./}"
}

sanitize_filename_part() {
  printf '%s' "$1" | sed -E 's/[^[:alnum:]._-]+/_/g; s/[[:space:]]+/_/g'
}

load_env_metadata() {
  local line key value

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*# ]] || [[ -z "${line//[[:space:]]/}" ]]; then
      continue
    fi

    key="$(trim "${line%%=*}")"
    value="$(trim "${line#*=}")"

    if [[ "$value" =~ ^\".*\"$ || "$value" =~ ^\'.*\'$ ]]; then
      value="${value:1:${#value}-2}"
    fi

    case "$key" in
      POSTGRES_USER)
        POSTGRES_USER="$value"
        ;;
      POSTGRES_DB)
        POSTGRES_DB="$value"
        ;;
      HUSTLEOPS_RELEASE_TAG)
        HUSTLEOPS_RELEASE_TAG="$value"
        ;;
    esac
  done < "$ENV_FILE"
}

read_manifest_tag() {
  local manifest_file

  for manifest_file in \
    "$(dirname "$COMPOSE_FILE")/release-manifest.json" \
    "$(dirname "$ENV_FILE")/release-manifest.json" \
    "$PROJECT_ROOT/release-manifest.json"; do
    [[ -f "$manifest_file" ]] || continue
    command -v node >/dev/null 2>&1 || return 0

    node -e "const fs=require('node:fs'); const manifest=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (manifest.release?.tag) console.log(manifest.release.tag);" "$manifest_file"
    return 0
  done

  return 0
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
    --output-dir)
      [[ $# -ge 2 ]] || fail "Missing value for --output-dir."
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --tag)
      [[ $# -ge 2 ]] || fail "Missing value for --tag."
      RELEASE_TAG="$2"
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

command -v docker >/dev/null 2>&1 || fail "docker must be installed and on PATH."

ENV_FILE="$(resolve_path "$ENV_FILE")"
COMPOSE_FILE="$(resolve_path "$COMPOSE_FILE")"
OUTPUT_DIR="$(resolve_path "$OUTPUT_DIR")"

[[ -f "$ENV_FILE" ]] || fail "Env file not found: $ENV_FILE"
[[ -f "$COMPOSE_FILE" ]] || fail "Compose file not found: $COMPOSE_FILE"

load_env_metadata

[[ -n "$POSTGRES_USER" ]] || fail "POSTGRES_USER is required in $ENV_FILE."
[[ -n "$POSTGRES_DB" ]] || fail "POSTGRES_DB is required in $ENV_FILE."

if [[ -z "$RELEASE_TAG" ]]; then
  RELEASE_TAG="$(read_manifest_tag)"
fi

if [[ -z "$RELEASE_TAG" ]]; then
  RELEASE_TAG="$HUSTLEOPS_RELEASE_TAG"
fi

[[ -n "$RELEASE_TAG" ]] || fail "Release tag is required. Pass --tag or provide release-manifest.json."

safe_tag="$(sanitize_filename_part "$RELEASE_TAG")"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUTPUT_DIR"

note "Waiting for PostgreSQL to be ready..."
max_attempts=30
attempt=0
until docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  exec \
  -T \
  postgres \
  pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [[ "$attempt" -ge "$max_attempts" ]]; then
    fail "PostgreSQL did not become ready after ${max_attempts} seconds."
  fi
  sleep 1
done

backup_file="$(mktemp "$OUTPUT_DIR/${safe_tag}-${timestamp}.postgres.dump.XXXXXX")"
note "Capturing PostgreSQL backup for $RELEASE_TAG"
if ! docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  exec \
  -T \
  postgres \
  pg_dump \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  -Fc \
  --no-acl \
  --no-owner >"$backup_file"; then
  rm -f "$backup_file"
  fail "pg_dump failed."
fi

[[ -s "$backup_file" ]] || {
  rm -f "$backup_file"
  fail "Backup file was not created or is empty."
}

note "Backup written to $backup_file"
