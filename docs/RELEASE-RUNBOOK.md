# Release Runbook

## Source Of Truth

- The application source repository owns application code, image publication, and the canonical release handoff contract.
- This public repository owns the runtime deployment payload: `docker-compose.prod.yml`, mounted nginx config files, host-path directory placeholders under `data/`, and protected public release tags that follow `vMAJOR.MINOR.PATCH`.
- Release tags must be created from protected `main` through the `Create Release Tag` workflow. Older `public-deploy-vX.Y.Z` tags may exist in repository history, but the protected release harness uses `v*` tags.

## What A Release Updates

1. Runtime image references for backend and frontend.
2. The deploy payload files in this repository.
3. Release metadata such as `release-manifest.json`, `deployment/release-trigger.txt`, and `releases/<tag>.json`.
4. A GitHub Release automatically after the update PR lands on `main` and a protected `v*` tag is created, with `releases/<tag>.json` attached as the source app contract.

The protected release tag identifies the reviewed deployment bundle state. The
checked-in release metadata and attached `releases/<tag>.json` asset identify
the source application release contained in that bundle.

## Validation

Validate the deploy payload before rollout:

```bash
docker compose --env-file .env -f docker-compose.prod.yml config
./scripts/validate-nginx.sh
```

HTTPS validation depends on readable nginx TLS files. For CI and local dry-runs,
generate `.hustleops/ci.env` with `scripts/make-ci-env.mjs`; it writes
deterministic test cert fixtures under `.hustleops/nginx/certs/`.

## Persistence Layout

- `data/postgres/` stores HustleOps PostgreSQL data on the host; Postgres 18 keeps the active cluster under `data/postgres/18/docker/`.
- `data/n8n/postgres/` stores n8n PostgreSQL data on the host; Postgres 18 keeps the active cluster under `data/n8n/postgres/18/docker/`.
- `data/uploads/` stores backend uploads, screenshots, and chat files on the host.
- Redis, OpenSearch, n8n state, n8n PostgreSQL, and n8n Redis use host bind mounts under `data/`.
- If PostgreSQL cluster files exist directly under `data/postgres/`, `data/postgres/pgdata/`, or `data/n8n/postgres/`, stop and migrate or upgrade them before starting the Postgres 18 services.

## Rollback

- Roll back to a prior release by restoring the earlier image references and release metadata.
- Use `releases/<tag>.json`, or the matching public deploy GitHub Release asset, as the immutable record for the previous rollout.
- Re-run validation before bringing the stack back up.
- Do not move or delete existing release tags. Rollbacks should create a new reviewed repository state and release tag when history needs to change.
