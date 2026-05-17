import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const verifyTagScript = path.join(projectRoot, "scripts", "ci", "verify-release-tag-from-main.sh");
const checkPinningScript = path.join(projectRoot, "scripts", "ci", "check-actions-pinning.sh");
const deployScript = path.join(projectRoot, "scripts", "deploy.sh");

function execFileWithInput(file, args, options, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });

    child.stdin.end(input);
  });
}

function composeServiceBlock(compose, serviceName) {
  const escapedName = serviceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = compose.match(new RegExp(`^  ${escapedName}:\\n[\\s\\S]*?(?=^  [A-Za-z0-9_-]+:\\n|^networks:)`, "m"));
  assert.ok(match, `Expected docker-compose.prod.yml to include service ${serviceName}`);
  return match[0];
}

async function git(repoRoot, args) {
  return execFileAsync("git", ["-C", repoRoot, ...args]);
}

async function commitFile(repoRoot, fileName, content, message) {
  await writeFile(path.join(repoRoot, fileName), content);
  await git(repoRoot, ["add", fileName]);
  await git(repoRoot, ["commit", "-m", message]);
}

async function createOriginWithReleaseTags() {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hustleops-release-tag-"));
  const originRoot = path.join(tmpRoot, "origin.git");
  const sourceRoot = path.join(tmpRoot, "source");
  const cloneRoot = path.join(tmpRoot, "clone");

  await execFileAsync("git", ["init", "--bare", originRoot]);
  await execFileAsync("git", ["clone", originRoot, sourceRoot]);
  await git(sourceRoot, ["config", "user.email", "ci@example.test"]);
  await git(sourceRoot, ["config", "user.name", "CI Test"]);
  await git(sourceRoot, ["checkout", "-b", "main"]);
  await commitFile(sourceRoot, "README.md", "# Release Fixture\n", "chore: initial main");
  await git(sourceRoot, ["tag", "-a", "v1.2.3", "-m", "Release v1.2.3"]);
  await git(sourceRoot, ["push", "origin", "main", "v1.2.3"]);

  await git(sourceRoot, ["checkout", "-b", "unchecked-feature"]);
  await commitFile(sourceRoot, "feature.txt", "unchecked\n", "feat: unchecked branch");
  await git(sourceRoot, ["tag", "-a", "v9.9.9", "-m", "Release v9.9.9"]);
  await git(sourceRoot, ["push", "origin", "unchecked-feature", "v9.9.9"]);

  await execFileAsync("git", ["clone", originRoot, cloneRoot]);

  return cloneRoot;
}

async function runVerifyTag(repoRoot, tagName, extraEnv = {}) {
  return execFileAsync("bash", [verifyTagScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RELEASE_TAG: "",
      GITHUB_REF_NAME: tagName,
      ...extraEnv,
    },
  });
}

async function writeWorkflow(repoRoot, fileName, workflow) {
  const workflowDir = path.join(repoRoot, ".github", "workflows");

  await mkdir(workflowDir, { recursive: true });
  await writeFile(path.join(workflowDir, fileName), workflow);
}

async function runPinningCheck(repoRoot) {
  return execFileAsync("bash", [checkPinningScript], { cwd: repoRoot });
}

async function createFakeDockerBin() {
  const binDir = await mkdtemp(path.join(os.tmpdir(), "hustleops-fake-docker-"));
  const dockerPath = path.join(binDir, "docker");

  await writeFile(dockerPath, "#!/bin/sh\nexit 0\n");
  await chmod(dockerPath, 0o755);

  return binDir;
}

async function createRecordingPreflightHelper() {
  const helperDir = await mkdtemp(path.join(os.tmpdir(), "hustleops-helper-"));
  const preflightPath = path.join(helperDir, "preflight.sh");

  await writeFile(
    preflightPath,
    "#!/bin/sh\nprintf '%s\\n' \"$@\"\n",
  );
  await chmod(preflightPath, 0o755);

  return helperDir;
}

async function createNoopSetupHelpers() {
  const helperDir = await mkdtemp(path.join(os.tmpdir(), "hustleops-setup-helper-"));

  await writeFile(
    path.join(helperDir, "preflight.sh"),
    "#!/bin/sh\nprintf 'fake preflight %s\\n' \"$*\"\n",
  );
  await writeFile(
    path.join(helperDir, "run-migration.sh"),
    "#!/bin/sh\nprintf 'fake migration %s\\n' \"$*\"\n",
  );
  await chmod(path.join(helperDir, "preflight.sh"), 0o755);
  await chmod(path.join(helperDir, "run-migration.sh"), 0o755);

  return helperDir;
}

test("verify-release-tag-from-main allows tags reachable from origin/main", async () => {
  const repoRoot = await createOriginWithReleaseTags();
  const { stdout, stderr } = await runVerifyTag(repoRoot, "v1.2.3");

  assert.match(stdout, /Release tag v1\.2\.3 is reachable from origin\/main\./);
  assert.equal(stderr, "");
});

test("verify-release-tag-from-main blocks tags outside origin/main history", async () => {
  const repoRoot = await createOriginWithReleaseTags();

  await assert.rejects(
    runVerifyTag(repoRoot, "v9.9.9"),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Release tag v9\.9\.9 is not reachable from origin\/main\./);
      return true;
    },
  );
});

test("verify-release-tag-from-main prefers RELEASE_TAG over GITHUB_REF_NAME", async () => {
  const repoRoot = await createOriginWithReleaseTags();
  const { stdout, stderr } = await runVerifyTag(repoRoot, "main", { RELEASE_TAG: "v1.2.3" });

  assert.match(stdout, /Release tag v1\.2\.3 is reachable from origin\/main\./);
  assert.equal(stderr, "");
});

test("verify-release-tag-from-main rejects main as a release tag", async () => {
  const repoRoot = await createOriginWithReleaseTags();

  await assert.rejects(
    runVerifyTag(repoRoot, "main"),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Release tag name must not be main\./);
      return true;
    },
  );
});

test("check-actions-pinning passes full commit SHA action references", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "hustleops-pinned-actions-"));

  await writeWorkflow(repoRoot, "pinned.yml", `name: pinned
on: workflow_dispatch
jobs:
  pinned:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd
      - uses: ./.github/actions/local
`);

  const { stdout, stderr } = await runPinningCheck(repoRoot);

  assert.match(stdout, /All external GitHub Actions are pinned to full commit SHAs\./);
  assert.equal(stderr, "");
});

test("check-actions-pinning fails unpinned action references", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "hustleops-unpinned-actions-"));

  await writeWorkflow(repoRoot, "unpinned.yml", `name: unpinned
on: workflow_dispatch
jobs:
  unpinned:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`);

  await assert.rejects(
    runPinningCheck(repoRoot),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unpinned GitHub Actions references found:/);
      assert.match(error.stderr, /unpinned\.yml:7: actions\/checkout@v4/);
      return true;
    },
  );
});

