#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="${HUSTLEOPS_DEPLOY_PROJECT_ROOT:-$DEFAULT_PROJECT_ROOT}"
HELPER_DIR="${HUSTLEOPS_DEPLOY_SCRIPT_DIR:-$SCRIPT_DIR}"

ENV_FILE="$PROJECT_ROOT/.env"
ENV_TEMPLATE_FILE="$PROJECT_ROOT/.env.example"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.prod.yml"
MANIFEST_FILE="$PROJECT_ROOT/release-manifest.json"
VERIFICATION_FILE="$PROJECT_ROOT/release-verification.json"
BACKUP_DIR="$PROJECT_ROOT/backups"
TIMEOUT_SECONDS=600

COMMAND=""
WITH_ANCILLARY=1
SKIP_ANCILLARY=0
SKIP_N8N=0
SKIP_PULL=0
SKIP_SIGNATURE_VERIFY=0
SKIP_BACKUP=0
SKIP_BOOTSTRAP=0
NO_START=0
DRY_RUN=0
YES=0
FORCE=0
GENERATE_SELF_SIGNED_CERT=0
# Verbosity levels:
#   0 = quiet   — errors only
#   1 = normal  — step banners (default)
#   2 = verbose — step banners + notable sub-actions + commands run
#   3 = debug   — everything above + shell trace (set -x)
VERBOSITY=1
OPENSEARCH_CONTAINER_OWNER="1000:1000"
N8N_CONTAINER_OWNER="1000:1000"
BACKEND_CONTAINER_OWNER="1000:1000"

usage() {
  cat <<'EOF'
Usage: ./scripts/deploy.sh {setup|update|start|restart|stop|down|status|preflight|backup|migrate|bootstrap} [options]

Commands:
  setup       Run first-install flow: preflight, migration, bootstrap, start (no backup — fresh DB)
              Fails if PostgreSQL is already reachable (use --force to override, or use 'update' instead)
  update      Run update flow: preflight, backup, migration, bootstrap, start
  start       Start stack if it was previously stopped or down
  restart     Restart stack
  stop        Stop services (containers remain, data preserved)
  down        Stop and remove containers and networks (data volumes preserved)
  status      Show Docker Compose service status
  preflight   Run preflight checks only
  backup      Capture PostgreSQL backup only
  migrate     Run database migration only
  bootstrap   Run initial-admin bootstrap only

Options:
  --env-file PATH
  --env-template-file PATH
  --compose-file PATH
  --manifest-file PATH
  --verification-file PATH
  --backup-dir PATH
  --timeout-seconds SECONDS
  --with-ancillary  Compatibility alias; ancillary proxy now starts by default
  --skip-ancillary  Skip exposing n8n and OpenSearch Dashboards through the ancillary reverse proxy
  --skip-n8n        Skip starting n8n services (n8n, n8n-worker, n8n-postgres, n8n-redis, task-runners)
  --skip-pull
  --skip-signature-verify
  --skip-backup
  --skip-bootstrap
  --no-start
  --force
  --dry-run
  --yes
  --generate-self-signed-cert
                  Generate a self-signed nginx certificate during setup when TLS files are missing
  --verbosity N    Set verbosity level (0=quiet, 1=normal, 2=verbose, 3=debug)
  --verbose        Alias for --verbosity 2
  --quiet          Alias for --verbosity 0
  --debug          Alias for --verbosity 3
  -h, --help

The setup and update flows call scripts/preflight.sh, scripts/backup-postgres.sh,
scripts/run-migration.sh, and the backend-bootstrap Compose service.
Release metadata values are synced from .env.example into .env before
preflight; runtime images are pinned directly in docker-compose.prod.yml.
Operator-provided secrets are preserved.
EOF
}

fail() {
  local status="${2:-1}"
  printf 'ERROR: %s\n' "$1" >&2
  exit "$status"
}

# note: printed at verbosity >= 1 (normal and above)
note() {
  [[ "$VERBOSITY" -ge 1 ]] || return 0
  printf '%s\n' "$*"
}

# verbose_note: printed at verbosity >= 2 (verbose and above)
verbose_note() {
  [[ "$VERBOSITY" -ge 2 ]] || return 0
  printf '    %s\n' "$*"
}

# debug_note: printed at verbosity >= 3 (debug only)
debug_note() {
  [[ "$VERBOSITY" -ge 3 ]] || return 0
  printf '[debug] %s\n' "$*"
}

