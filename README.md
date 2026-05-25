# HustleOps Deployment

This repository contains the Docker Compose deployment bundle for HustleOps.
It uses published container images and does not require application source code or local image builds.
The HustleOps GHCR images are public and can be pulled without signing in.

## Requirements

- Docker Engine with Docker Compose v2
- Node.js 24 or newer for deploy metadata validation, migration execution, and the `start`/`restart` migration marker guard
- Network access to `ghcr.io`
- `cosign` for release image signature verification
- `openssl` for generating deployment secrets
- TLS certificate and private key for the nginx HTTPS listeners, or `openssl` to allow setup to generate a self-signed certificate
- GNU `timeout` for non-dry-run migration/update flows. On macOS, install with `brew install coreutils` and ensure `timeout` is on `PATH`.

## Setup

1. Create the deployment environment file:

   ```bash
   cp .env.example .env
   ```

2. Replace every `change_me` value in `.env`. The comments in `.env.example` include generation commands for required secrets.

3. Set `PUBLIC_HOSTNAME` to the primary DNS name or IP address operators will use. Set `PUBLIC_HOST_ALIASES` to any additional comma-separated DNS names or IP addresses that should be included when setup generates a self-signed certificate.

4. Place production TLS files at `NGINX_TLS_CERT_PATH` and `NGINX_TLS_KEY_PATH`, or leave the defaults and allow setup to generate a self-signed certificate for lab/internal use when prompted. The same certificate is mounted into the app and ancillary nginx proxies. Generated certificates are written under `nginx/certs/`, which is ignored by git.

5. Confirm the host directories under `data/` and `logs/` are writable by the matching containers before first start. The deploy script prepares backend uploads, n8n app data, and OpenSearch data ownership automatically. Logs continue to use Docker stdout by default; use `logs/<service>/` only when file logging is intentionally enabled and shipped off-host.

6. Run the setup flow:

   ```bash
   ./scripts/deploy.sh setup --env-file .env
   ```

   The setup flow validates required tools, prepares nginx TLS material, verifies release images, captures a PostgreSQL backup, applies migrations, runs the initial-admin bootstrap, starts the core application services, starts n8n, starts the OpenSearch ancillary bundle, exposes ancillary proxy ports, prints Docker Compose status, and prints service access addresses.

## Update

Repository maintainers can update this deployment bundle from a signed release contract before operators pull it:

1. Run the `Update From Release Contract` GitHub Actions workflow.
2. Keep the default contract ref for the latest release, or enter a specific `ghcr.io/hustleops/hustleops-release-contract:<version>` ref.
3. Review and merge the generated update PR after CI passes.

The workflow verifies the contract signature before reading the JSON payload, cross-checks the verified payload trust fields, verifies runtime image signatures, updates `docker-compose.prod.yml` with the checked-in image refs, refreshes `.env.example` release metadata, records root and immutable release metadata, and validates the deploy scripts, Compose files, and nginx configs. After the generated update PR is merged to `main`, create a protected `v*` tag with the `Create Release Tag` workflow so the tag-triggered `Release` workflow publishes the GitHub Release.

After pulling a newer public deploy repository release, run:

```bash
./scripts/deploy.sh update --env-file .env
```

The update flow uses image refs already checked into `docker-compose.prod.yml`, syncs release metadata values from `.env.example` into `.env`, runs preflight checks, captures a PostgreSQL backup, applies pending migrations, runs the idempotent bootstrap contract, recreates core application services, starts n8n and the OpenSearch ancillary bundle, publishes ancillary proxy ports, and prints service status plus access addresses. Operator-provided secrets in `.env` are preserved; legacy `HUSTLEOPS_*_IMAGE` values in an older `.env` file are ignored by the Compose bundle.

The `update` command is required after pulling a newer public deploy release because it records the release-linked database migration marker before starting newer application images. Do not use `start` as the first command after pulling a newer release.

For staged operations that should not start services yet, run `./scripts/deploy.sh update --env-file .env --no-start` after pulling the newer deploy release. Reuse any custom `--compose-file` and `--manifest-file` options when you later run `start` or `restart`.

