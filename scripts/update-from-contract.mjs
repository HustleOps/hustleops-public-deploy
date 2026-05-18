#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;
const OCI_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const TAG_PATTERN = /^v(?<version>\d+\.\d+\.\d+)$/;
const REQUIRED_IMAGE_KEYS = ["backend", "frontend", "migration"];
const REQUIRED_TRUST_ARTIFACTS = ["signature", "provenance", "sbom"];

const scriptDir = import.meta.dirname;
const projectRoot = path.resolve(scriptDir, "..");

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (!argument.startsWith("--")) {
      continue;
    }

    const key = argument.slice(2);
    const value = argv[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for argument --${key}.`);
    }

    args[key] = value;
    index += 1;
  }

  return args;
}

function requireArg(args, key) {
  const value = args[key];

  if (!value) {
    throw new Error(`Missing required argument --${key}.`);
  }

  return value;
}

function optionalArg(args, key, fallback) {
  return args[key] ?? fallback;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readOptionalJson(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function requireString(value, field) {
  const normalized = `${value ?? ""}`.trim();

  if (!normalized) {
    throw new Error(`Release contract is missing ${field}.`);
  }

  return normalized;
}

function requireDigest(value, field) {
  const digest = requireString(value, field);

  if (!OCI_DIGEST_PATTERN.test(digest)) {
    throw new Error(`${field} must be a sha256 digest.`);
  }

  return digest;
}

function globPatternToRegExp(pattern) {
  const escaped = `${pattern ?? ""}`
    .split("*")
    .map((segment) => segment.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
    .join(".*");

  return new RegExp(`^${escaped}$`);
}

function validateRelease(contract) {
  if (contract?.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported release contract schemaVersion ${contract?.schemaVersion}.`);
  }

  const tag = requireString(contract.release?.tag, "release.tag");
  const version = requireString(contract.release?.version, "release.version");
  const match = TAG_PATTERN.exec(tag);

  if (!match?.groups?.version || match.groups.version !== version) {
    throw new Error("Release contract tag and version must match v<major>.<minor>.<patch>.");
  }

  if (!/^[0-9a-f]{40}$/i.test(`${contract.release?.commitSha ?? ""}`)) {
    throw new Error("Release contract commitSha must be a 40-character git SHA.");
  }

  requireString(contract.release?.url, "release.url");
  requireString(contract.release?.releasedAt, "release.releasedAt");

  return { tag, version };
}

function validateImages(contract, version) {
  const actualKeys = Object.keys(contract.images ?? {}).sort();

  if (actualKeys.join(",") !== [...REQUIRED_IMAGE_KEYS].sort().join(",")) {
    throw new Error("Release contract must include exactly backend, frontend, and migration images.");
  }

  for (const imageKey of REQUIRED_IMAGE_KEYS) {
    const image = contract.images[imageKey];
    const ref = requireString(image?.ref, `images.${imageKey}.ref`);
    const digest = requireDigest(image?.digest, `images.${imageKey}.digest`);
    const immutableRef = requireString(
      image?.immutableRef,
      `images.${imageKey}.immutableRef`,
    );

    if (image.tag !== version) {
      throw new Error(`Release contract image ${imageKey} tag must match release.version.`);
    }

    if (image.platform !== "linux/amd64") {
      throw new Error(`Release contract image ${imageKey} must target linux/amd64.`);
    }

    if (immutableRef !== `${ref}:${version}@${digest}`) {
      throw new Error(`Release contract image ${imageKey} immutableRef must match ref, version, and digest.`);
    }
  }
}

function validateTrust(contract, { expectedIssuer, certificateIdentityPattern, tag }) {
  const issuer = requireString(contract.trust?.cosignIssuer, "trust.cosignIssuer");
  const certificateIdentity = requireString(
    contract.trust?.certificateIdentity,
    "trust.certificateIdentity",
  );
  const identityPattern = globPatternToRegExp(certificateIdentityPattern);

  if (issuer !== expectedIssuer) {
    throw new Error("Release contract trust cosignIssuer must match pinned issuer.");
  }

  if (!identityPattern.test(certificateIdentity)) {
    throw new Error("Release contract trust certificateIdentity must match pinned certificate identity pattern.");
  }

  if (!certificateIdentity.endsWith(`@refs/tags/${tag}`)) {
    throw new Error("Release contract trust certificateIdentity must be pinned to the release tag.");
  }

  if (!Array.isArray(contract.trust?.requiredArtifacts) ||
      !REQUIRED_TRUST_ARTIFACTS.every((artifact) => contract.trust.requiredArtifacts.includes(artifact))) {
    throw new Error("Release contract trust metadata must require signature, provenance, and sbom.");
  }
}

