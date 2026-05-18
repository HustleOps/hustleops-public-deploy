#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.prod.yml"
MANIFEST_FILE="$PROJECT_ROOT/release-manifest.json"
VERIFICATION_FILE="$PROJECT_ROOT/release-verification.json"
DEPLOYMENT_TRIGGER_FILE="$PROJECT_ROOT/deployment/release-trigger.txt"
SKIP_PULL=0
SKIP_SIGNATURE_VERIFY=0
PREFLIGHT_VERBOSITY=1
SIGNATURE_PLAN_FILE=""

usage() {
  cat <<'EOF'
Usage: ./scripts/preflight.sh [--env-file PATH] [--compose-file PATH] [--manifest-file PATH] [--verification-file PATH] [--skip-pull] [--skip-signature-verify] [--verbosity N|--verbose|--quiet|--debug]

Validate populated deployment env, image signatures, digest-pinned image refs,
and compose profiles before running migration/bootstrap in production.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

missing_required_tools=()

record_missing_tool() {
  local command_name="$1"
  local description="$2"
  local install_hint="$3"

  if command -v "$command_name" >/dev/null 2>&1; then
    return 0
  fi

  missing_required_tools+=("$command_name|$description|$install_hint")
}

print_missing_tool_guidance() {
  local entry command_name description install_hint answer

  [[ "${#missing_required_tools[@]}" -gt 0 ]] || return 0

  printf 'ERROR: Missing required tools:\n' >&2
  for entry in "${missing_required_tools[@]}"; do
    IFS='|' read -r command_name description install_hint <<< "$entry"
    printf '  - %s: %s\n' "$command_name" "$description" >&2
    printf '    Install: %s\n' "$install_hint" >&2
  done

  if [[ -t 0 ]]; then
    printf 'Install missing tools now? [y/N] ' >&2
    read -r answer
    case "$answer" in
      y|Y|yes|YES)
        printf 'Run the install commands above, then re-run preflight.\n' >&2
        ;;
      *)
        printf 'Aborted until required tools are installed.\n' >&2
        ;;
    esac
  fi

  exit 1
}

record_common_tool_requirements() {
  record_missing_tool \
    docker \
    "Docker Engine with Docker Compose v2 is required to run the deployment stack." \
    "macOS: install Docker Desktop; Linux: install Docker Engine and the Compose plugin from https://docs.docker.com/engine/install/"

  record_missing_tool \
    node \
    "Node.js 24 or newer is required for release metadata and env validation scripts." \
    "macOS: brew install node@24; Linux: install Node.js 24 from https://nodejs.org/"
}

record_cosign_requirement() {
  record_missing_tool \
    cosign \
    "cosign is required for release image signature verification." \
    "macOS: brew install cosign; Linux: install from https://docs.sigstore.dev/cosign/installation/"
}

note() {
  [[ "$PREFLIGHT_VERBOSITY" -ge 1 ]] || return 0
  printf '==> %s\n' "$*"
}

debug_note() {
  [[ "$PREFLIGHT_VERBOSITY" -ge 3 ]] || return 0
  printf '[debug] %s\n' "$*"
}