test("check-actions-pinning fails external action references without a ref", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "hustleops-missing-action-ref-"));

  await writeWorkflow(repoRoot, "missing-ref.yml", `name: missing-ref
on: workflow_dispatch
jobs:
  missing-ref:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout
      - uses: docker://alpine:3.20
`);

  await assert.rejects(
    runPinningCheck(repoRoot),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /actions\/checkout \(missing @<sha>\)/);
      assert.doesNotMatch(error.stderr, /docker:\/\/alpine/);
      return true;
    },
  );
});

test("repository workflow action references are pinned", async () => {
  const { stdout, stderr } = await runPinningCheck(projectRoot);

  assert.match(stdout, /All external GitHub Actions are pinned to full commit SHAs\./);
  assert.equal(stderr, "");
});

test("deploy start dry-run prepares Redis data directories before Compose starts services", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hustleops-deploy-start-"));
  const envFile = path.join(tmpRoot, ".env");
  const fakeDockerBin = await createFakeDockerBin();

  await writeFile(envFile, "HUSTLEOPS_TEST_ENV=1\n");

  const { stdout, stderr } = await execFileAsync(
    "bash",
    [deployScript, "start", "--env-file", envFile, "--dry-run", "--yes"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${fakeDockerBin}:${process.env.PATH}`,
      },
    },
  );

  assert.equal(stderr, "");
  assert.match(stdout, /DRY RUN: mkdir -p .*data\/redis/);
  assert.match(stdout, /DRY RUN: rm -f .*data\/redis\/\.gitkeep/);
  assert.match(stdout, /DRY RUN: mkdir -p .*data\/redis\/appendonlydir/);
  assert.ok(
    stdout.indexOf("data/redis/.gitkeep") < stdout.indexOf("docker compose"),
    "Redis data directory cleanup should run before docker compose starts services",
  );
  assert.match(stdout, /up -d backend frontend nginx/);
  assert.match(stdout, /docker compose [\s\S]* restart nginx/);
  assert.ok(
    stdout.indexOf("up -d backend frontend nginx") < stdout.indexOf("restart nginx"),
    "core nginx should restart after Compose has ensured the service is running",
  );
});

test("deploy start dry-run prepares OpenSearch data directory with ancillary services", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hustleops-deploy-opensearch-"));
  const envFile = path.join(tmpRoot, ".env");
  const fakeDockerBin = await createFakeDockerBin();

  await writeFile(envFile, "HUSTLEOPS_TEST_ENV=1\n");

  const { stdout, stderr } = await execFileAsync(
    "bash",
    [deployScript, "start", "--env-file", envFile, "--dry-run", "--yes"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${fakeDockerBin}:${process.env.PATH}`,
      },
    },
  );

  assert.equal(stderr, "");
  assert.match(stdout, /DRY RUN: mkdir -p .*data\/opensearch/);
  assert.match(stdout, /DRY RUN: rm -f .*data\/opensearch\/\.gitkeep/);
  assert.match(stdout, /DRY RUN: chown -R 1000:1000 .*data\/opensearch/);
  assert.ok(
    stdout.indexOf("data/opensearch/.gitkeep") < stdout.indexOf("--profile ancillary-public"),
    "OpenSearch data directory cleanup should run before ancillary services start",
  );
});