function validateRuntime(contract) {
  if (contract.runtime?.platform !== "linux/amd64") {
    throw new Error("Release contract runtime platform must be linux/amd64.");
  }

  for (const serviceName of ["backend", "frontend", "migration"]) {
    if (!contract.runtime?.services?.[serviceName]) {
      throw new Error(`Release contract runtime is missing ${serviceName} service facts.`);
    }
  }

  if (contract.migration?.required !== true) {
    throw new Error("Release contract must require migration handling.");
  }

  if (!(contract.migration?.timeoutSeconds > 0)) {
    throw new Error("Release contract migration timeoutSeconds must be positive.");
  }
}

function validateContract(contract, trustConfig) {
  const release = validateRelease(contract);
  validateImages(contract, release.version);
  validateTrust(contract, { ...trustConfig, tag: release.tag });
  validateRuntime(contract);
  return release;
}

function buildDeploymentTrigger(contract) {
  return `release-${contract.release.tag}-${contract.release.commitSha.slice(0, 12)}`;
}

function buildDigestRef(contractRef, contractDigest) {
  const packageRef = contractRef.split("@")[0].replace(/:[^/:]+$/, "");
  return `${packageRef}@${contractDigest}`;
}

function replaceEnvValue(content, key, value) {
  const linePattern = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;

  if (!linePattern.test(content)) {
    return `${content.replace(/\s*$/, "\n")}${line}\n`;
  }

  return content.replace(linePattern, line);
}

function removeEnvValue(content, key) {
  const linePattern = new RegExp(`^${key}=.*\\n?`, "m");
  return content.replace(linePattern, "");
}

async function updateEnvTemplate(filePath, contract, deploymentTrigger) {
  let content = await readFile(filePath, "utf8");

  content = removeEnvValue(content, "HUSTLEOPS_BACKEND_IMAGE");
  content = removeEnvValue(content, "HUSTLEOPS_FRONTEND_IMAGE");
  content = removeEnvValue(content, "HUSTLEOPS_BACKEND_MIGRATION_IMAGE");
  content = content.replace(/\n{3,}/g, "\n\n");
  content = replaceEnvValue(content, "HUSTLEOPS_RELEASE_TAG", contract.release.tag);
  content = replaceEnvValue(content, "HUSTLEOPS_RELEASE_TRIGGER", deploymentTrigger);

  await writeFile(filePath, content.endsWith("\n") ? content : `${content}\n`);
}

function replaceServiceImage(content, serviceName, imageRef) {
  const escapedName = serviceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const servicePattern = new RegExp(`(^  ${escapedName}:\\n[\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\n|^networks:)`, "m");
  const match = content.match(servicePattern);

  if (!match) {
    throw new Error(`docker-compose.prod.yml is missing service ${serviceName}.`);
  }

  if (!/^    image:/m.test(match[1])) {
    throw new Error(`docker-compose.prod.yml service ${serviceName} is missing image.`);
  }

  const nextService = match[1].replace(/^    image:\s*.*$/m, `    image: ${imageRef}`);
  return content.replace(match[1], nextService);
}

async function updateComposeImages(filePath, contract) {
  let content = await readFile(filePath, "utf8");

  content = replaceServiceImage(content, "backend", contract.images.backend.immutableRef);
  content = replaceServiceImage(content, "backend-migrate", contract.images.migration.immutableRef);
  content = replaceServiceImage(content, "backend-bootstrap", contract.images.migration.immutableRef);
  content = replaceServiceImage(content, "frontend", contract.images.frontend.immutableRef);

  await writeFile(filePath, content.endsWith("\n") ? content : `${content}\n`);
}

