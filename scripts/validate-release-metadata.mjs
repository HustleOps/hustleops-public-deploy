#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const scriptDir = import.meta.dirname;
const projectRoot = path.resolve(scriptDir, "..");
const IMAGE_KEYS = ["backend", "frontend", "migration"];
const COMPOSE_IMAGE_SERVICES = {
  backend: ["backend"],
  frontend: ["frontend"],
  migration: ["backend-migrate", "backend-bootstrap"],
};
const REQUIRED_ENV_KEYS = [
  "HUSTLEOPS_RELEASE_TAG",
  "HUSTLEOPS_RELEASE_TRIGGER",
];

function parseArgs(argv) {
  const args = {
    "env-file": path.join(projectRoot, ".env"),
    "compose-file": path.join(projectRoot, "docker-compose.prod.yml"),
    "manifest-file": path.join(projectRoot, "release-manifest.json"),
    "verification-file": path.join(projectRoot, "release-verification.json"),
    "deployment-trigger-file": path.join(projectRoot, "deployment", "release-trigger.txt"),
    "release-dir": path.join(projectRoot, "releases"),
    "signature-plan-file": "",
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

async function readTrimmed(filePath, label) {
  try {
    return (await readFile(filePath, "utf8")).trim();
  } catch (error) {
    throw new Error(`Could not read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function trim(value) {
  return `${value ?? ""}`.trim();
}

async function readEnv(filePath) {
  const content = await readFile(filePath, "utf8");
  const values = new Map();

  for (const line of content.split(/\n/)) {
    if (/^\s*(#|$)/.test(line)) {
      continue;
    }

    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) {
      continue;
    }

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values.set(match[1], value);
  }

  for (const key of REQUIRED_ENV_KEYS) {
    if (!trim(values.get(key))) {
      throw new Error(`${key} is required in ${filePath}.`);
    }
  }

  return values;
}

function requireString(value, field) {
  const normalized = trim(value);

  if (!normalized) {
    throw new Error(`${field} is required.`);
  }

  return normalized;
}

function versionFromTag(tag) {
  const match = /^v(?<version>\d+\.\d+\.\d+)$/.exec(tag);

  if (!match?.groups?.version) {
    throw new Error("release tag must match v<major>.<minor>.<patch>.");
  }

  return match.groups.version;
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message);
  }
}

function composeServiceBlock(compose, serviceName, composeFile) {
  const escapedName = serviceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = compose.match(new RegExp(`^  ${escapedName}:\\n[\\s\\S]*?(?=^  [A-Za-z0-9_-]+:\\n|^networks:)`, "m"));

  if (!match) {
    throw new Error(`${composeFile} is missing service ${serviceName}.`);
  }

  return match[0];
}

function unquoteComposeValue(value) {
  const normalized = value.trim();

  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    return normalized.slice(1, -1);
  }

  return normalized;
}

function readComposeImageRef(compose, serviceName, composeFile) {
  const service = composeServiceBlock(compose, serviceName, composeFile);
  const match = service.match(/^    image:\s*(.+)$/m);

  if (!match) {
    throw new Error(`${composeFile} service ${serviceName} is missing image.`);
  }

  return unquoteComposeValue(match[1]);
}

async function readComposeImages(filePath) {
  const compose = await readFile(filePath, "utf8");

  return Object.fromEntries(
    Object.entries(COMPOSE_IMAGE_SERVICES).map(([imageKey, serviceNames]) => [
      imageKey,
      Object.fromEntries(
        serviceNames.map((serviceName) => [
          serviceName,
          readComposeImageRef(compose, serviceName, filePath),
        ]),
      ),
    ]),
  );
}

function assertReleaseIdentity({ env, manifest, verification }) {
  const envTag = requireString(env.get("HUSTLEOPS_RELEASE_TAG"), "HUSTLEOPS_RELEASE_TAG");
  const manifestTag = requireString(manifest.release?.tag, "release-manifest.json release.tag");
  const verificationTag = requireString(verification.release?.tag, "release-verification.json release.tag");
  const manifestVersion = requireString(manifest.release?.version, "release-manifest.json release.version");
  const verificationVersion = requireString(verification.release?.version, "release-verification.json release.version");
  const tagVersion = versionFromTag(manifestTag);

  assertEqual(envTag, manifestTag, "HUSTLEOPS_RELEASE_TAG must match release-manifest.json release.tag");
  assertEqual(verificationTag, manifestTag, "release-verification.json release.tag must match release-manifest.json release.tag");
  assertEqual(manifestVersion, tagVersion, "release-manifest.json release.version must match release tag version");
  assertEqual(verificationVersion, manifestVersion, "release-verification.json release.version must match release-manifest.json release.version");

  return {
    tag: manifestTag,
    version: manifestVersion,
  };
}

function assertDeploymentTrigger({ env, manifest, deploymentTrigger }) {
  const envTrigger = requireString(env.get("HUSTLEOPS_RELEASE_TRIGGER"), "HUSTLEOPS_RELEASE_TRIGGER");
  const manifestTrigger = requireString(manifest.deploy?.trigger, "release-manifest.json deploy.trigger");

  assertEqual(deploymentTrigger, envTrigger, "deployment/release-trigger.txt must match HUSTLEOPS_RELEASE_TRIGGER");
  assertEqual(manifestTrigger, envTrigger, "release-manifest.json deploy.trigger must match HUSTLEOPS_RELEASE_TRIGGER");
}

function immutableRef(image, version, imageKey) {
  const ref = requireString(image?.ref, `release-manifest.json images.${imageKey}.ref`);
  const digest = requireString(image?.digest, `release-manifest.json images.${imageKey}.digest`);

  if (!/^sha256:[a-f0-9]{64}$/i.test(digest)) {
    throw new Error(`release-manifest.json images.${imageKey}.digest must be sha256.`);
  }

  return `${ref}:${version}@${digest}`;
}

function assertImageMetadata({ composeImages, manifest, verification, version }) {
  const trustPolicy = verification.trustPolicy ?? {};
  const issuer = requireString(trustPolicy.issuer, "release-verification.json trustPolicy.issuer");
  const certificateIdentity = requireString(
    trustPolicy.certificateIdentity,
    "release-verification.json trustPolicy.certificateIdentity",
  );
  const signaturePlan = [];

  for (const imageKey of IMAGE_KEYS) {
    const manifestImage = manifest.images?.[imageKey];
    const verificationImage = verification.images?.[imageKey];
    const composeServiceImages = composeImages[imageKey] ?? {};

    if (!manifestImage) {
      throw new Error(`release-manifest.json is missing images.${imageKey}.`);
    }

    if (!verificationImage) {
      throw new Error(`release-verification.json is missing images.${imageKey}.`);
    }

    const expectedImmutableRef = immutableRef(manifestImage, version, imageKey);
    const verificationDigest = requireString(
      verificationImage.digest,
      `release-verification.json images.${imageKey}.digest`,
    );
    const verificationImmutableRef = requireString(
      verificationImage.immutableRef,
      `release-verification.json images.${imageKey}.immutableRef`,
    );

    assertEqual(
      verificationDigest,
      manifestImage.digest,
      `release-verification.json images.${imageKey}.digest must match release-manifest.json images.${imageKey}.digest`,
    );
    assertEqual(
      verificationImmutableRef,
      expectedImmutableRef,
      `release-verification.json images.${imageKey}.immutableRef must match release-manifest.json image ref, version, and digest`,
    );
    for (const serviceName of COMPOSE_IMAGE_SERVICES[imageKey]) {
      const composeImage = requireString(
        composeServiceImages[serviceName],
        `docker-compose.prod.yml service ${serviceName} image`,
      );

      assertEqual(
        composeImage,
        verificationImmutableRef,
        `docker-compose.prod.yml service ${serviceName} image must match release-verification.json images.${imageKey}.immutableRef`,
      );
    }

    const signature = verificationImage.verification?.signature ?? {};
    assertEqual(
      signature.issuer,
      issuer,
      `release-verification.json images.${imageKey}.verification.signature.issuer must match trustPolicy.issuer`,
    );
    assertEqual(
      signature.certificateIdentity,
      certificateIdentity,
      `release-verification.json images.${imageKey}.verification.signature.certificateIdentity must match trustPolicy.certificateIdentity`,
    );

    signaturePlan.push([verificationImmutableRef, certificateIdentity, issuer].join("\t"));
  }

  return signaturePlan;
}

function assertReleaseRecord({ releaseRecord, manifest, tag, version }) {
  assertEqual(
    requireString(releaseRecord.release?.tag, `releases/${tag}.json release.tag`),
    tag,
    `releases/${tag}.json release.tag must match release-manifest.json release.tag`,
  );
  assertEqual(
    requireString(releaseRecord.release?.version, `releases/${tag}.json release.version`),
    version,
    `releases/${tag}.json release.version must match release-manifest.json release.version`,
  );
  assertEqual(
    requireString(releaseRecord.release?.commitSha, `releases/${tag}.json release.commitSha`),
    requireString(manifest.release?.commitSha, "release-manifest.json release.commitSha"),
    `releases/${tag}.json release.commitSha must match release-manifest.json release.commitSha`,
  );

  for (const imageKey of IMAGE_KEYS) {
    const manifestImage = manifest.images?.[imageKey];
    const releaseImage = releaseRecord.images?.[imageKey];

    if (!releaseImage) {
      throw new Error(`releases/${tag}.json is missing images.${imageKey}.`);
    }

    assertEqual(
      requireString(releaseImage.ref, `releases/${tag}.json images.${imageKey}.ref`),
      requireString(manifestImage?.ref, `release-manifest.json images.${imageKey}.ref`),
      `releases/${tag}.json images.${imageKey}.ref must match release-manifest.json images.${imageKey}.ref`,
    );
    assertEqual(
      requireString(releaseImage.digest, `releases/${tag}.json images.${imageKey}.digest`),
      requireString(manifestImage?.digest, `release-manifest.json images.${imageKey}.digest`),
      `releases/${tag}.json images.${imageKey}.digest must match release-manifest.json images.${imageKey}.digest`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = await readEnv(args["env-file"]);
  const composeImages = await readComposeImages(args["compose-file"]);
  const manifest = await readJson(args["manifest-file"], "release manifest");
  const verification = await readJson(args["verification-file"], "release verification");
  const deploymentTrigger = await readTrimmed(args["deployment-trigger-file"], "deployment trigger");
  const { tag, version } = assertReleaseIdentity({ env, manifest, verification });

  assertDeploymentTrigger({ env, manifest, deploymentTrigger });

  const signaturePlan = assertImageMetadata({
    composeImages,
    manifest,
    verification,
    version,
  });
  const releaseRecordFile = path.join(args["release-dir"], `${tag}.json`);
  const releaseRecord = await readJson(releaseRecordFile, `release record ${tag}`);

  assertReleaseRecord({ releaseRecord, manifest, tag, version });

  process.stdout.write("Release metadata validation passed\n");

  if (args["signature-plan-file"]) {
    await mkdir(path.dirname(args["signature-plan-file"]), { recursive: true });
    await writeFile(args["signature-plan-file"], `${signaturePlan.join("\n")}\n`);
    process.stdout.write(`Wrote ${args["signature-plan-file"]}\n`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