test("deploy setup dry-run prepares and starts n8n services by default", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hustleops-deploy-setup-n8n-"));
  const envFile = path.join(tmpRoot, ".env");
  const certFile = path.join(tmpRoot, "nginx", "certs", "fullchain.pem");
  const keyFile = path.join(tmpRoot, "nginx", "certs", "privkey.pem");
  const fakeDockerBin = await createFakeDockerBin();

  await mkdir(path.dirname(certFile), { recursive: true });
  await writeFile(certFile, "test certificate\n");
  await writeFile(keyFile, "test private key\n");
  await writeFile(
    envFile,
    [
      "HUSTLEOPS_TEST_ENV=1",
      `NGINX_TLS_CERT_PATH=${certFile}`,
      `NGINX_TLS_KEY_PATH=${keyFile}`,
      "",
    ].join("\n"),
  );

  const { stdout, stderr } = await execFileAsync(
    "bash",
    [
      deployScript,
      "setup",
      "--env-file",
      envFile,
      "--dry-run",
      "--yes",
      "--skip-pull",
      "--skip-signature-verify",
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${fakeDockerBin}:${process.env.PATH}`,
      },
    },
  );

  assert.equal(stderr, "");
  assert.match(stdout, /DRY RUN: mkdir -p .*data\/n8n\/postgres/);
  assert.match(stdout, /DRY RUN: rm -f .*data\/n8n\/postgres\/\.gitkeep/);
  assert.match(stdout, /DRY RUN: mkdir -p .*data\/n8n\/redis/);
  assert.match(stdout, /DRY RUN: rm -f .*data\/n8n\/redis\/\.gitkeep/);
  assert.match(stdout, /DRY RUN: mkdir -p .*data\/n8n\/app/);
  assert.match(stdout, /DRY RUN: rm -f .*data\/n8n\/app\/\.gitkeep/);
  assert.match(stdout, /DRY RUN: chown -R 1000:1000 .*data\/n8n\/app/);
  assert.match(stdout, /up -d n8n-postgres n8n-redis n8n n8n-worker task-runner-main task-runner-worker/);
  assert.ok(
    stdout.indexOf("data/n8n/postgres/.gitkeep") < stdout.indexOf("n8n-postgres"),
    "n8n PostgreSQL data directory cleanup should run before n8n services start during setup",
  );
  assert.ok(
    stdout.indexOf("data/n8n/redis/.gitkeep") < stdout.indexOf("n8n-postgres"),
    "n8n Redis data directory cleanup should run before n8n services start during setup",
  );
  assert.ok(
    stdout.indexOf("data/n8n/app") < stdout.indexOf("n8n-postgres"),
    "n8n app data directory ownership should be fixed before n8n services start during setup",
  );
});

test("deploy setup continues after confirmation at normal verbosity", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hustleops-deploy-setup-confirm-"));
  const envFile = path.join(tmpRoot, ".env");
  const certFile = path.join(tmpRoot, "nginx", "certs", "fullchain.pem");
  const keyFile = path.join(tmpRoot, "nginx", "certs", "privkey.pem");
  const fakeDockerBin = await createFakeDockerBin();
  const helperDir = await createNoopSetupHelpers();

  await writeFile(path.join(fakeDockerBin, "timeout"), "#!/bin/sh\n\"$@\"\n");
  await chmod(path.join(fakeDockerBin, "timeout"), 0o755);
  await mkdir(path.dirname(certFile), { recursive: true });
  await writeFile(certFile, "test certificate\n");
  await writeFile(keyFile, "test private key\n");
  await writeFile(
    envFile,
    [
      "PUBLIC_HOSTNAME=ops.example.test",
      `NGINX_TLS_CERT_PATH=${certFile}`,
      `NGINX_TLS_KEY_PATH=${keyFile}`,
      "POSTGRES_PASSWORD=VeryStrongPostgresPassword123!",
      "",
    ].join("\n"),
  );

  const { stdout, stderr } = await execFileWithInput(
    "bash",
    [
      deployScript,
      "setup",
      "--env-file",
      envFile,
      "--force",
      "--skip-pull",
      "--skip-signature-verify",
      "--skip-bootstrap",
      "--no-start",
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        HUSTLEOPS_DEPLOY_SCRIPT_DIR: helperDir,
        PATH: `${fakeDockerBin}:${process.env.PATH}`,
      },
    },
    "y\n",
  );

  assert.equal(stderr, "");
  assert.match(stdout, /Continue\? \[y\/N\]/);
  assert.match(stdout, /\[1\/7\] Checking required tools and files/);
  assert.match(stdout, /fake preflight/);
  assert.match(stdout, /fake migration/);
  assert.match(stdout, /Skipping bootstrap \(\-\-skip-bootstrap\)/);
  assert.match(stdout, /\[7\/7\] Skipping service start \(\-\-no-start\)/);
});

test("deploy setup dry-run fails when nginx TLS files are missing", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hustleops-deploy-setup-missing-tls-"));
  const envFile = path.join(tmpRoot, ".env");
  const fakeDockerBin = await createFakeDockerBin();

  await writeFile(envFile, "HUSTLEOPS_TEST_ENV=1\n");

  await assert.rejects(
    execFileAsync(
      "bash",
      [
        deployScript,
        "setup",
        "--env-file",
        envFile,
        "--dry-run",
        "--yes",
        "--skip-pull",
        "--skip-signature-verify",
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          PATH: `${fakeDockerBin}:${process.env.PATH}`,
        },
      },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /nginx TLS certificate files are missing/);
      assert.doesNotMatch(error.stdout, /Running preflight checks/);
      return true;
    },
  );
});

test("deploy start dry-run starts ancillary proxy by default", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hustleops-deploy-ancillary-"));
  const envFile = path.join(tmpRoot, ".env");
  const fakeDockerBin = await createFakeDockerBin();

  await writeFile(envFile, "HUSTLEOPS_TEST_ENV=1\n");

  const { stdout, stderr } = await execFileAsync(
    "bash",
    [deployScript, "start", "--env-file", envFile, "--dry-run", "--yes"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${fakeDockerBin}:${process.env.PATH}`,
      },
    },
  );

  assert.equal(stderr, "");
  assert.match(stdout, /DRY RUN: mkdir -p .*data\/n8n\/redis/);
  assert.match(stdout, /DRY RUN: mkdir -p .*data\/opensearch/);
  assert.match(stdout, /DRY RUN: chown -R 1000:1000 .*data\/opensearch/);
  assert.match(stdout, /DRY RUN: mkdir -p .*data\/opensearch-dashboards/);
  assert.match(stdout, /DRY RUN: chown -R 1000:1000 .*data\/opensearch-dashboards/);
  assert.match(stdout, /docker compose [\s\S]*--profile ancillary-public[\s\S]* up [\s\S]* opensearch opensearch-dashboards nginx-ancillary/);
  assert.match(stdout, /docker compose [\s\S]*--profile ancillary-public[\s\S]* restart nginx-ancillary/);
  assert.ok(
    stdout.indexOf("opensearch opensearch-dashboards nginx-ancillary") <
      stdout.indexOf("restart nginx-ancillary"),
    "ancillary nginx should restart after Compose has ensured the service is running",
  );
  assert.doesNotMatch(stdout, /Skipping ancillary services/);
});

test("deploy start dry-run can skip ancillary proxy explicitly", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hustleops-deploy-skip-ancillary-"));
  const envFile = path.join(tmpRoot, ".env");
  const fakeDockerBin = await createFakeDockerBin();

  await writeFile(envFile, "HUSTLEOPS_TEST_ENV=1\n");

  const { stdout, stderr } = await execFileAsync(
    "bash",
    [deployScript, "start", "--env-file", envFile, "--dry-run", "--yes", "--skip-ancillary"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${fakeDockerBin}:${process.env.PATH}`,
      },
    },
  );

  assert.equal(stderr, "");
  assert.match(stdout, /Skipping ancillary services \(\-\-skip-ancillary\)/);
  assert.doesNotMatch(stdout, /--profile ancillary-public[\s\S]* nginx-ancillary/);
});

test("deploy down dry-run includes ancillary profile services", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hustleops-deploy-down-ancillary-"));
  const envFile = path.join(tmpRoot, ".env");
  const fakeDockerBin = await createFakeDockerBin();

  await writeFile(envFile, "HUSTLEOPS_TEST_ENV=1\n");

  const { stdout, stderr } = await execFileAsync(
    "bash",
    [deployScript, "down", "--env-file", envFile, "--dry-run", "--yes"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${fakeDockerBin}:${process.env.PATH}`,
      },
    },
  );

  assert.equal(stderr, "");
  assert.match(stdout, /DRY RUN: docker compose [\s\S]*--profile ancillary-public[\s\S]* down/);
});

test("deploy start dry-run skip-n8n also skips ancillary proxy", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hustleops-deploy-skip-n8n-"));
  const envFile = path.join(tmpRoot, ".env");
  const fakeDockerBin = await createFakeDockerBin();

  await writeFile(envFile, "HUSTLEOPS_TEST_ENV=1\n");

  const { stdout, stderr } = await execFileAsync(
    "bash",
    [deployScript, "start", "--env-file", envFile, "--dry-run", "--yes", "--skip-n8n"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${fakeDockerBin}:${process.env.PATH}`,
      },
    },
  );

  assert.equal(stderr, "");
  assert.match(stdout, /Skipping n8n services \(\-\-skip-n8n\)/);
  assert.match(stdout, /Skipping ancillary services because n8n was skipped/);
  assert.doesNotMatch(stdout, /--profile ancillary-public[\s\S]* nginx-ancillary/);
});

test("deploy restart dry-run stops then starts the full default stack", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hustleops-deploy-restart-"));
  const envFile = path.join(tmpRoot, ".env");
  const fakeDockerBin = await createFakeDockerBin();

  await writeFile(envFile, "HUSTLEOPS_TEST_ENV=1\n");

  const { stdout, stderr } = await execFileAsync(
    "bash",
    [deployScript, "restart", "--env-file", envFile, "--dry-run", "--yes"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${fakeDockerBin}:${process.env.PATH}`,
      },
    },
  );

  assert.equal(stderr, "");
  assert.match(stdout, /DRY RUN: docker compose .* stop/);
  assert.match(stdout, /up -d backend frontend nginx/);
  assert.match(stdout, /docker compose [\s\S]* restart nginx/);
  assert.match(stdout, /up -d n8n-postgres n8n-redis n8n n8n-worker task-runner-main task-runner-worker/);
  assert.match(stdout, /--profile ancillary-public[\s\S]* up [\s\S]* opensearch opensearch-dashboards nginx-ancillary/);
  assert.match(stdout, /--profile ancillary-public[\s\S]* restart nginx-ancillary/);
  assert.ok(
    stdout.indexOf("docker-compose.prod.yml stop") < stdout.indexOf("up -d backend frontend"),
    "restart should stop existing containers before starting the default stack",
  );
  assert.match(stdout, /Service access addresses:/);
});