function imageNameFromRef(ref) {
  return ref.split("/").at(-1) ?? ref;
}

function imageTags(image, version) {
  return [
    ...new Set([
      image.tag,
      version,
      ...(Array.isArray(image.tags) ? image.tags : []),
    ].filter(Boolean)),
  ];
}

function buildRootImage(image, version) {
  return {
    name: image.name ?? imageNameFromRef(image.ref),
    ref: image.ref,
    tags: imageTags(image, version),
    digest: image.digest,
  };
}

function buildRootManifest({
  contract,
  deploymentTrigger,
  existingManifest,
}) {
  const tag = contract.release.tag;
  const version = contract.release.version;
  const existingExtensions = existingManifest.extensions ?? {};
  const existingDeployment = existingExtensions.deployment ?? {};
  const existingMigration = existingExtensions.migration ?? {};
  const { envVar: _legacyMigrationEnvVar, ...migrationExtension } = existingMigration;
  const existingVerification = existingExtensions.verification ?? {};
  const successOutputMarkers = Array.isArray(contract.migration?.successOutputMarkers)
    ? contract.migration.successOutputMarkers
    : existingMigration.successOutputMarkers ?? [
        "All migrations have been successfully applied.",
        "No pending migrations to apply.",
      ];

  return {
    schemaVersion: SCHEMA_VERSION,
    release: contract.release,
    images: Object.fromEntries(
      REQUIRED_IMAGE_KEYS.map((imageKey) => [
        imageKey,
        buildRootImage(contract.images[imageKey], version),
      ]),
    ),
    deploy: {
      ...(existingManifest.deploy ?? {}),
      trigger: deploymentTrigger,
      imageRefMode: "immutable",
    },
    extensions: {
      ...existingExtensions,
      deployment: {
        ...existingDeployment,
        envFilePath: existingDeployment.envFilePath ?? ".env.example",
        composePath: existingDeployment.composePath ?? "docker-compose.prod.yml",
        imageRefSource: "docker-compose.prod.yml service image fields",
        nginxConfigPath: existingDeployment.nginxConfigPath ?? "nginx/nginx.conf",
        nginxAncillaryConfigPath: existingDeployment.nginxAncillaryConfigPath ?? "nginx/nginx.ancillary.conf",
        nginxSecurityHeadersPath: existingDeployment.nginxSecurityHeadersPath ?? "nginx/security-headers.conf",
        manifestPath: existingDeployment.manifestPath ?? "release-manifest.json",
        verificationPath: existingDeployment.verificationPath ?? "release-verification.json",
        deploymentTriggerPath: existingDeployment.deploymentTriggerPath ?? "deployment/release-trigger.txt",
        immutableReleasePath: `releases/${tag}.json`,
      },
      migration: {
        ...migrationExtension,
        service: migrationExtension.service ?? "backend-migrate",
        profile: migrationExtension.profile ?? "migration",
        imageSource: "docker-compose.prod.yml services.backend-migrate.image",
        databaseUrlEnvVar: migrationExtension.databaseUrlEnvVar ?? "DATABASE_URL",
        timeoutSeconds: contract.migration.timeoutSeconds,
        timeoutSemantics: migrationExtension.timeoutSemantics ?? "fail if docker compose run --rm exceeds timeoutSeconds or exits non-zero",
        successExitCode: migrationExtension.successExitCode ?? 0,
        successOutputMarkers,
        successMarkerPath: `state/${tag}.migration-success.json`,
        successMarkerFormat: migrationExtension.successMarkerFormat ?? "json",
        successMarkerSchemaVersion: migrationExtension.successMarkerSchemaVersion ?? SCHEMA_VERSION,
        ownership: migrationExtension.ownership ?? "single-runner",
        rerunPolicy: migrationExtension.rerunPolicy ?? "idempotent",
        repeatReleaseBehavior: migrationExtension.repeatReleaseBehavior ?? "safe-to-rerun-same-release",
        releaseLinkage: {
          ...(migrationExtension.releaseLinkage ?? {}),
          releaseTag: tag,
          releaseVersion: version,
          releaseUrl: contract.release.url,
          deployTrigger: deploymentTrigger,
          immutableReleasePath: `releases/${tag}.json`,
          verificationPath: "release-verification.json",
          manifestPath: "release-manifest.json",
        },
      },
      verification: {
        ...existingVerification,
        provider: existingVerification.provider ?? "github-actions",
        issuer: contract.trust.cosignIssuer,
        certificateIdentity: contract.trust.certificateIdentity,
        requiredArtifacts: contract.trust.requiredArtifacts,
        sbomFormat: existingVerification.sbomFormat ?? contract.trust.sbomFormat ?? "spdx-json",
        provenanceMode: existingVerification.provenanceMode ?? contract.trust.provenanceMode ?? "max",
      },
    },
  };
}