n8n and the OpenSearch ancillary bundle start by default and are exposed over HTTPS through the ancillary reverse proxy. OpenSearch and OpenSearch Dashboards are started together under the `ancillary-public` Compose profile. Use `--skip-ancillary` when those ports and OpenSearch services must not be published or started, and use `--skip-n8n` when the n8n runtime itself should not be started.

## Local Validation

Before opening a PR or applying a manual config change:

```bash
node scripts/make-ci-env.mjs --output /tmp/hustleops-ci.env
node scripts/validate-release-metadata.mjs --env-file /tmp/hustleops-ci.env
docker compose --env-file /tmp/hustleops-ci.env -f docker-compose.prod.yml config >/dev/null
docker compose --env-file /tmp/hustleops-ci.env -f docker-compose.prod.yml --profile ancillary-public config >/dev/null
./scripts/validate-nginx.sh
./scripts/preflight.sh --env-file /tmp/hustleops-ci.env --skip-pull --skip-signature-verify
```

The CI env generator writes deterministic nginx test certificate files under `.hustleops/nginx/certs/` so HTTPS preflight checks can run without production certificate material.

## Manual Operations

The unified deploy script calls these lower-level scripts internally. Operators can still run them directly when diagnosing a failed rollout:

```bash
./scripts/preflight.sh --env-file .env
./scripts/backup-postgres.sh --env-file .env
./scripts/run-migration.sh --env-file .env --timeout-seconds 600
```

Manual bootstrap and service start commands:

Direct `docker compose up` startup commands are diagnostic or emergency-only. They bypass the `deploy.sh start` migration marker guard, so do not use them after pulling a newer deploy release until `./scripts/deploy.sh update --env-file .env` or staged `./scripts/deploy.sh update --env-file .env --no-start` has written the current release marker.

```bash
docker compose --env-file .env -f docker-compose.prod.yml --profile bootstrap run --rm backend-bootstrap
docker compose --env-file .env -f docker-compose.prod.yml up -d backend frontend nginx
docker compose --env-file .env -f docker-compose.prod.yml --profile ancillary-public up -d opensearch opensearch-dashboards nginx-ancillary
```

## Published Services

The default start path publishes:

- HustleOps app: port `443` for HTTPS; port `80` redirects to HTTPS
- n8n: port `5678` for HTTPS
- OpenSearch Dashboards: port `5601` for HTTPS

After startup, `deploy.sh` prints service access addresses. Set `PUBLIC_HOSTNAME` in `.env` so the deploy script prints concrete service addresses after startup. If `PUBLIC_HOSTNAME` is empty, the script prints `server-ip-or-dns` as a reminder to use the target host address. Add extra names or IP addresses to `PUBLIC_HOST_ALIASES` when the setup-generated self-signed certificate must be trusted for more than the primary host.

`ANCILLARY_N8N_BIND` and `ANCILLARY_DASHBOARDS_BIND` default to `0.0.0.0`. Restrict these values to a private interface when the host is not already protected by trusted network boundaries such as VPN, private firewall rules, SSO-capable reverse proxy, or equivalent access control.

`--debug` leaves Docker image pull progress visible and enables shell tracing for deploy/preflight diagnostics.

## Starting and Stopping

Start the full stack after it was stopped or brought down:

`start` requires the current release migration marker written by `setup` or `update`. If you pulled a newer deploy bundle, run `update` first so the database schema is upgraded before the newer backend image starts.

```bash
./scripts/deploy.sh start --env-file .env
```

Restart the full stack:

```bash
./scripts/deploy.sh restart --env-file .env
```

Stop services (containers remain, data is preserved):

```bash
./scripts/deploy.sh stop --env-file .env
```

Bring down containers and networks entirely (data volumes are preserved):

```bash
./scripts/deploy.sh down --env-file .env
```

## Rollback

Use the previous release entry under `releases/`, restore the matching image refs in `docker-compose.prod.yml`, run preflight checks, and roll services forward or backward only after confirming database compatibility.