test("deploy script help documents start and restart stack commands", async () => {
  const deploy = await readFile(path.join(projectRoot, "scripts", "deploy.sh"), "utf8");

  assert.match(deploy, /\{setup\|update\|start\|restart\|stop\|down\|status\|preflight\|backup\|migrate\|bootstrap\}/);
  assert.match(deploy, /start\s+Start stack if it was previously stopped or down/);
  assert.match(deploy, /restart\s+Restart stack/);
});

test("ancillary ports default to HTTPS external binds and mount TLS files", async () => {
  const envExample = await readFile(path.join(projectRoot, ".env.example"), "utf8");
  const compose = await readFile(path.join(projectRoot, "docker-compose.prod.yml"), "utf8");
  const nginxAncillary = composeServiceBlock(compose, "nginx-ancillary");

  assert.match(envExample, /^ANCILLARY_N8N_BIND=0\.0\.0\.0$/m);
  assert.match(envExample, /^ANCILLARY_DASHBOARDS_BIND=0\.0\.0\.0$/m);
  assert.match(compose, /\$\{ANCILLARY_N8N_BIND:-0\.0\.0\.0\}:5678:5678/);
  assert.match(compose, /\$\{ANCILLARY_DASHBOARDS_BIND:-0\.0\.0\.0\}:5601:5601/);
  assert.match(
    nginxAncillary,
    /\$\{NGINX_TLS_CERT_PATH:-\.\/nginx\/certs\/fullchain\.pem\}:\/etc\/nginx\/tls\/fullchain\.pem:ro/,
  );
  assert.match(
    nginxAncillary,
    /\$\{NGINX_TLS_KEY_PATH:-\.\/nginx\/certs\/privkey\.pem\}:\/etc\/nginx\/tls\/privkey\.pem:ro/,
  );
});

test("core nginx publishes HTTPS and mounts TLS files from env paths", async () => {
  const envExample = await readFile(path.join(projectRoot, ".env.example"), "utf8");
  const compose = await readFile(path.join(projectRoot, "docker-compose.prod.yml"), "utf8");
  const nginx = composeServiceBlock(compose, "nginx");

  assert.match(envExample, /^PUBLIC_HOST_ALIASES=$/m);
  assert.match(envExample, /^NGINX_TLS_CERT_PATH=\.\/nginx\/certs\/fullchain\.pem$/m);
  assert.match(envExample, /^NGINX_TLS_KEY_PATH=\.\/nginx\/certs\/privkey\.pem$/m);

  assert.match(nginx, /- "\$\{NGINX_HTTP_BIND:-0\.0\.0\.0\}:80:8080"/);
  assert.match(nginx, /- "\$\{NGINX_HTTPS_BIND:-0\.0\.0\.0\}:443:8443"/);
  assert.match(
    nginx,
    /\$\{NGINX_TLS_CERT_PATH:-\.\/nginx\/certs\/fullchain\.pem\}:\/etc\/nginx\/tls\/fullchain\.pem:ro/,
  );
  assert.match(
    nginx,
    /\$\{NGINX_TLS_KEY_PATH:-\.\/nginx\/certs\/privkey\.pem\}:\/etc\/nginx\/tls\/privkey\.pem:ro/,
  );
});

test("OpenSearch and Dashboards services are grouped under the ancillary profile", async () => {
  const compose = await readFile(path.join(projectRoot, "docker-compose.prod.yml"), "utf8");
  const backend = composeServiceBlock(compose, "backend");
  const opensearch = composeServiceBlock(compose, "opensearch");
  const dashboards = composeServiceBlock(compose, "opensearch-dashboards");
  const nginxAncillary = composeServiceBlock(compose, "nginx-ancillary");

  assert.doesNotMatch(backend, /depends_on:[\s\S]*opensearch:/);
  assert.match(opensearch, /profiles:\n      - ancillary-public/);
  assert.match(dashboards, /profiles:\n      - ancillary-public/);
  assert.match(dashboards, /depends_on:\n      opensearch:\n        condition: service_healthy/);
  assert.match(nginxAncillary, /depends_on:[\s\S]*opensearch-dashboards:\n        condition: service_started/);
});

test("ancillary proxy waits for n8n readiness before serving traffic", async () => {
  const compose = await readFile(path.join(projectRoot, "docker-compose.prod.yml"), "utf8");

  assert.match(compose, /^  n8n:\n[\s\S]*?healthcheck:\n[\s\S]*?healthz\/readiness/m);
  assert.match(
    compose,
    /^  nginx-ancillary:\n[\s\S]*?depends_on:\n[\s\S]*?      n8n:\n        condition: service_healthy/m,
  );
});

test("ancillary app proxies leave CSP to upstream services", async () => {
  const ancillaryNginx = await readFile(path.join(projectRoot, "nginx", "nginx.ancillary.conf"), "utf8");
  const compose = await readFile(path.join(projectRoot, "docker-compose.prod.yml"), "utf8");
  const validateNginx = await readFile(path.join(projectRoot, "scripts", "validate-nginx.sh"), "utf8");

  assert.match(
    ancillaryNginx,
    /listen 5678 ssl;[\s\S]*include \/etc\/nginx\/security-headers-no-csp\.conf;/,
  );
  assert.doesNotMatch(
    ancillaryNginx,
    /listen 5678 ssl;[\s\S]*include \/etc\/nginx\/security-headers\.conf;/,
  );
  assert.match(
    ancillaryNginx,
    /listen 5601 ssl;[\s\S]*include \/etc\/nginx\/security-headers-no-csp\.conf;/,
  );
  assert.doesNotMatch(
    ancillaryNginx,
    /listen 5601 ssl;[\s\S]*include \/etc\/nginx\/security-headers\.conf;/,
  );
  assert.match(
    compose,
    /- \.\/nginx\/security-headers-no-csp\.conf:\/etc\/nginx\/security-headers-no-csp\.conf:ro/,
  );
  assert.match(validateNginx, /security-headers-no-csp\.conf/);
});