step() {
  local current="$1"
  local total="$2"
  local message="$3"

  if [[ "$VERBOSITY" -ge 2 ]]; then
    note "[$(date -u +%H:%M:%SZ)] [$current/$total] $message"
  else
    note "[$current/$total] $message"
  fi
}

resolve_path() {
  local value="$1"

  if [[ "$value" = /* ]]; then
    printf '%s\n' "$value"
    return
  fi

  printf '%s\n' "$PWD/${value#./}"
}

run_cmd() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf 'DRY RUN:'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi

  if [[ "$VERBOSITY" -ge 2 ]]; then
    printf '  + '
    printf ' %q' "$@"
    printf '\n'
  fi

  "$@"
}

path_owner_spec() {
  local path="$1"

  if stat -c '%u:%g' "$path" >/dev/null 2>&1; then
    stat -c '%u:%g' "$path"
    return
  fi

  stat -f '%u:%g' "$path"
}

run_chown_recursive() {
  local owner="$1"
  local path="$2"
  local quoted_path

  if [[ "$DRY_RUN" -eq 1 ]]; then
    run_cmd chown -R "$owner" "$path"
    return
  fi

  if [[ "$VERBOSITY" -ge 2 ]]; then
    printf '  + chown -R %q %q\n' "$owner" "$path"
  fi

  if chown -R "$owner" "$path" 2>/dev/null; then
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    if [[ "$VERBOSITY" -ge 2 ]]; then
      printf '  + sudo -n chown -R %q %q\n' "$owner" "$path"
    fi

    if sudo -n chown -R "$owner" "$path"; then
      return
    fi
  fi

  printf -v quoted_path '%q' "$path"
  fail "Cannot set ownership for $path to $owner. Run: sudo chown -R $owner $quoted_path"
}

run_rm_f() {
  local path="$1"
  local quoted_path

  if [[ "$DRY_RUN" -eq 1 ]]; then
    run_cmd rm -f "$path"
    return
  fi

  if rm -f "$path" 2>/dev/null; then
    return
  fi

  if command -v sudo >/dev/null 2>&1 && sudo -n rm -f "$path"; then
    return
  fi

  printf -v quoted_path '%q' "$path"
  fail "Cannot remove $path. Run: sudo rm -f $quoted_path"
}

prepare_redis_data_dir() {
  local data_dir="$1"
  local appendonly="$2"

  # Redis skips its ownership repair when placeholder files exist in /data.
  run_cmd mkdir -p "$data_dir"
  run_rm_f "$data_dir/.gitkeep"

  if [[ "$appendonly" -eq 1 ]]; then
    run_cmd mkdir -p "$data_dir/appendonlydir"
  fi
}

prepare_postgres_data_dir() {
  local data_dir="$1"
  local legacy_pgdata_dir="$data_dir/pgdata"

  run_cmd mkdir -p "$data_dir"
  run_rm_f "$data_dir/.gitkeep"

  if [[ -f "$data_dir/PG_VERSION" || -d "$data_dir/base" || -d "$data_dir/global" ]]; then
    fail "PostgreSQL data directory $data_dir uses the legacy root layout. This release mounts Postgres 18 at /var/lib/postgresql, so cluster data must live under $data_dir/18/docker. Back up the directory, then move an existing Postgres 18 cluster into that subdirectory or run pg_upgrade from older major versions before starting."
  fi

  if [[ -f "$legacy_pgdata_dir/PG_VERSION" || -d "$legacy_pgdata_dir/base" || -d "$legacy_pgdata_dir/global" ]]; then
    fail "PostgreSQL data directory $legacy_pgdata_dir uses the legacy pgdata layout. This release mounts Postgres 18 at /var/lib/postgresql, so cluster data must live under $data_dir/18/docker. Back up the directory, then move an existing Postgres 18 cluster into that subdirectory or run pg_upgrade from older major versions before starting."
  fi
}

prepare_opensearch_data_dir() {
  local label="$1"
  local data_dir="$2"
  local current_owner

  run_cmd mkdir -p "$data_dir"
  run_rm_f "$data_dir/.gitkeep"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    run_chown_recursive "$OPENSEARCH_CONTAINER_OWNER" "$data_dir"
    return
  fi

  current_owner="$(path_owner_spec "$data_dir")" || fail "Cannot inspect ownership for $data_dir."

  if [[ "$current_owner" != "$OPENSEARCH_CONTAINER_OWNER" ]]; then
    verbose_note "Setting $label data directory ownership to $OPENSEARCH_CONTAINER_OWNER"
    run_chown_recursive "$OPENSEARCH_CONTAINER_OWNER" "$data_dir"
  fi
}

prepare_n8n_app_data_dir() {
  local data_dir="$1"
  local current_owner

  run_cmd mkdir -p "$data_dir"
  run_rm_f "$data_dir/.gitkeep"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    run_chown_recursive "$N8N_CONTAINER_OWNER" "$data_dir"
    return
  fi

  current_owner="$(path_owner_spec "$data_dir")" || fail "Cannot inspect ownership for $data_dir."

  if [[ "$current_owner" != "$N8N_CONTAINER_OWNER" ]]; then
    verbose_note "Setting n8n app data directory ownership to $N8N_CONTAINER_OWNER"
    run_chown_recursive "$N8N_CONTAINER_OWNER" "$data_dir"
  fi
}

prepare_backend_uploads_data_dir() {
  local data_dir="$1"
  local current_owner

  run_cmd mkdir -p "$data_dir"
  run_rm_f "$data_dir/.gitkeep"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    run_chown_recursive "$BACKEND_CONTAINER_OWNER" "$data_dir"
    return
  fi

  current_owner="$(path_owner_spec "$data_dir")" || fail "Cannot inspect ownership for $data_dir."

  if [[ "$current_owner" != "$BACKEND_CONTAINER_OWNER" ]]; then
    verbose_note "Setting backend uploads data directory ownership to $BACKEND_CONTAINER_OWNER"
    run_chown_recursive "$BACKEND_CONTAINER_OWNER" "$data_dir"
  fi
}

require_file() {
  local file_path="$1"
  local label="$2"

  [[ -f "$file_path" ]] || fail "$label not found: $file_path"
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

  if [[ "$YES" -eq 0 && "$DRY_RUN" -eq 0 && -t 0 ]]; then
    printf 'Install missing tools now? [y/N] ' >&2
    read -r answer
    case "$answer" in
      y|Y|yes|YES)
        printf 'Run the install commands above, then re-run this deploy command.\n' >&2
        ;;
      *)
        printf 'Aborted until required tools are installed.\n' >&2
        ;;
    esac
  fi

  exit 1
}

record_docker_requirement() {
  record_missing_tool \
    docker \
    "Docker Engine with Docker Compose v2 is required to run the deployment stack." \
    "macOS: install Docker Desktop; Linux: install Docker Engine and the Compose plugin from https://docs.docker.com/engine/install/"
}

record_node_requirement() {
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

require_timeout() {
  command -v timeout >/dev/null 2>&1 || fail "timeout must be installed and on PATH. On macOS, install with: brew install coreutils"
}

if [[ $# -eq 0 ]]; then
  usage
  exit 1
fi

COMMAND="$1"
shift

case "$COMMAND" in
  setup|update|start|restart|stop|down|status|preflight|backup|migrate|bootstrap)
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    fail "Unknown command: $COMMAND"
    ;;
esac

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ $# -ge 2 ]] || fail "Missing value for --env-file."
      ENV_FILE="$2"
      shift 2
      ;;
    --env-template-file)
      [[ $# -ge 2 ]] || fail "Missing value for --env-template-file."
      ENV_TEMPLATE_FILE="$2"
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
    --backup-dir)
      [[ $# -ge 2 ]] || fail "Missing value for --backup-dir."
      BACKUP_DIR="$2"
      shift 2
      ;;
    --timeout-seconds)
      [[ $# -ge 2 ]] || fail "Missing value for --timeout-seconds."
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --with-ancillary)
      WITH_ANCILLARY=1
      shift
      ;;
    --skip-ancillary)
      SKIP_ANCILLARY=1
      shift
      ;;
    --skip-n8n)
      SKIP_N8N=1
      shift
      ;;
    --skip-pull)
      SKIP_PULL=1
      shift
      ;;
    --skip-signature-verify)
      SKIP_SIGNATURE_VERIFY=1
      shift
      ;;
    --skip-backup)
      SKIP_BACKUP=1
      shift
      ;;
    --skip-bootstrap)
      SKIP_BOOTSTRAP=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --no-start)
      NO_START=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --yes)
      YES=1
      shift
      ;;
    --generate-self-signed-cert)
      GENERATE_SELF_SIGNED_CERT=1
      shift
      ;;
    --verbosity)
      [[ $# -ge 2 ]] || fail "Missing value for --verbosity."
      [[ "$2" =~ ^[0-3]$ ]] || fail "--verbosity must be 0, 1, 2, or 3."
      VERBOSITY="$2"
      shift 2
      ;;
    --verbose)
      VERBOSITY=2
      shift
      ;;
    --quiet)
      VERBOSITY=0
      shift
      ;;
    --debug)
      VERBOSITY=3
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

[[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || fail "--timeout-seconds must be a positive integer."
[[ "$TIMEOUT_SECONDS" -gt 0 ]] || fail "--timeout-seconds must be greater than zero."

# Enable shell trace at debug level
[[ "$VERBOSITY" -ge 3 ]] && set -x

ENV_FILE="$(resolve_path "$ENV_FILE")"
ENV_TEMPLATE_FILE="$(resolve_path "$ENV_TEMPLATE_FILE")"
COMPOSE_FILE="$(resolve_path "$COMPOSE_FILE")"
MANIFEST_FILE="$(resolve_path "$MANIFEST_FILE")"
VERIFICATION_FILE="$(resolve_path "$VERIFICATION_FILE")"
BACKUP_DIR="$(resolve_path "$BACKUP_DIR")"

guard_setup_not_already_done() {
  if [[ "$FORCE" -eq 1 ]]; then
    verbose_note "Skipping DB reachability check (--force)."
    return
  fi
  [[ "$DRY_RUN" -eq 1 ]] && return

  verbose_note "Probing PostgreSQL to confirm this is a fresh install..."
  if docker compose \
    --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    exec \
    -T \
    postgres \
    pg_isready >/dev/null 2>&1; then
    fail "PostgreSQL is already reachable — this instance appears to have been set up previously. Run 'update' instead, or pass --force to run setup anyway."
  fi
}

confirm_production_action() {
  [[ "$YES" -eq 1 ]] && return
  [[ "$DRY_RUN" -eq 1 ]] && return

  printf 'This will run the HustleOps %s flow against %s. Continue? [y/N] ' "$COMMAND" "$ENV_FILE"
  read -r answer
  case "$answer" in
    y|Y|yes|YES)
      ;;
    *)
      fail "Aborted."
      ;;
  esac
}

ensure_dind_mounts() {
  # In dev-container environments where the project root is backed by a fakeowner
  # (Docker Desktop host-sharing) FUSE filesystem, the Docker daemon cannot
  # bind-mount paths from that filesystem.  Delegate to setup-dind.sh, which
  # replaces each bind-mount source path with a symlink to a native location.
  grep -q 'fakeowner' /proc/mounts 2>/dev/null || return 0

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf 'DRY RUN: would run setup-dind.sh to shadow bind-mount sources (fakeowner detected)\n'
    return 0
  fi

  debug_note "fakeowner detected — running setup-dind.sh"
  "$HELPER_DIR/setup-dind.sh" --project-root "$PROJECT_ROOT"
}

check_tools() {
  ensure_dind_mounts

  missing_required_tools=()
  record_docker_requirement

  case "$COMMAND" in
    setup|update)
      record_node_requirement
      if [[ "$SKIP_SIGNATURE_VERIFY" -eq 0 ]]; then
        record_cosign_requirement
      fi
      ;;
    preflight)
      record_node_requirement
      if [[ "$SKIP_SIGNATURE_VERIFY" -eq 0 ]]; then
        record_cosign_requirement
      fi
      ;;
    migrate)
      record_node_requirement
      ;;
  esac

  print_missing_tool_guidance

  if [[ "$DRY_RUN" -eq 0 ]]; then
    docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 must be available as 'docker compose'."
  fi

  case "$COMMAND" in
    setup|update)
      if [[ "$DRY_RUN" -eq 0 ]]; then
        require_timeout
      fi
      ;;
    migrate)
      require_timeout
      ;;
  esac
}

check_files() {
  case "$COMMAND" in
    setup|update|preflight|backup|migrate|bootstrap|start|restart|stop|down|status)
      require_file "$ENV_FILE" "Env file"
      require_file "$COMPOSE_FILE" "Compose file"
      ;;
  esac

  case "$COMMAND" in
    setup|update)
      require_file "$ENV_TEMPLATE_FILE" "Env template file"
      ;;
  esac

  case "$COMMAND" in
    setup|update|preflight|migrate)
      require_file "$MANIFEST_FILE" "Release manifest file"
      ;;
  esac

  case "$COMMAND" in
    setup|update|preflight)
      if [[ "$SKIP_SIGNATURE_VERIFY" -eq 0 ]]; then
        require_file "$VERIFICATION_FILE" "Release verification file"
      fi
      ;;
  esac
}

sync_release_env() {
  local managed_keys=(
    HUSTLEOPS_RELEASE_TAG
    HUSTLEOPS_RELEASE_TRIGGER
  )

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf 'DRY RUN: sync release metadata env keys from %q to %q\n' "$ENV_TEMPLATE_FILE" "$ENV_FILE"
    return 0
  fi

  verbose_note "Syncing release metadata env keys from $ENV_TEMPLATE_FILE to $ENV_FILE"

  node - "$ENV_FILE" "$ENV_TEMPLATE_FILE" "${managed_keys[@]}" <<'NODE'
const fs = require('node:fs');

const [envFile, envTemplateFile, ...managedKeys] = process.argv.slice(2);
const managedKeySet = new Set(managedKeys);
const assignmentPattern = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

function readAssignments(filePath) {
  const assignments = new Map();
  const content = fs.readFileSync(filePath, 'utf8');

  for (const line of content.split(/\n/)) {
    const match = line.match(assignmentPattern);
    if (!match) {
      continue;
    }
    assignments.set(match[1], match[2]);
  }

  return assignments;
}

const templateAssignments = readAssignments(envTemplateFile);
const missingTemplateKeys = managedKeys.filter(
  (key) => !templateAssignments.has(key),
);

if (missingTemplateKeys.length > 0) {
  console.error(
    `Env template is missing release-managed keys: ${missingTemplateKeys.join(', ')}`,
  );
  process.exit(1);
}

const envContent = fs.readFileSync(envFile, 'utf8');
const envLines = envContent.replace(/\n$/, '').split(/\n/);
const replacedKeys = new Set();
const nextLines = envLines.map((line) => {
  const match = line.match(assignmentPattern);
  if (!match || !managedKeySet.has(match[1])) {
    return line;
  }

  replacedKeys.add(match[1]);
  return `${match[1]}=${templateAssignments.get(match[1])}`;
});
const missingEnvKeys = managedKeys.filter((key) => !replacedKeys.has(key));

if (missingEnvKeys.length > 0) {
  if (nextLines.length > 0 && nextLines.at(-1) !== '') {
    nextLines.push('');
  }
  nextLines.push('# Release metadata values synced from .env.example');
  for (const key of missingEnvKeys) {
    nextLines.push(`${key}=${templateAssignments.get(key)}`);
  }
}

fs.writeFileSync(envFile, `${nextLines.join('\n')}\n`);
NODE
}

sync_derived_env() {
  # Compute POSTGRES_PASSWORD_ENCODED from POSTGRES_PASSWORD using
  # encodeURIComponent so the value is safe to embed in a DATABASE_URL.
  # This runs after sync_release_env so .env is already up to date.

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf 'DRY RUN: sync derived env keys (POSTGRES_PASSWORD_ENCODED) in %q\n' "$ENV_FILE"
    return 0
  fi

  verbose_note "Computing URL-encoded database credentials..."

  node - "$ENV_FILE" <<'NODE'
const fs = require('node:fs');

const [envFile] = process.argv.slice(2);
const assignmentPattern = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

const content = fs.readFileSync(envFile, 'utf8');
const lines = content.replace(/\n$/, '').split(/\n/);

let rawPassword = null;
for (const line of lines) {
  const match = line.match(assignmentPattern);
  if (match && match[1] === 'POSTGRES_PASSWORD') {
    rawPassword = match[2];
    // Strip surrounding single or double quotes if present
    if (/^".*"$/.test(rawPassword) || /^'.*'$/.test(rawPassword)) {
      rawPassword = rawPassword.slice(1, -1);
    }
    break;
  }
}

if (rawPassword === null) {
  console.error('POSTGRES_PASSWORD not found in env file; skipping POSTGRES_PASSWORD_ENCODED derivation.');
  process.exit(0);
}

const encoded = encodeURIComponent(rawPassword);
const encodedKey = 'POSTGRES_PASSWORD_ENCODED';
const encodedLine = `${encodedKey}=${encoded}`;

const existingIdx = lines.findIndex((l) => l.match(assignmentPattern)?.[1] === encodedKey);
if (existingIdx !== -1) {
  lines[existingIdx] = encodedLine;
} else {
  lines.push('');
  lines.push('# Derived: URL-safe encoding of POSTGRES_PASSWORD for use in DATABASE_URL');
  lines.push(encodedLine);
}

fs.writeFileSync(envFile, `${lines.join('\n')}\n`);
NODE
}

read_env_value() {
  local key="$1"
  local line value

  [[ -f "$ENV_FILE" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" == "$key="* ]] || continue
    value="${line#*=}"
    if [[ "$value" =~ ^\".*\"$ || "$value" =~ ^\'.*\'$ ]]; then
      value="${value:1:${#value}-2}"
    fi
    printf '%s\n' "$value"
    return 0
  done < "$ENV_FILE"
}

public_access_host() {
  local configured_host

  configured_host="$(read_env_value PUBLIC_HOSTNAME)"
  if [[ -n "$configured_host" ]]; then
    printf '%s\n' "$configured_host"
    return 0
  fi

  printf 'server-ip-or-dns\n'
}

resolve_project_path() {
  local value="$1"

  if [[ "$value" = /* ]]; then
    printf '%s\n' "$value"
    return
  fi

  printf '%s\n' "$PROJECT_ROOT/${value#./}"
}

nginx_tls_cert_file() {
  local value

  value="$(read_env_value NGINX_TLS_CERT_PATH)"
  [[ -n "$value" ]] || value="./nginx/certs/fullchain.pem"
  resolve_project_path "$value"
}

nginx_tls_key_file() {
  local value

  value="$(read_env_value NGINX_TLS_KEY_PATH)"
  [[ -n "$value" ]] || value="./nginx/certs/privkey.pem"
  resolve_project_path "$value"
}

append_nginx_name() {
  local value="$1"
  local existing

  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  [[ -n "$value" ]] || return 0

  if [[ "$NGINX_CERT_NAMES_COUNT" -gt 0 ]]; then
    for existing in "${NGINX_CERT_NAMES[@]}"; do
      [[ "$existing" == "$value" ]] && return 0
    done
  fi

  NGINX_CERT_NAMES+=("$value")
  NGINX_CERT_NAMES_COUNT=$((NGINX_CERT_NAMES_COUNT + 1))
}

is_ip_address() {
  local value="$1"

  [[ "$value" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ || "$value" == *:* ]]
}

join_values() {
  local first=1 value

  for value in "$@"; do
    if [[ "$first" -eq 1 ]]; then
      printf '%s' "$value"
      first=0
    else
      printf ', %s' "$value"
    fi
  done
}

print_nginx_cert_names() {
  local name aliases
  local dns_names=()
  local ip_names=()
  local dns_count=0
  local ip_count=0

  NGINX_CERT_NAMES=()
  NGINX_CERT_NAMES_COUNT=0
  append_nginx_name "$(read_env_value PUBLIC_HOSTNAME)"
  aliases="$(read_env_value PUBLIC_HOST_ALIASES)"
  if [[ -n "$aliases" ]]; then
    IFS=',' read -ra alias_values <<< "$aliases"
    for alias in "${alias_values[@]}"; do
      append_nginx_name "$alias"
    done
  fi

  if [[ "$NGINX_CERT_NAMES_COUNT" -gt 0 ]]; then
    for name in "${NGINX_CERT_NAMES[@]}"; do
      if is_ip_address "$name"; then
        ip_names+=("$name")
        ip_count=$((ip_count + 1))
      else
        dns_names+=("$name")
        dns_count=$((dns_count + 1))
      fi
    done
  fi

  if [[ "$dns_count" -gt 0 ]]; then
    printf '  DNS: '
    join_values "${dns_names[@]}"
    printf '\n'
  fi
  if [[ "$ip_count" -gt 0 ]]; then
    printf '  IP: '
    join_values "${ip_names[@]}"
    printf '\n'
  fi
}

ensure_nginx_tls_material() {
  local cert_file key_file answer

  [[ "$COMMAND" == "setup" ]] || return 0

  cert_file="$(nginx_tls_cert_file)"
  key_file="$(nginx_tls_key_file)"
  if [[ -f "$cert_file" && -f "$key_file" ]]; then
    return 0
  fi

  if [[ "$GENERATE_SELF_SIGNED_CERT" -eq 1 ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      printf 'DRY RUN:'
      printf ' %q' "$HELPER_DIR/setup-nginx-self-signed-cert.sh" --env-file "$ENV_FILE"
      printf '\n'
      return 0
    fi

    "$HELPER_DIR/setup-nginx-self-signed-cert.sh" --env-file "$ENV_FILE"
    return 0
  fi

  if [[ "$DRY_RUN" -eq 1 || ! -t 0 ]]; then
    fail "nginx TLS certificate files are missing. Provide NGINX_TLS_CERT_PATH and NGINX_TLS_KEY_PATH files, or re-run setup with --generate-self-signed-cert."
  fi

  printf 'Nginx TLS certificate files were not found.\n' >&2
  printf 'Generate a self-signed certificate for these names?\n' >&2
  print_nginx_cert_names >&2
  printf 'Continue? [y/N] ' >&2
  read -r answer
  case "$answer" in
    y|Y|yes|YES)
      "$HELPER_DIR/setup-nginx-self-signed-cert.sh" --env-file "$ENV_FILE"
      ;;
    *)
      fail "nginx TLS certificate files are required before preflight."
      ;;
  esac
}

print_access_addresses() {
  local host

  [[ "$NO_START" -eq 0 ]] || return 0
  host="$(public_access_host)"

  note ""
  note "Service access addresses:"
  note "  HustleOps app: https://$host"

  if [[ "$SKIP_N8N" -eq 0 && "$SKIP_ANCILLARY" -eq 0 ]]; then
    note "  n8n: https://$host:5678"
    note "  OpenSearch Dashboards: https://$host:5601"
  fi
}

run_preflight() {
  local args=(
    "$HELPER_DIR/preflight.sh"
    --env-file "$ENV_FILE"
    --compose-file "$COMPOSE_FILE"
    --manifest-file "$MANIFEST_FILE"
    --verification-file "$VERIFICATION_FILE"
  )

  case "$VERBOSITY" in
    0)
      args+=(--quiet)
      ;;
    2)
      args+=(--verbose)
      ;;
    3)
      args+=(--debug)
      ;;
  esac

  [[ "$SKIP_PULL" -eq 1 ]] && args+=(--skip-pull)
  [[ "$SKIP_SIGNATURE_VERIFY" -eq 1 ]] && args+=(--skip-signature-verify)

  run_cmd "${args[@]}"
}

prepare_postgres_for_backup() {
  if [[ "$SKIP_BACKUP" -eq 1 ]]; then
    return 0
  fi

  prepare_postgres_data_dir "$PROJECT_ROOT/data/postgres"

  run_cmd docker compose \
    --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    up \
    -d \
    postgres
}

run_backup() {
  if [[ "$SKIP_BACKUP" -eq 1 ]]; then
    note "Skipping backup (--skip-backup)"
    return
  fi

  run_cmd "$HELPER_DIR/backup-postgres.sh" \
    --env-file "$ENV_FILE" \
    --compose-file "$COMPOSE_FILE" \
    --output-dir "$BACKUP_DIR"
}

run_migration() {
  local status

  prepare_postgres_data_dir "$PROJECT_ROOT/data/postgres"

  run_cmd "$HELPER_DIR/run-migration.sh" \
    --env-file "$ENV_FILE" \
    --compose-file "$COMPOSE_FILE" \
    --manifest-file "$MANIFEST_FILE" \
    --timeout-seconds "$TIMEOUT_SECONDS" && return

  status=$?
  fail "Migration failed." "$status"
}

run_bootstrap() {
  if [[ "$SKIP_BOOTSTRAP" -eq 1 ]]; then
    note "Skipping bootstrap (--skip-bootstrap)"
    return
  fi

  run_cmd docker compose \
    --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    --profile bootstrap \
    run \
    --rm \
    backend-bootstrap
}

start_core_services() {
  prepare_postgres_data_dir "$PROJECT_ROOT/data/postgres"
  prepare_redis_data_dir "$PROJECT_ROOT/data/redis" 1
  prepare_backend_uploads_data_dir "$PROJECT_ROOT/data/uploads"

  run_cmd docker compose \
    --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    up \
    -d \
    backend \
    frontend \
    nginx

  run_cmd docker compose \
    --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    restart \
    nginx
}

start_ancillary_services() {
  if [[ "$SKIP_ANCILLARY" -eq 1 ]]; then
    note "Skipping ancillary services (--skip-ancillary)"
    return 0
  fi

  if [[ "$SKIP_N8N" -eq 1 ]]; then
    note "Skipping ancillary services because n8n was skipped"
    return 0
  fi

  if [[ "$WITH_ANCILLARY" -ne 1 ]]; then
    return 0
  fi

  prepare_opensearch_data_dir "OpenSearch" "$PROJECT_ROOT/data/opensearch"
  prepare_opensearch_data_dir "OpenSearch Dashboards" "$PROJECT_ROOT/data/opensearch-dashboards"

  run_cmd docker compose \
    --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    --profile ancillary-public \
    up \
    -d \
    opensearch \
    opensearch-dashboards \
    nginx-ancillary

  run_cmd docker compose \
    --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    --profile ancillary-public \
    restart \
    nginx-ancillary
}

start_n8n_services() {
  if [[ "$SKIP_N8N" -eq 1 ]]; then
    note "Skipping n8n services (--skip-n8n)"
    return 0
  fi

  prepare_postgres_data_dir "$PROJECT_ROOT/data/n8n/postgres"
  prepare_redis_data_dir "$PROJECT_ROOT/data/n8n/redis" 0
  prepare_n8n_app_data_dir "$PROJECT_ROOT/data/n8n/app"

  run_cmd docker compose \
    --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    up \
    -d \
    n8n-postgres \
    n8n-redis \
    n8n \
    n8n-worker \
    task-runner-main \
    task-runner-worker
}

show_status() {
  run_cmd docker compose \
    --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    ps
}

start_stack_services() {
  start_core_services
  start_n8n_services
  start_ancillary_services
  show_status
  print_access_addresses
}

stop_stack_services() {
  run_cmd docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop
}

run_setup_flow() {
  confirm_production_action
  guard_setup_not_already_done

  step 1 7 "Checking required tools and files"
  check_tools
  check_files
  step 2 7 "Syncing release metadata environment values"
  sync_release_env
  sync_derived_env
  step 3 7 "Preparing nginx TLS certificate"
  ensure_nginx_tls_material
  step 4 7 "Running preflight checks"
  run_preflight
  step 5 7 "Applying database migrations"
  run_migration
  step 6 7 "Running bootstrap"
  run_bootstrap
  if [[ "$NO_START" -eq 0 ]]; then
    step 7 7 "Starting core, n8n, and ancillary services"
    start_stack_services
  else
    step 7 7 "Skipping service start (--no-start)"
  fi
}

run_standard_flow() {
  confirm_production_action

  step 1 7 "Checking required tools and files"
  check_tools
  check_files
  step 2 7 "Syncing release metadata environment values"
  sync_release_env
  sync_derived_env
  step 3 7 "Running preflight checks"
  run_preflight
  step 4 7 "Preparing PostgreSQL and capturing backup"
  prepare_postgres_for_backup
  run_backup
  step 5 7 "Applying database migrations"
  run_migration
  step 6 7 "Running bootstrap"
  run_bootstrap
  if [[ "$NO_START" -eq 0 ]]; then
    step 7 7 "Starting stack"
    start_stack_services
  else
    step 7 7 "Skipping service start (--no-start)"
  fi
}

case "$COMMAND" in
  setup)
    run_setup_flow
    ;;
  update)
    run_standard_flow
    ;;
  start)
    step 1 2 "Checking required tools and files"
    check_tools
    check_files
    step 2 2 "Starting stack"
    start_stack_services
    ;;
  restart)
    step 1 3 "Checking required tools and files"
    check_tools
    check_files
    step 2 3 "Stopping services"
    stop_stack_services
    step 3 3 "Starting stack"
    start_stack_services
    ;;
  stop)
    step 1 2 "Checking required tools and files"
    check_tools
    check_files
    step 2 2 "Stopping services"
    stop_stack_services
    ;;
  down)
    step 1 2 "Checking required tools and files"
    check_tools
    check_files
    step 2 2 "Removing containers and networks"
    run_cmd docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile ancillary-public down
    ;;
  status)
    step 1 2 "Checking required tools and files"
    check_tools
    check_files
    step 2 2 "Showing service status"
    show_status
    ;;
  preflight)
    step 1 2 "Checking required tools and files"
    check_tools
    check_files
    step 2 2 "Running preflight checks"
    run_preflight
    ;;
  backup)
    step 1 3 "Checking required tools and files"
    check_tools
    check_files
    step 2 3 "Preparing PostgreSQL"
    prepare_postgres_for_backup
    step 3 3 "Capturing PostgreSQL backup"
    run_backup
    ;;
  migrate)
    step 1 2 "Checking required tools and files"
    check_tools
    check_files
    step 2 2 "Applying database migrations"
    run_migration
    ;;
  bootstrap)
    step 1 2 "Checking required tools and files"
    check_tools
    check_files
    step 2 2 "Running bootstrap"
    run_bootstrap
    ;;
esac

note "Done."