function buildVerificationRecord({
  contract,
  existingVerification,
}) {
  const existingTrustPolicy = existingVerification.trustPolicy ?? {};
  const provider = existingTrustPolicy.provider ?? "github-actions";
  const trustPolicy = {
    provider,
    issuer: contract.trust.cosignIssuer,
    certificateIdentity: contract.trust.certificateIdentity,
    requiredArtifacts: contract.trust.requiredArtifacts,
    sbomFormat: existingTrustPolicy.sbomFormat ?? contract.trust.sbomFormat ?? "spdx-json",
    provenanceMode: existingTrustPolicy.provenanceMode ?? contract.trust.provenanceMode ?? "max",
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    release: contract.release,
    trustPolicy,
    images: Object.fromEntries(
      REQUIRED_IMAGE_KEYS.map((imageKey) => {
        const image = contract.images[imageKey];
        const existingImage = existingVerification.images?.[imageKey] ?? {};
        const existingImageVerification = existingImage.verification ?? {};

        return [
          imageKey,
          {
            name: image.name ?? imageNameFromRef(image.ref),
            digest: image.digest,
            immutableRef: image.immutableRef,
            verification: {
              signature: {
                provider,
                issuer: trustPolicy.issuer,
                certificateIdentity: trustPolicy.certificateIdentity,
              },
              provenance: {
                provider: existingImageVerification.provenance?.provider ?? provider,
                mode: existingImageVerification.provenance?.mode ?? trustPolicy.provenanceMode,
              },
              sbom: {
                provider: existingImageVerification.sbom?.provider ?? provider,
                format: existingImageVerification.sbom?.format ?? trustPolicy.sbomFormat,
              },
            },
          },
        ];
      }),
    ),
  };
}

function buildReleaseRecord({
  contract,
  contractRef,
  contractDigest,
  deploymentTrigger,
  verifiedAt,
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    release: contract.release,
    contract: {
      ref: contractRef,
      digest: contractDigest,
      digestRef: buildDigestRef(contractRef, contractDigest),
      verifiedAt,
    },
    images: contract.images,
    runtime: contract.runtime,
    trust: contract.trust,
    migration: contract.migration,
    deployment: {
      trigger: deploymentTrigger,
    },
  };
}

function buildSignaturePlan(contract) {
  return REQUIRED_IMAGE_KEYS.map((imageKey) => [
    contract.images[imageKey].immutableRef,
    contract.trust.certificateIdentity,
    contract.trust.cosignIssuer,
  ].join("\t")).join("\n");
}