test("ancillary nginx serves n8n and OpenSearch Dashboards over HTTPS", async () => {
  const nginx = await readFile(path.join(projectRoot, "nginx", "nginx.ancillary.conf"), "utf8");

  assert.match(nginx, /listen 5678 ssl;/);
  assert.match(nginx, /listen 5601 ssl;/);
  assert.match(nginx, /ssl_certificate \/etc\/nginx\/tls\/fullchain\.pem;/);
  assert.match(nginx, /ssl_certificate_key \/etc\/nginx\/tls\/privkey\.pem;/);
  assert.match(nginx, /Strict-Transport-Security "max-age=31536000; includeSubDomains" always;/);
  assert.match(nginx, /listen 5678 ssl;[\s\S]*proxy_pass http:\/\/n8n:5678;/);
  assert.match(nginx, /listen 5678 ssl;[\s\S]*proxy_set_header Host\s+\$http_host;/);
  assert.match(nginx, /listen 5678 ssl;[\s\S]*proxy_set_header X-Forwarded-Host\s+\$http_host;/);
  assert.match(nginx, /listen 5601 ssl;[\s\S]*proxy_pass http:\/\/opensearch-dashboards:5601;/);
  assert.match(nginx, /listen 5601 ssl;[\s\S]*proxy_set_header Host\s+\$http_host;/);
  assert.match(nginx, /listen 5601 ssl;[\s\S]*proxy_set_header X-Forwarded-Host\s+\$http_host;/);
});

test("core nginx redirects HTTP and serves the app over HTTPS", async () => {
  const nginx = await readFile(path.join(projectRoot, "nginx", "nginx.conf"), "utf8");

  assert.match(nginx, /listen 8080;/);
  assert.match(nginx, /return 301 https:\/\/\$host\$request_uri;/);
  assert.match(nginx, /listen 8443 ssl;/);
  assert.match(nginx, /http2 on;/);
  assert.match(nginx, /ssl_certificate \/etc\/nginx\/tls\/fullchain\.pem;/);
  assert.match(nginx, /ssl_certificate_key \/etc\/nginx\/tls\/privkey\.pem;/);
  assert.match(nginx, /Strict-Transport-Security "max-age=31536000; includeSubDomains" always;/);
  assert.match(nginx, /location \/ \{[\s\S]*proxy_pass http:\/\/frontend:8080;/);
  assert.match(nginx, /location \/api\/ \{[\s\S]*proxy_pass http:\/\/backend:3000\/api\/;/);
  assert.match(nginx, /location \/socket\.io\/ \{[\s\S]*proxy_pass http:\/\/backend:3000\/socket\.io\/;/);
});

test("postgres 18 services mount persistent parent directories", async () => {
  const compose = await readFile(path.join(projectRoot, "docker-compose.prod.yml"), "utf8");

  assert.match(compose, /postgres:[^\n]*18-alpine/);
  assert.match(compose, /n8n-postgres:[\s\S]*?image: postgres:[^\n]*18-alpine/);
  assert.match(compose, /- \.\/data\/postgres:\/var\/lib\/postgresql$/m);
  assert.match(compose, /- \.\/data\/n8n\/postgres:\/var\/lib\/postgresql$/m);
  assert.doesNotMatch(compose, /\/var\/lib\/postgresql\/data\b/);
});

test("deploy start blocks legacy n8n postgres root data before compose up", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hustleops-legacy-n8n-postgres-"));
  const envFile = path.join(tmpRoot, ".env");
  const composeFile = path.join(tmpRoot, "docker-compose.prod.yml");
  const legacyDataDir = path.join(tmpRoot, "data", "n8n", "postgres");
  const fakeDockerBin = await createFakeDockerBin();

  await mkdir(legacyDataDir, { recursive: true });
  await writeFile(path.join(legacyDataDir, "PG_VERSION"), "17\n");
  await writeFile(envFile, "HUSTLEOPS_TEST_ENV=1\n");
  await writeFile(composeFile, "services: {}\n");

  await assert.rejects(
    execFileAsync(
      "bash",
      [
        deployScript,
        "start",
        "--env-file",
        envFile,
        "--compose-file",
        composeFile,
        "--dry-run",
        "--yes",
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          HUSTLEOPS_DEPLOY_PROJECT_ROOT: tmpRoot,
          PATH: `${fakeDockerBin}:${process.env.PATH}`,
        },
      },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /legacy root layout/);
      assert.match(error.stderr, /data\/n8n\/postgres/);
      assert.doesNotMatch(error.stdout, /n8n-postgres n8n-redis/);
      return true;
    },
  );
});

test("deploy start blocks legacy main postgres pgdata before compose up", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hustleops-legacy-main-postgres-"));
  const envFile = path.join(tmpRoot, ".env");
  const composeFile = path.join(tmpRoot, "docker-compose.prod.yml");
  const legacyDataDir = path.join(tmpRoot, "data", "postgres", "pgdata");
  const fakeDockerBin = await createFakeDockerBin();

  await mkdir(legacyDataDir, { recursive: true });
  await writeFile(path.join(legacyDataDir, "PG_VERSION"), "18\n");
  await writeFile(envFile, "HUSTLEOPS_TEST_ENV=1\n");
  await writeFile(composeFile, "services: {}\n");

  await assert.rejects(
    execFileAsync(
      "bash",
      [
        deployScript,
        "start",
        "--env-file",
        envFile,
        "--compose-file",
        composeFile,
        "--dry-run",
        "--yes",
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          HUSTLEOPS_DEPLOY_PROJECT_ROOT: tmpRoot,
          PATH: `${fakeDockerBin}:${process.env.PATH}`,
        },
      },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /legacy pgdata layout/);
      assert.match(error.stderr, /data\/postgres\/pgdata/);
      assert.doesNotMatch(error.stdout, /backend frontend nginx/);
      return true;
    },
  );
});

test("deploy debug forwards debug verbosity into preflight", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hustleops-deploy-debug-"));
  const envFile = path.join(tmpRoot, ".env");
  const fakeDockerBin = await createFakeDockerBin();
  const helperDir = await createRecordingPreflightHelper();

  await writeFile(envFile, "HUSTLEOPS_TEST_ENV=1\n");

  const { stdout, stderr } = await execFileAsync(
    "bash",
    [
      deployScript,
      "preflight",
      "--env-file",
      envFile,
      "--skip-pull",
      "--skip-signature-verify",
      "--debug",
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        HUSTLEOPS_DEPLOY_SCRIPT_DIR: helperDir,
        PATH: `${fakeDockerBin}:${process.env.PATH}`,
      },
    },
  );

  assert.match(stderr, /\+ /);
  assert.match(stdout, /--debug/);
});

