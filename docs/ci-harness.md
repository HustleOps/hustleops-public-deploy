# CI Harness

## Pull Request Checks

`.github/workflows/pr-checks.yml` runs on pull requests to `main`, pushes to `main`, and manual dispatch. It uses:

```yaml
permissions:
  contents: read
```

The stable required job names are:

- `validate`
- `action-security`

`validate` keeps the existing deploy-bundle checks: shell syntax, ShellCheck, Node syntax, actionlint, Node tests, generated CI env validation, release metadata validation, Docker Compose rendering, Nginx validation, preflight, and deploy dry-run. It also detects common Node.js and Python project files and runs standard checks when those stacks are present.

`action-security` runs `scripts/ci/check-actions-pinning.sh` in enforcing mode. The script exits non-zero when external `uses:` references are not pinned to full 40-character SHAs.

## Release Workflow

`.github/workflows/release.yml` runs on pushed tags matching:

```text
v*
```

Jobs:

- `verify-release-source`
- `build-release`
- `publish-release`

`build-release` depends on `verify-release-source`. `publish-release` depends on `build-release` and runs automatically on verified `v*` tag pushes. The workflow keeps the default `GITHUB_TOKEN` read-only; only the release GitHub App installation token receives `contents: write` for publication.

## Release Tag Verification

`scripts/ci/verify-release-tag-from-main.sh` reads `RELEASE_TAG` first, then `GITHUB_REF_NAME`, rejects empty names, `main`, and non-`vMAJOR.MINOR.PATCH` tags, fetches `origin/main`, fetches the exact tag, resolves the tag commit, and checks whether that commit is an ancestor of `origin/main`.

This blocks:

```text
unchecked feature branch -> manual v1.2.3 tag -> release workflow -> production release
```

## Release Tag Creation

`.github/workflows/create-release-tag.yml` is the preferred release tag creation path. It accepts `version`, validates `vMAJOR.MINOR.PATCH`, checks out `main` with persisted credentials disabled, rejects existing tags, creates an annotated tag, and pushes it with the release GitHub App token. The workflow keeps `contents: read` for the default `GITHUB_TOKEN`; only the App installation token receives `contents: write` for the tag push.

For repositories with protected `v*` tag creation and GitHub Release publication, configure `RELEASE_APP_ID` as a repo or org variable containing the release GitHub App Client ID and `RELEASE_APP_PRIVATE_KEY` as a repository secret for the release GitHub App.

## GitHub Actions Hardening

`scripts/ci/check-actions-pinning.sh` scans `.github/workflows/` for `uses:` references. Local actions and `docker://` references are ignored. External action references must use a full 40-character commit SHA.

## Ruleset Audit

`.github/workflows/ruleset-audit.yml` runs weekly and on manual dispatch. Its stable job name is `audit-rulesets`. It uses the default `GITHUB_TOKEN` as `GH_TOKEN` and lists repository rulesets with:

```bash
gh api "repos/${GITHUB_REPOSITORY}/rulesets" --jq '.[] | {name, target, enforcement, bypass_actors, conditions}'
```

This is a read-only audit/reporting check. It does not replace configuring branch and tag rulesets in GitHub.

## Production Environment Protection

The workflows do not attach release publication or deployment to a GitHub deployment environment. Production release publication is automatic after a verified `v*` tag push and successful release build. Manual production deployment still requires a trusted self-hosted runner labeled `production`, but no GitHub environment approval is used.

## Production Deployment

`.github/workflows/deploy.yml` is manual-only. It builds and validates the deploy bundle first, then runs the production deploy job on a self-hosted runner labeled `production`.

The deploy job uses the real operator command:

```bash
./scripts/deploy.sh update --env-file "$PRODUCTION_ENV_FILE" --yes
```

Use `release_ref=main` only for the protected branch head, or use a protected `vMAJOR.MINOR.PATCH` tag that is reachable from `origin/main`. Keep the production env file and production runtime secrets on the target host or in repository/organization secret stores selected for the trusted runner model, not in pull request workflows.

If cloud deployment is added later, prefer OIDC with:

```yaml
permissions:
  id-token: write
  contents: read
```

## Secrets Handling

- Do not use production secrets in `pull_request` or `pull_request_target` workflows.
- Do not expose production secrets to untrusted branches or forked PRs.
- Keep production runtime secrets on the target host or in repository/organization secret stores selected for the runner model.
- Keep release verification and build jobs free of production secrets.
- Keep release GitHub App private keys separate from production runtime secrets.
- Configure `RELEASE_APP_ID` as a repository or organization variable containing the release GitHub App Client ID for `Create Release Tag` and `Release`.
- Configure `RELEASE_APP_CLIENT_ID` as a repository or organization variable containing the same release GitHub App Client ID for `Update From Release Contract`, and keep `RELEASE_APP_PRIVATE_KEY` as the shared release GitHub App private-key secret.
- Grant the release GitHub App `contents: write` so release tag creation, GitHub Release publication, and public deploy update branch pushes can request content-write installation tokens.
- Grant the release GitHub App `pull requests: write` so `Update From Release Contract` can open or update the public deploy update PR without depending on the repository-wide GitHub Actions PR creation setting.
- `Update From Release Contract` keeps the workflow-scoped `GITHUB_TOKEN` read-only and uses the release GitHub App token for both the automation branch push and PR list/create/edit operations.
- Do not configure `PUBLIC_DEPLOY_UPDATE_DEPLOY_KEY`, `PUBLIC_DEPLOY_UPDATE_APP_ID`, or `PUBLIC_DEPLOY_UPDATE_APP_PRIVATE_KEY`; the update workflow uses the release GitHub App instead.
