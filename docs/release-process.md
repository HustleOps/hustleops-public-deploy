# Release Process

This repository uses protected `main` plus protected `vMAJOR.MINOR.PATCH` release tags to keep unchecked code out of releases. The expected path is:

```text
feature branch -> pull request -> CI/security checks -> merge to protected main -> create v* tag from main -> verify tag source -> build/release/publish
```

## Standard Release Flow

1. Open a pull request into `main`.
2. Wait for required checks, including `validate` and `action-security`.
3. Merge only after the branch is up to date with `main` and satisfies the active `Protect main` ruleset.
4. Create the release tag with the `Create Release Tag` workflow.
5. The tag-triggered `Release` workflow verifies that the tag commit is reachable from `origin/main`, validates release metadata, builds release notes, and publishes the GitHub Release automatically.

## Creating A Release Tag

Use GitHub Actions, not a local shell:

1. Open Actions.
2. Run `Create Release Tag`.
3. Enter a version such as `v1.2.3`.
4. The workflow checks out `main`, rejects an existing tag, creates an annotated tag, and pushes it.

The version must match `vMAJOR.MINOR.PATCH`. The release workflow also validates the checked-in release metadata before publishing release assets.

The workflow checks out `main` with persisted credentials disabled, refuses to overwrite any local or remote tag, creates an annotated tag, and pushes it with the release GitHub App token. Configure `RELEASE_APP_CLIENT_ID` with the release GitHub App Client ID and `RELEASE_APP_PRIVATE_KEY`, then allow that App to create protected `v*` tags in the tag ruleset bypass list.

## Why Local Tag Pushes Are Forbidden

A local tag can be created from an unchecked feature branch. Without verification, that tag could trigger a production release without PR review, required checks, or CODEOWNERS approval. The release workflow blocks this by resolving the pushed tag and requiring the tag commit to be an ancestor of `origin/main`.

## Release Verification

`scripts/ci/verify-release-tag-from-main.sh` runs before build or publish jobs. It reads `RELEASE_TAG` first and then `GITHUB_REF_NAME`, rejects empty values, `main`, and non-semver release tags, fetches `origin/main`, fetches the exact release tag, resolves the tag to a commit, and runs an ancestry check:

```text
tag commit reachable from origin/main -> release may continue
tag commit not reachable from origin/main -> release fails immediately
```

`build-release` depends on `verify-release-source`. `publish-release` depends on `build-release`, mints the release GitHub App installation token for publication, and runs automatically for verified `v*` tag pushes. Publishing cannot continue after a failed source verification or failed build.

## Production Deployment

This repository ships an operator-facing Docker Compose deployment bundle. Production deployment can run through the manual `Deploy App` workflow when a trusted self-hosted runner labeled `production` is installed on the target host or equivalent production environment. GitHub-hosted runners must not run production deploys because they do not have the target host's Docker context, persistent volumes, or `.env` file.

The deployment workflow builds and validates the bundle, then runs on a trusted self-hosted runner labeled `production`:

```bash
./scripts/deploy.sh update --env-file .env
```

Operators can still run the same command directly on the target host when GitHub Actions deployment is not configured. Keep production secrets and the production env file on the target host or in repository/organization secret stores selected for the trusted runner model, not in pull request workflows.

## Rollback Considerations

Roll back by selecting a previously reviewed and protected release record, restoring the matching release metadata and `docker-compose.prod.yml` runtime image references, validating the deploy bundle, and creating a new reviewed release if needed. Do not move old release tags. Immutable tags are audit records; a rollback should create a new reviewed state rather than rewriting history.

## Forbidden Release Paths

- direct push to main
- manual release tag from unchecked branch
- moving existing release tag
- deleting release tag
- deploying from pull request workflow
- deploying from non-main commit
- publishing before release tag verification or build validation succeeds
- deploying from a runner that is not trusted for production
- exposing production secrets to pull request workflows