test("preflight debug leaves docker pull progress visible", async () => {
  const preflight = await readFile(path.join(projectRoot, "scripts", "preflight.sh"), "utf8");

  assert.match(preflight, /PREFLIGHT_VERBOSITY=1/);
  assert.match(preflight, /--debug\)/);
  assert.match(preflight, /pull_image "\$HUSTLEOPS_BACKEND_IMAGE"/);
  assert.match(preflight, /docker pull --platform linux\/amd64 "\$image_ref"\n/);
  assert.match(preflight, /docker pull --platform linux\/amd64 "\$image_ref" >\/dev\/null/);
});

test("deploy script includes install guidance for required operator tools", async () => {
  const deploy = await readFile(path.join(projectRoot, "scripts", "deploy.sh"), "utf8");

  assert.match(deploy, /missing_required_tools=\(\)/);
  assert.match(deploy, /Docker Engine with Docker Compose v2 is required/);
  assert.match(deploy, /Node\.js 24 or newer is required/);
  assert.match(deploy, /cosign is required for release image signature verification/);
  assert.match(deploy, /Install missing tools now\? \[y\/N\]/);
});

test("preflight script includes install guidance for docker node and cosign", async () => {
  const preflight = await readFile(path.join(projectRoot, "scripts", "preflight.sh"), "utf8");

  assert.match(preflight, /missing_required_tools=\(\)/);
  assert.match(preflight, /Docker Engine with Docker Compose v2 is required/);
  assert.match(preflight, /Node\.js 24 or newer is required/);
  assert.match(preflight, /cosign is required for release image signature verification/);
  assert.match(preflight, /Install missing tools now\? \[y\/N\]/);
});

test("setup flow can prompt for self-signed nginx certificate generation", async () => {
  const deploy = await readFile(path.join(projectRoot, "scripts", "deploy.sh"), "utf8");

  assert.match(deploy, /--generate-self-signed-cert/);
  assert.match(deploy, /Generate a self-signed certificate for these names\?/);
  assert.match(deploy, /setup-nginx-self-signed-cert\.sh/);
  assert.match(deploy, /ensure_nginx_tls_material/);
});

test("preflight validates nginx TLS certificate paths", async () => {
  const preflight = await readFile(path.join(projectRoot, "scripts", "preflight.sh"), "utf8");

  assert.match(preflight, /NGINX_TLS_CERT_PATH/);
  assert.match(preflight, /NGINX_TLS_KEY_PATH/);
  assert.match(preflight, /required_plain=\([\s\S]*NGINX_TLS_CERT_PATH[\s\S]*NGINX_TLS_KEY_PATH/);
  assert.match(preflight, /validate_nginx_tls_files/);
  assert.match(preflight, /nginx TLS certificate file not found/);
});

test("nginx validation script supplies temporary TLS files", async () => {
  const validateNginx = await readFile(path.join(projectRoot, "scripts", "validate-nginx.sh"), "utf8");

  assert.match(validateNginx, /mktemp -d/);
  assert.match(validateNginx, /openssl req -x509/);
  assert.match(validateNginx, /chmod 0644 "\$TLS_TMP_DIR\/fullchain\.pem" "\$TLS_TMP_DIR\/privkey\.pem"/);
  assert.match(validateNginx, /\/etc\/nginx\/tls\/fullchain\.pem:ro/);
  assert.match(validateNginx, /\/etc\/nginx\/tls\/privkey\.pem:ro/);
});

test("self-signed nginx helper creates DNS and IP SANs", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hustleops-nginx-cert-"));
  const envFile = path.join(tmpRoot, ".env");
  const certFile = path.join(tmpRoot, "nginx", "certs", "fullchain.pem");
  const keyFile = path.join(tmpRoot, "nginx", "certs", "privkey.pem");

  await writeFile(
    envFile,
    [
      "PUBLIC_HOSTNAME=ops.example.test",
      "PUBLIC_HOST_ALIASES=ops.internal.example.test,10.0.0.15,192.168.1.20",
      `NGINX_TLS_CERT_PATH=${certFile}`,
      `NGINX_TLS_KEY_PATH=${keyFile}`,
      "",
    ].join("\n"),
  );

  const helper = path.join(projectRoot, "scripts", "setup-nginx-self-signed-cert.sh");
  await execFileAsync("bash", [helper, "--env-file", envFile], { cwd: projectRoot });

  const { stdout } = await execFileAsync("openssl", ["x509", "-in", certFile, "-noout", "-text"], {
    cwd: projectRoot,
  });

  assert.match(stdout, /DNS:ops\.example\.test/);
  assert.match(stdout, /DNS:ops\.internal\.example\.test/);
  assert.match(stdout, /IP Address:10\.0\.0\.15/);
  assert.match(stdout, /IP Address:192\.168\.1\.20/);
});

