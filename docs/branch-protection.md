# Branch And Tag Protection

Committed files provide CI, release verification, CODEOWNERS, templates, and documentation. They do not protect the repository by themselves. A repository admin must configure GitHub rulesets and the trusted production runner model.

## Main Branch Ruleset

Target:

```text
refs/heads/main
```

Required settings:

- Require pull request before merging
- Require at least 1 approval
- Dismiss stale approvals
- Require required status checks
- Require branch to be up to date before merge
- Block force pushes
- Block branch deletion
- Restrict bypass permissions

Recommended required status checks:

- `validate`
- `action-security`

Team-maintained ideal:

- Require review from Code Owners.
- Require approval of the most recent push.

Solo-maintainer practical mode:

- Keep `.github/CODEOWNERS` as advisory documentation for operations/security ownership.
- For now, do not require both `Require review from Code Owners` and `Require approval of the most recent push`.
- Disable either `Require review from Code Owners` or `Require approval of the most recent push` so a one-person repository can still merge protected `.github/` and CI/CD changes.
- Treat this as a temporary operational tradeoff. Re-enable both controls after a second trusted maintainer or team exists.

## Release Tag Ruleset

Target:

```text
refs/tags/v*
```

Required settings:

- Protect `v*` tags
- Restrict tag creation
- Restrict tag updates
- Restrict tag deletion
- Block force pushes
- Block moving tags
- Allow tag creation only from trusted release maintainers or the release GitHub App

Manual local tag pushes should be blocked for normal developers. The preferred path is the `Create Release Tag` workflow, which creates annotated tags from the current `main` commit.

The `Create Release Tag` workflow uses a dedicated GitHub App installation token to push protected `v*` tags. Configure the tag ruleset bypass list so only that release App, or explicitly trusted release maintainers, can create protected release tags.

Set this repo or org variable:

```text
RELEASE_APP_ID
```

`RELEASE_APP_ID` must identify the release GitHub App.
Use the GitHub App Client ID, not the legacy numeric App ID, because the workflow passes it to `actions/create-github-app-token` as `client-id`.

Set this repository secret:

```text
RELEASE_APP_PRIVATE_KEY
```

Rotate the App private key if release ownership changes and do not reuse it for production runtime access.
The App must have repository Contents write permission for protected tag creation, release publication, and public deploy update branch pushes. It must also have Pull requests write permission so `Update From Release Contract` can open or update its automation PR with the App token instead of the workflow-scoped `GITHUB_TOKEN`. `Update From Release Contract` reads the App Client ID from `RELEASE_APP_CLIENT_ID` to make the expected identifier explicit.

## Production Environment

The lowered-control workflow model does not require a GitHub deployment environment for release publication or manual deployment. Repository administrators may delete the `production` environment after confirming it has no secrets or variables.

The `Deploy App` workflow still targets a trusted self-hosted runner labeled `production`. Keep production runtime secrets and the production env file on the target host or in the chosen repository/organization secret store for that trusted runner model, not in pull request workflows.

## Acceptance Checks

- Direct push to `main` is rejected.
- Pull requests cannot merge without required checks.
- Pull requests cannot merge without required approvals.
- Pull requests touching CODEOWNERS paths require CODEOWNER approval when Code Owners review is enabled.
- Force pushes and branch deletion for `main` are rejected.
- Untrusted users cannot create, move, or delete `v*` tags.
- Release tags outside `main` history fail in the release workflow.
- Release publication starts automatically after a protected `v*` tag is created and fails if tag source verification or build validation fails.