resolve_path() {
  local value="$1"

  if [[ "$value" = /* ]]; then
    printf '%s\n' "$value"
    return
  fi

  printf '%s\n' "$PWD/${value#./}"
}

normalize_value() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c '[:alnum:]' '_'
}

contains_placeholder() {
  local normalized
  normalized="$(normalize_value "$1")"
  [[ "$normalized" == *change_me* || "$normalized" == *placeholder* || "$1" == __*__ ]]
}

trim() {
  local value="$1"

  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

load_env_file() {
  local line key value

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*# ]] || [[ -z "${line//[[:space:]]/}" ]]; then
      continue
    fi

    key="$(trim "${line%%=*}")"
    value="$(trim "${line#*=}")"

    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      fail "Invalid env line in $ENV_FILE: $line"
    fi

    if [[ "$value" =~ ^".*"$ || "$value" =~ ^'.*'$ ]]; then
      value="${value:1:${#value}-2}"
    fi

    export "$key=$value"
  done < "$ENV_FILE"
}

require_var() {
  local name="$1"
  local value="${!name-}"

  [[ -n "$value" ]] || fail "$name is required in $ENV_FILE."
}

require_non_placeholder() {
  local name="$1"
  local value="${!name}"

  if contains_placeholder "$value"; then
    fail "$name must not use placeholder values."
  fi
}

validate_min_length() {
  local name="$1"
  local minimum="$2"
  local value="${!name}"

  [[ ${#value} -ge $minimum ]] || fail "$name must be at least $minimum characters long."
}

validate_hex_64() {
  local name="$1"
  local value="${!name}"

  [[ "$value" =~ ^[0-9a-fA-F]{64}$ ]] || fail "$name must be exactly 64 hexadecimal characters."
}

validate_cors_origin() {
  local value="$CORS_ORIGIN"

  [[ "$value" =~ ^https?:// ]] || fail "CORS_ORIGIN must start with http:// or https://."
  [[ "$value" != *example.com* ]] || fail "CORS_ORIGIN must not use example.com placeholder hostnames."
  if contains_placeholder "$value"; then
    fail "CORS_ORIGIN must not use placeholder values."
  fi
}

resolve_project_path() {
  local value="$1"

  if [[ "$value" = /* ]]; then
    printf '%s\n' "$value"
    return
  fi

  printf '%s\n' "$PROJECT_ROOT/${value#./}"
}

validate_nginx_tls_files() {
  local cert_path key_path cert_file key_file

  cert_path="${NGINX_TLS_CERT_PATH:-./nginx/certs/fullchain.pem}"
  key_path="${NGINX_TLS_KEY_PATH:-./nginx/certs/privkey.pem}"
  cert_file="$(resolve_project_path "$cert_path")"
  key_file="$(resolve_project_path "$key_path")"

  [[ -f "$cert_file" ]] || fail "nginx TLS certificate file not found: $cert_file"
  [[ -r "$cert_file" ]] || fail "nginx TLS certificate file is not readable: $cert_file"
  [[ -f "$key_file" ]] || fail "nginx TLS private key file not found: $key_file"
  [[ -r "$key_file" ]] || fail "nginx TLS private key file is not readable: $key_file"
}

validate_bootstrap_email() {
  local value="${BOOTSTRAP_ADMIN_EMAIL-}"

  [[ -z "$value" ]] && return
  [[ "$value" == *"@"* ]] || fail "BOOTSTRAP_ADMIN_EMAIL must look like an email address."
  if contains_placeholder "$value"; then
    fail "BOOTSTRAP_ADMIN_EMAIL must not use placeholder values."
  fi
}

validate_env() {
  local required_plain=(
    POSTGRES_PASSWORD
    REDIS_PASSWORD
    OPENSEARCH_ADMIN_PASSWORD
    N8N_POSTGRES_PASSWORD
    N8N_REDIS_PASSWORD
    N8N_ENCRYPTION_KEY
    N8N_RUNNERS_AUTH_TOKEN
    HUSTLEOPS_RELEASE_TAG
    HUSTLEOPS_RELEASE_TRIGGER
    NGINX_TLS_CERT_PATH
    NGINX_TLS_KEY_PATH
  )
  local name

  for name in "${required_plain[@]}"; do
    require_var "$name"
    require_non_placeholder "$name"
  done

  require_var JWT_ACCESS_SECRET
  require_var JWT_REFRESH_SECRET
  require_var TWO_FACTOR_ENCRYPTION_KEY
  require_var BOOTSTRAP_ADMIN_PASSWORD
  require_var CORS_ORIGIN

  require_non_placeholder JWT_ACCESS_SECRET
  require_non_placeholder JWT_REFRESH_SECRET
  require_non_placeholder TWO_FACTOR_ENCRYPTION_KEY
  require_non_placeholder BOOTSTRAP_ADMIN_PASSWORD

  validate_min_length JWT_ACCESS_SECRET 32
  validate_min_length JWT_REFRESH_SECRET 32
  [[ "$JWT_ACCESS_SECRET" != "$JWT_REFRESH_SECRET" ]] || fail "JWT access and refresh secrets must differ."

  validate_hex_64 TWO_FACTOR_ENCRYPTION_KEY
  validate_min_length BOOTSTRAP_ADMIN_PASSWORD 16
  validate_cors_origin
  validate_bootstrap_email
  validate_nginx_tls_files
}

pull_image() {
  local image_ref="$1"

  if [[ "$PREFLIGHT_VERBOSITY" -ge 3 ]]; then
    docker pull --platform linux/amd64 "$image_ref"
  else
    docker pull --platform linux/amd64 "$image_ref" >/dev/null
  fi
}

run_pull_checks() {
  local image_ref certificate_identity issuer

  note "Pulling pinned release images"
  [[ -n "$SIGNATURE_PLAN_FILE" ]] || fail "Image plan was not generated."

  while IFS=$'\t' read -r image_ref certificate_identity issuer; do
    [[ -n "$image_ref" ]] || continue
    pull_image "$image_ref"
  done < "$SIGNATURE_PLAN_FILE"
}

validate_release_metadata() {
  local args=(
    "$PROJECT_ROOT/scripts/validate-release-metadata.mjs"
    --env-file "$ENV_FILE"
    --compose-file "$COMPOSE_FILE"
    --manifest-file "$MANIFEST_FILE"
    --verification-file "$VERIFICATION_FILE"
    --deployment-trigger-file "$DEPLOYMENT_TRIGGER_FILE"
    --release-dir "$PROJECT_ROOT/releases"
  )

  note "Validating release metadata"
  SIGNATURE_PLAN_FILE="$(mktemp)"
  args+=(--signature-plan-file "$SIGNATURE_PLAN_FILE")

  node "${args[@]}"
}

run_signature_checks() {
  local image_ref certificate_identity issuer

  note "Verifying release image signatures"
  [[ -n "$SIGNATURE_PLAN_FILE" ]] || fail "Signature plan was not generated."

  while IFS=$'\t' read -r image_ref certificate_identity issuer; do
    [[ -n "$image_ref" ]] || continue
    if ! cosign verify \
      --certificate-identity "$certificate_identity" \
      --certificate-oidc-issuer "$issuer" \
      "$image_ref" >/dev/null; then
      fail "Signature verification failed for $image_ref."
    fi
  done < "$SIGNATURE_PLAN_FILE"
}

run_compose_checks() {
  note "Rendering compose config"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config >/dev/null
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile migration config >/dev/null
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile bootstrap config >/dev/null
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile ancillary-public config >/dev/null
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
    --verification-file)
      [[ $# -ge 2 ]] || fail "Missing value for --verification-file."
      VERIFICATION_FILE="$2"
      shift 2
      ;;
    --skip-pull)
      SKIP_PULL=1
      shift
      ;;
    --skip-signature-verify)
      SKIP_SIGNATURE_VERIFY=1
      shift
      ;;
    --verbosity)
      [[ $# -ge 2 ]] || fail "Missing value for --verbosity."
      [[ "$2" =~ ^[0-3]$ ]] || fail "--verbosity must be 0, 1, 2, or 3."
      PREFLIGHT_VERBOSITY="$2"
      shift 2
      ;;
    --verbose)
      PREFLIGHT_VERBOSITY=2
      shift
      ;;
    --quiet)
      PREFLIGHT_VERBOSITY=0
      shift
      ;;
    --debug)
      PREFLIGHT_VERBOSITY=3
      shift
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

ENV_FILE="$(resolve_path "$ENV_FILE")"
COMPOSE_FILE="$(resolve_path "$COMPOSE_FILE")"
MANIFEST_FILE="$(resolve_path "$MANIFEST_FILE")"
VERIFICATION_FILE="$(resolve_path "$VERIFICATION_FILE")"

[[ "$PREFLIGHT_VERBOSITY" -ge 3 ]] && set -x

[[ -f "$ENV_FILE" ]] || fail "Env file not found: $ENV_FILE"
[[ -f "$COMPOSE_FILE" ]] || fail "Compose file not found: $COMPOSE_FILE"

load_env_file
validate_env

missing_required_tools=()
record_common_tool_requirements
if [[ $SKIP_SIGNATURE_VERIFY -eq 0 ]]; then
  record_cosign_requirement
fi
print_missing_tool_guidance

[[ -f "$MANIFEST_FILE" ]] || fail "Release manifest file not found: $MANIFEST_FILE"
[[ -f "$VERIFICATION_FILE" ]] || fail "Release verification file not found: $VERIFICATION_FILE"
[[ -f "$DEPLOYMENT_TRIGGER_FILE" ]] || fail "Deployment trigger file not found: $DEPLOYMENT_TRIGGER_FILE"

cleanup() {
  if [[ -n "$SIGNATURE_PLAN_FILE" ]]; then
    rm -f "$SIGNATURE_PLAN_FILE"
  fi
}
trap cleanup EXIT

validate_release_metadata

if [[ $SKIP_SIGNATURE_VERIFY -eq 0 ]]; then
  run_signature_checks
else
  note "Skipping signature verification (--skip-signature-verify)"
fi

if [[ $SKIP_PULL -eq 0 ]]; then
  run_pull_checks
else
  note "Skipping image pulls"
fi

run_compose_checks
note "Preflight checks passed"