test("CI env generator writes nginx TLS fixture paths", async () => {
  const script = await readFile(path.join(projectRoot, "scripts", "make-ci-env.mjs"), "utf8");

  assert.match(script, /NGINX_TLS_CERT_PATH: "\.\/\.hustleops\/nginx\/certs\/fullchain\.pem"/);
  assert.match(script, /NGINX_TLS_KEY_PATH: "\.\/\.hustleops\/nginx\/certs\/privkey\.pem"/);
  assert.match(script, /writeNginxTestCerts/);
  assert.match(script, /execFileAsync\("openssl"/);
  assert.match(script, /subjectAltName = DNS:hustleops\.local,DNS:ops\.internal\.hustleops\.local,IP:127\.0\.0\.1/);
  assert.match(script, /POSTGRES_PASSWORD_ENCODED/);
  assert.match(script, /encodeURIComponent\(REPLACEMENTS\.POSTGRES_PASSWORD\)/);
});

test("deploy start dry-run prints service access addresses", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hustleops-deploy-addresses-"));
  const envFile = path.join(tmpRoot, ".env");
  const fakeDockerBin = await createFakeDockerBin();

  await writeFile(
    envFile,
    [
      "PUBLIC_HOSTNAME=ops.example.test",
      "ANCILLARY_N8N_BIND=0.0.0.0",
      "ANCILLARY_DASHBOARDS_BIND=0.0.0.0",
      "",
    ].join("\n"),
  );

  const { stdout, stderr } = await execFileAsync(
    "bash",
    [deployScript, "start", "--env-file", envFile, "--dry-run", "--yes"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${fakeDockerBin}:${process.env.PATH}`,
      },
    },
  );

  assert.equal(stderr, "");
  assert.match(stdout, /Service access addresses:/);
  assert.match(stdout, /HustleOps app: https:\/\/ops\.example\.test/);
  assert.match(stdout, /n8n: https:\/\/ops\.example\.test:5678/);
  assert.match(stdout, /OpenSearch Dashboards: https:\/\/ops\.example\.test:5601/);
});

test("operator docs describe default ancillary exposure and debug behavior", async () => {
  const readme = await readFile(path.join(projectRoot, "README.md"), "utf8");
  const scriptsReadme = await readFile(path.join(projectRoot, "scripts", "README.md"), "utf8");

  assert.match(readme, /n8n and the OpenSearch ancillary bundle start by default/);
  assert.match(readme, /OpenSearch and OpenSearch Dashboards are started together/);
  assert.match(readme, /Use `--skip-ancillary`/);
  assert.match(readme, /`--debug` leaves Docker image pull progress visible/);
  assert.match(readme, /After startup, `deploy\.sh` prints service access addresses/);
  assert.match(readme, /PUBLIC_HOST_ALIASES/);
  assert.match(readme, /port `443` for HTTPS; port `80` redirects to HTTPS/);
  assert.match(readme, /n8n: port `5678` for HTTPS/);
  assert.match(readme, /OpenSearch Dashboards: port `5601` for HTTPS/);
  assert.match(readme, /setup to generate a self-signed certificate/);
  assert.match(scriptsReadme, /starts core, n8n, and the OpenSearch\/Dashboards ancillary bundle by default/);
  assert.match(scriptsReadme, /debug mode shows Docker pull progress/);
  assert.match(scriptsReadme, /self-signed nginx certificate/);
  assert.match(scriptsReadme, /NGINX_TLS_CERT_PATH/);
});

test("pr checks workflow exposes stable required check names", async () => {
  const workflow = await readFile(path.join(projectRoot, ".github", "workflows", "pr-checks.yml"), "utf8");

  assert.match(workflow, /\n  validate:\n\s+name: validate\n/);
  assert.match(workflow, /\n  action-security:\n\s+name: action-security\n/);
  assert.match(workflow, /bash scripts\/ci\/check-actions-pinning\.sh/);
});

test("release workflow publishes automatically from verified release tags", async () => {
  const workflow = await readFile(path.join(projectRoot, ".github", "workflows", "release.yml"), "utf8");

  assert.match(workflow, /on:\n  push:\n    tags:\n      - "v\*"/);
  assert.doesNotMatch(workflow, /workflow_dispatch:/);
  assert.match(workflow, /\n  verify-release-source:\n\s+name: verify-release-source\n/);
  assert.match(workflow, /\n  build-release:\n\s+name: build-release\n[\s\S]*?needs:\n\s+- verify-release-source\n/);
  assert.doesNotMatch(workflow, /\n  approve-production-release:\n/);
  assert.match(workflow, /\n  publish-release:\n\s+name: publish-release\n[\s\S]*?needs:\n\s+- build-release\n/);
  assert.doesNotMatch(workflow, /if: github\.event_name == 'workflow_dispatch'/);
  assert.doesNotMatch(workflow, /environment: production/);
  assert.doesNotMatch(workflow, /PRODUCTION_RELEASE_APPROVER/);
});

test("release workflow isolates tests from the release tag environment", async () => {
  const workflow = await readFile(path.join(projectRoot, ".github", "workflows", "release.yml"), "utf8");

  assert.match(workflow, /RELEASE_TAG='' node --test tests\/\*\.test\.mjs/);
});

test("workflows do not grant content writes to the default GitHub token", async () => {
  const workflowDir = path.join(projectRoot, ".github", "workflows");
  const workflowFiles = (await readdir(workflowDir)).filter((fileName) => /\.(ya?ml)$/.test(fileName));
  const writeGrants = [];

  for (const fileName of workflowFiles) {
    const workflow = await readFile(path.join(workflowDir, fileName), "utf8");
    const lines = workflow.split("\n");

    for (const [index, line] of lines.entries()) {
      if (!/^\s+contents:\s+write\s*$/.test(line)) {
        continue;
      }

      const jobLine = lines
        .slice(0, index)
        .reverse()
        .find((candidate) => /^  [a-zA-Z0-9_-]+:\s*$/.test(candidate));
      const job = jobLine?.trim().replace(/:$/, "") ?? "<workflow>";

      writeGrants.push({ fileName, job });
    }
  }

  assert.deepEqual(writeGrants, []);
});

test("workflow job display names are stable lowercase kebab-case", async () => {
  const workflowDir = path.join(projectRoot, ".github", "workflows");
  const workflowFiles = (await readdir(workflowDir)).filter((fileName) => /\.(ya?ml)$/.test(fileName));
  const jobNames = [];

  for (const fileName of workflowFiles) {
    const workflow = await readFile(path.join(workflowDir, fileName), "utf8");

    for (const line of workflow.split("\n")) {
      const match = line.match(/^ {4}name:\s+(.+)$/);
      if (match) {
        jobNames.push({ fileName, name: match[1].trim() });
      }
    }
  }

  for (const { fileName, name } of jobNames) {
    assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${fileName} job name ${name} must be lowercase kebab-case`);
  }
});

test("create-release-tag workflow uses GitHub App tag creation without an approver gate", async () => {
  const workflow = await readFile(path.join(projectRoot, ".github", "workflows", "create-release-tag.yml"), "utf8");

  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /RELEASE_TAG_APPROVER/);
  assert.doesNotMatch(workflow, /Verify release tag approver/);
  assert.match(workflow, /actions\/create-github-app-token@[0-9a-f]{40}/);
  assert.match(workflow, /RELEASE_APP_ID/);
  assert.match(workflow, /RELEASE_APP_PRIVATE_KEY/);
  assert.match(workflow, /client-id: \$\{\{ vars\.RELEASE_APP_ID \}\}/);
  assert.doesNotMatch(workflow, /^\s+app-id:/m);
  assert.match(workflow, /permission-contents: write/);
  assert.match(workflow, /git tag -a "\$VERSION" -m "Release \$VERSION"/);
  assert.match(workflow, /RELEASE_TAG_TOKEN: \$\{\{ steps\.release-tag-token\.outputs\.token \}\}/);
  assert.match(workflow, /x-access-token:\$\{RELEASE_TAG_TOKEN\}@github\.com/);
  assert.doesNotMatch(workflow, /RELEASE_TAG_APP_ID/);
  assert.doesNotMatch(workflow, /RELEASE_TAG_APP_PRIVATE_KEY/);
  assert.doesNotMatch(workflow, /RELEASE_TAG_DEPLOY_KEY/);
  assert.doesNotMatch(workflow, /permissions:\n  contents: write/);
});

test("release workflow publishes with the release GitHub App token", async () => {
  const workflow = await readFile(path.join(projectRoot, ".github", "workflows", "release.yml"), "utf8");

  assert.match(workflow, /Verify release GitHub App configuration/);
  assert.match(workflow, /actions\/create-github-app-token@[0-9a-f]{40}/);
  assert.match(workflow, /RELEASE_APP_ID/);
  assert.match(workflow, /RELEASE_APP_PRIVATE_KEY/);
  assert.match(workflow, /client-id: \$\{\{ vars\.RELEASE_APP_ID \}\}/);
  assert.doesNotMatch(workflow, /^\s+app-id:/m);
  assert.match(workflow, /permission-contents: write/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ steps\.release-token\.outputs\.token \}\}/);
  assert.doesNotMatch(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(workflow, /RELEASE_TAG_APP_ID/);
  assert.doesNotMatch(workflow, /RELEASE_TAG_APP_PRIVATE_KEY/);
  assert.doesNotMatch(workflow, /permissions:\n\s+contents: write/);
});

