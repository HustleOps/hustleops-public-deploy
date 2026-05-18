#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const scriptDir = import.meta.dirname;
const projectRoot = path.resolve(scriptDir, "..");
const IMAGE_KEYS = ["backend", "frontend", "migration"];

function parseArgs(argv) {
  const args = {
    "manifest-file": path.join(projectRoot, "release-manifest.json"),
    "verification-file": path.join(projectRoot, "release-verification.json"),
    "release-dir": path.join(projectRoot, "releases"),
    "output": path.join(projectRoot, ".hustleops", "public-release-notes.md"),
    "github-output": "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (!argument.startsWith("--")) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    const key = argument.slice(2);
    const value = argv[index + 1];

    if (!(key in args)) {
      throw new Error(`Unknown argument: --${key}.`);
    }

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}.`);
    }

    args[key] = value;
    index += 1;
  }

  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      value ? path.resolve(value) : value,
    ]),
  );
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireString(value, field) {
  const normalized = `${value ?? ""}`.trim();

  if (!normalized) {
    throw new Error(`${field} is required.`);
  }

  return normalized;
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message);
  }
}

function relativePath(filePath) {
  return path.relative(projectRoot, filePath).split(path.sep).join("/");
}

function releaseVersionFromTag(tag) {
  const match = /^v(?<version>\d+\.\d+\.\d+)$/.exec(tag);

  if (!match?.groups?.version) {
    throw new Error("release tag must match v<major>.<minor>.<patch>.");
  }

  return match.groups.version;
}

function validateReleaseMetadata({ manifest, verification, releaseRecord, releaseRecordPath }) {
  const tag = requireString(manifest.release?.tag, "release-manifest.json release.tag");
  const version = requireString(manifest.release?.version, "release-manifest.json release.version");

  assertEqual(version, releaseVersionFromTag(tag), "release-manifest.json release.version must match release.tag");
  assertEqual(
    requireString(verification.release?.tag, "release-verification.json release.tag"),
    tag,
    "release-verification.json release.tag must match release-manifest.json release.tag",
  );
  assertEqual(
    requireString(releaseRecord.release?.tag, `${relativePath(releaseRecordPath)} release.tag`),
    tag,
    `${relativePath(releaseRecordPath)} release.tag must match release-manifest.json release.tag`,
  );
  assertEqual(
    requireString(releaseRecord.release?.commitSha, `${relativePath(releaseRecordPath)} release.commitSha`),
    requireString(manifest.release?.commitSha, "release-manifest.json release.commitSha"),
    `${relativePath(releaseRecordPath)} release.commitSha must match release-manifest.json release.commitSha`,
  );

  return { tag, version };
}

function imageRows(manifest, releaseRecord) {
  return IMAGE_KEYS.map((imageKey) => {
    const manifestImage = manifest.images?.[imageKey];
    const releaseImage = releaseRecord.images?.[imageKey];
    const digest = requireString(manifestImage?.digest, `release-manifest.json images.${imageKey}.digest`);
    const immutableRef = requireString(releaseImage?.immutableRef, `release record images.${imageKey}.immutableRef`);

    assertEqual(
      requireString(releaseImage?.digest, `release record images.${imageKey}.digest`),
      digest,
      `release record images.${imageKey}.digest must match release-manifest.json`,
    );

    return `| ${imageKey} | \`${immutableRef}\` | \`${digest}\` |`;
  });
}

function formatRequiredArtifacts(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("trustPolicy.requiredArtifacts must include at least one artifact.");
  }

  return value.map((artifact) => `\`${requireString(artifact, "trustPolicy.requiredArtifacts item")}\``).join(", ");
}

function buildNotes({ manifest, verification, releaseRecord, releaseRecordPath }) {
  const { tag } = validateReleaseMetadata({
    manifest,
    verification,
    releaseRecord,
    releaseRecordPath,
  });
  const release = manifest.release;
  const trustPolicy = verification.trustPolicy ?? {};
  const contract = releaseRecord.contract ?? {};
  const deploymentTrigger = requireString(
    manifest.deploy?.trigger ?? releaseRecord.deployment?.trigger,
    "deploy.trigger",
  );
  const releaseRecordRelativePath = relativePath(releaseRecordPath);

  return [
    "## Public Contract",
    "",
    "This public deploy release is generated from the signed HustleOps release contract and publishes the operator-facing deployment contract as a release asset.",
    "",
    `- Source release: [${release.tag}](${requireString(release.url, "release.url")})`,
    `- Source version: \`${requireString(release.version, "release.version")}\``,
    `- Source commit: \`${requireString(release.commitSha, "release.commitSha")}\``,
    `- Released at: \`${requireString(release.releasedAt, "release.releasedAt")}\``,
    `- Contract ref: \`${requireString(contract.ref, "contract.ref")}\``,
    `- Contract digest: \`${requireString(contract.digest, "contract.digest")}\``,
    `- Contract digest ref: \`${requireString(contract.digestRef, "contract.digestRef")}\``,
    `- Public contract asset: \`${releaseRecordRelativePath}\``,
    `- Deployment trigger: \`${deploymentTrigger}\``,
    "",
    "## Runtime Images",
    "",
    "| Service | Immutable image | Digest |",
    "| --- | --- | --- |",
    ...imageRows(manifest, releaseRecord),
    "",
    "## Operator Update",
    "",
    "After downloading or pulling this public deploy release, update the deployment environment and run:",
    "",
    "```bash",
    "./scripts/deploy.sh update --env-file .env",
    "```",
    "",
    "Operator-provided secrets in `.env` are preserved; runtime images are pinned in `docker-compose.prod.yml`, and release metadata values sync from `.env.example`.",
    "",
    "## Verification",
    "",
    `- Release metadata is validated across \`.env.example\`, \`docker-compose.prod.yml\`, \`release-manifest.json\`, \`release-verification.json\`, \`deployment/release-trigger.txt\`, and \`${releaseRecordRelativePath}\`.`,
    `- Runtime image signatures are expected from \`${requireString(trustPolicy.issuer, "trustPolicy.issuer")}\`.`,
    `- Certificate identity: \`${requireString(trustPolicy.certificateIdentity, "trustPolicy.certificateIdentity")}\``,
    `- Required artifacts: ${formatRequiredArtifacts(trustPolicy.requiredArtifacts)}`,
    "",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await readJson(args["manifest-file"], "release manifest");
  const verification = await readJson(args["verification-file"], "release verification");
  const tag = requireString(manifest.release?.tag, "release-manifest.json release.tag");
  const releaseRecordPath = path.join(args["release-dir"], `${tag}.json`);
  const releaseRecord = await readJson(releaseRecordPath, `release record ${tag}`);
  const notes = buildNotes({
    manifest,
    verification,
    releaseRecord,
    releaseRecordPath,
  });
  const githubOutputs = [
    `tag=${tag}`,
    `title=HustleOps Public Deploy ${tag}`,
    `release_record_file=${relativePath(releaseRecordPath)}`,
  ].join("\n");

  await mkdir(path.dirname(args.output), { recursive: true });
  await writeFile(args.output, notes);

  if (args["github-output"]) {
    await mkdir(path.dirname(args["github-output"]), { recursive: true });
    await writeFile(args["github-output"], `${githubOutputs}\n`);
  }

  process.stdout.write(`${JSON.stringify(
    {
      tag,
      title: `HustleOps Public Deploy ${tag}`,
      output: args.output,
      releaseRecordFile: relativePath(releaseRecordPath),
    },
    null,
    2,
  )}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