function buildPrBody({
  contract,
  contractRef,
  contractDigest,
  deploymentTrigger,
}) {
  return [
    `## HustleOps public deploy update for ${contract.release.tag}`,
    "",
    `- Release version: ${contract.release.version}`,
    `- Contract ref: \`${contractRef}\``,
    `- Contract digest: \`${contractDigest}\``,
    `- Backend image: \`${contract.images.backend.immutableRef}\``,
    `- Frontend image: \`${contract.images.frontend.immutableRef}\``,
    `- Migration image: \`${contract.images.migration.immutableRef}\``,
    `- Deployment trigger: \`${deploymentTrigger}\``,
    "",
    "### Verification checklist",
    "",
    "- [x] Contract signature verified before JSON parsing.",
    "- [x] Contract payload trust fields cross-checked against the pinned trust root.",
    "- [x] Runtime image refs are versioned and digest-pinned.",
    "- [x] Runtime image signatures verified with the contract trust identity.",
    "- [ ] Compose, nginx, deploy script, preflight, backup, and migration checks pass in CI.",
    "- [ ] Rollback compatibility reviewed before production rollout.",
    "",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const contractFile = requireArg(args, "contract-file");
  const contractRef = requireArg(args, "contract-ref");
  const contractDigest = requireDigest(requireArg(args, "contract-digest"), "contract-digest");
  const expectedIssuer = requireArg(args, "expected-issuer");
  const certificateIdentityPattern = requireArg(args, "certificate-identity-pattern");
  const envTemplateFile = optionalArg(
    args,
    "env-template-file",
    path.join(projectRoot, ".env.example"),
  );
  const composeFile = optionalArg(
    args,
    "compose-file",
    path.join(projectRoot, "docker-compose.prod.yml"),
  );
  const releaseDir = optionalArg(args, "release-dir", path.join(projectRoot, "releases"));
  const manifestFile = optionalArg(
    args,
    "manifest-file",
    path.join(projectRoot, "release-manifest.json"),
  );
  const verificationFile = optionalArg(
    args,
    "verification-file",
    path.join(projectRoot, "release-verification.json"),
  );
  const deploymentTriggerFile = optionalArg(
    args,
    "deployment-trigger-file",
    path.join(projectRoot, "deployment", "release-trigger.txt"),
  );
  const signaturePlanFile = optionalArg(
    args,
    "signature-plan-file",
    path.join(projectRoot, ".hustleops", "image-signatures.tsv"),
  );
  const prBodyFile = optionalArg(
    args,
    "pr-body-file",
    path.join(projectRoot, ".hustleops", "update-pr-body.md"),
  );
  const verifiedAt = optionalArg(args, "verified-at", new Date().toISOString());
  const contract = await readJson(contractFile);
  const { tag } = validateContract(contract, {
    expectedIssuer,
    certificateIdentityPattern,
  });
  const existingManifest = await readOptionalJson(manifestFile);
  const existingVerification = await readOptionalJson(verificationFile);
  const deploymentTrigger = buildDeploymentTrigger(contract);
  const rootManifest = buildRootManifest({
    contract,
    deploymentTrigger,
    existingManifest,
  });
  const rootVerification = buildVerificationRecord({
    contract,
    existingVerification,
  });
  const releaseRecord = buildReleaseRecord({
    contract,
    contractRef,
    contractDigest,
    deploymentTrigger,
    verifiedAt,
  });
  const releaseRecordFile = path.join(releaseDir, `${tag}.json`);

  await updateEnvTemplate(envTemplateFile, contract, deploymentTrigger);
  await updateComposeImages(composeFile, contract);
  await mkdir(path.dirname(manifestFile), { recursive: true });
  await writeFile(manifestFile, `${JSON.stringify(rootManifest, null, 2)}\n`);
  await mkdir(path.dirname(verificationFile), { recursive: true });
  await writeFile(verificationFile, `${JSON.stringify(rootVerification, null, 2)}\n`);
  await mkdir(path.dirname(deploymentTriggerFile), { recursive: true });
  await writeFile(deploymentTriggerFile, `${deploymentTrigger}\n`);
  await mkdir(releaseDir, { recursive: true });
  await writeFile(releaseRecordFile, `${JSON.stringify(releaseRecord, null, 2)}\n`);
  await mkdir(path.dirname(signaturePlanFile), { recursive: true });
  await writeFile(signaturePlanFile, `${buildSignaturePlan(contract)}\n`);
  await mkdir(path.dirname(prBodyFile), { recursive: true });
  await writeFile(
    prBodyFile,
    `${buildPrBody({
      contract,
      contractRef,
      contractDigest,
      deploymentTrigger,
    })}\n`,
  );

  process.stdout.write(`${JSON.stringify(
    {
      releaseTag: tag,
      composeFile,
      manifestFile,
      verificationFile,
      releaseRecordFile,
      deploymentTrigger,
      signaturePlanFile,
      prBodyFile,
    },
    null,
    2,
  )}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