test("update-from-contract workflow trusts the canonical source app release identity", async () => {
  const workflow = await readFile(path.join(projectRoot, ".github", "workflows", "update-from-contract.yml"), "utf8");

  assert.match(
    workflow,
    /CONTRACT_CERTIFICATE_IDENTITY_PATTERN: https:\/\/github\.com\/HustleOps\/hustleops-app\/\.github\/workflows\/release\.yml@refs\/tags\/v\*/,
  );
  assert.match(
    workflow,
    /CONTRACT_CERTIFICATE_IDENTITY_REGEXP: \^https:\/\/github\\\.com\/HustleOps\/hustleops-app\/\\\.github\/workflows\/release\\\.yml@refs\/tags\/v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/,
  );
  assert.doesNotMatch(workflow, /HustleOps\/HustleOps\/\.github\/workflows\/release\.yml/);
});

test("update-from-contract workflow pushes automation PRs with the release GitHub App token", async () => {
  const workflow = await readFile(path.join(projectRoot, ".github", "workflows", "update-from-contract.yml"), "utf8");

  assert.match(
    workflow,
    /- name: Detect public deploy changes[\s\S]*?has_changes=false[\s\S]*?echo "has-changes=\$\{has_changes\}"[\s\S]*?- name: Verify release GitHub App configuration for public deploy updates[\s\S]*?if: steps\.public-deploy-changes\.outputs\.has-changes == 'true'[\s\S]*?- name: Create release GitHub App token for public deploy updates/,
  );
  assert.match(workflow, /actions\/create-github-app-token@[0-9a-f]{40}/);
  assert.match(workflow, /RELEASE_APP_CLIENT_ID/);
  assert.doesNotMatch(workflow, /RELEASE_APP_ID/);
  assert.match(workflow, /RELEASE_APP_PRIVATE_KEY/);
  assert.match(workflow, /\n    permissions:\n      contents: read\n/);
  assert.doesNotMatch(workflow, /\n      pull-requests: write\n/);
  assert.match(workflow, /client-id: \$\{\{ vars\.RELEASE_APP_CLIENT_ID \}\}/);
  assert.doesNotMatch(workflow, /^\s+app-id:/m);
  assert.match(workflow, /permission-contents: write/);
  assert.match(workflow, /permission-pull-requests: write/);
  assert.match(workflow, /APP_SLUG: \$\{\{ steps\.public-deploy-update-token\.outputs\.app-slug \}\}/);
  assert.match(workflow, /BRANCH_PUSH_TOKEN: \$\{\{ steps\.public-deploy-update-token\.outputs\.token \}\}/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ steps\.public-deploy-update-token\.outputs\.token \}\}/);
  assert.doesNotMatch(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /x-access-token:\$\{BRANCH_PUSH_TOKEN\}@github\.com\/\$\{REPOSITORY\}\.git/);
  assert.match(workflow, /git config user\.name "\$COMMITTER_NAME"/);
  assert.doesNotMatch(workflow, /PUBLIC_DEPLOY_UPDATE_APP_ID/);
  assert.doesNotMatch(workflow, /PUBLIC_DEPLOY_UPDATE_APP_PRIVATE_KEY/);
  assert.doesNotMatch(workflow, /PUBLIC_DEPLOY_UPDATE_DEPLOY_KEY/);
  assert.doesNotMatch(workflow, /ssh-keyscan|GIT_SSH_COMMAND|public-deploy-update-deploy-key|git@github\.com/);
});

test("workflows do not call the removed production approver helper", async () => {
  const workflowDir = path.join(projectRoot, ".github", "workflows");
  const workflowFiles = (await readdir(workflowDir)).filter((fileName) => /\.(ya?ml)$/.test(fileName));

  for (const fileName of workflowFiles) {
    const workflow = await readFile(path.join(workflowDir, fileName), "utf8");

    assert.doesNotMatch(
      workflow,
      /verify-production-approver\.sh|PRODUCTION_RELEASE_APPROVER|PRODUCTION_DEPLOYMENT_APPROVER|RELEASE_TAG_APPROVER/,
      `${fileName} should not reference removed approver controls`,
    );
  }
});

test("required workflow files expose stable names and jobs", async () => {
  const workflowDir = path.join(projectRoot, ".github", "workflows");
  const prChecks = await readFile(path.join(workflowDir, "pr-checks.yml"), "utf8");
  const createReleaseTag = await readFile(path.join(workflowDir, "create-release-tag.yml"), "utf8");
  const release = await readFile(path.join(workflowDir, "release.yml"), "utf8");
  const rulesetAudit = await readFile(path.join(workflowDir, "ruleset-audit.yml"), "utf8");
  const deploy = await readFile(path.join(workflowDir, "deploy.yml"), "utf8");

  assert.match(prChecks, /^name: Pull Request Checks$/m);
  assert.match(prChecks, /\n  validate:\n\s+name: validate\n/);
  assert.match(prChecks, /\n  action-security:\n\s+name: action-security\n/);

  assert.match(createReleaseTag, /^name: Create Release Tag$/m);
  assert.match(createReleaseTag, /\n  create-release-tag:\n\s+name: create-release-tag\n/);

  assert.match(release, /^name: Release$/m);
  assert.match(release, /\n  verify-release-source:\n\s+name: verify-release-source\n/);
  assert.match(release, /\n  build-release:\n\s+name: build-release\n/);
  assert.doesNotMatch(release, /\n  approve-production-release:\n/);
  assert.match(release, /\n  publish-release:\n\s+name: publish-release\n/);
  assert.doesNotMatch(release, /environment: production/);

  assert.match(rulesetAudit, /^name: Ruleset Audit$/m);
  assert.match(rulesetAudit, /\n  audit-rulesets:\n\s+name: audit-rulesets\n/);
  assert.match(rulesetAudit, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(rulesetAudit, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/rulesets" --jq '\.\[\] \| \{name, target, enforcement, bypass_actors, conditions\}'/);

  assert.match(deploy, /^name: Deploy App$/m);
  assert.match(deploy, /\n  build:\n\s+name: build\n/);
  assert.doesNotMatch(deploy, /\n  approve-production-deploy:\n/);
  assert.match(deploy, /\n  deploy:\n\s+name: deploy\n/);
  assert.doesNotMatch(deploy, /environment: production/);
  assert.doesNotMatch(deploy, /PRODUCTION_DEPLOYMENT_APPROVER/);
});
