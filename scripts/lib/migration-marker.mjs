#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};

  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument list near ${key ?? "(end)"}`);
    }

    options[key.slice(2)] = value;
  }

  return { command, options };
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required option --${name}`);
  }

  return value;
}

function printable(value) {
  const text = value === undefined ? "undefined" : value === null ? "null" : String(value);
  const redacted = text
    .replace(/:\/\/([^:@/\s]+):([^@/\s]+)@/g, "://$1:***@")
    .replace(/\b(token|secret|password|passwd|api[_-]?key)=([^&\s]+)/gi, "$1=***");

  return redacted.length > 180 ? `${redacted.slice(0, 177)}...` : redacted;
}

function readJson(filePath, label, fail) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    fail(`${label} not found at ${filePath}`);
  }

  try {
    return JSON.parse(content);
  } catch {
    fail(`${label} is not valid JSON at ${filePath}`);
  }
}

function requireManifestString(value, field, fail) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`release manifest is missing ${field}`);
  }

  return value;
}

function markerPathFor(manifestFile, manifest, fail) {
  const releaseTag = requireManifestString(manifest.release?.tag, "release.tag", fail);
  const markerPath = manifest.extensions?.migration?.successMarkerPath
    ?? `state/${releaseTag}.migration-success.json`;

  if (path.isAbsolute(markerPath)) {
    fail("migration marker path must stay under state/ and must be relative");
  }

  const manifestRoot = path.dirname(path.resolve(manifestFile));
  const markerFile = path.resolve(manifestRoot, markerPath);
  const stateRoot = path.resolve(manifestRoot, "state");
  const relative = path.relative(stateRoot, markerFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("migration marker path must stay under state/");
  }

  return { markerFile, markerPath };
}

function immutableMigrationImage(manifest, fail) {
  const image = manifest.images?.migration;
  const ref = requireManifestString(image?.ref, "images.migration.ref", fail);
  const digest = requireManifestString(image?.digest, "images.migration.digest", fail);
  const version = requireManifestString(manifest.release?.version, "release.version", fail);

  if (!/^sha256:[a-f0-9]{64}$/i.test(digest)) {
    fail("release manifest images.migration.digest is not sha256");
  }

  return `${ref}:${version}@${digest}`;
}

function getPath(root, field) {
  return field.split(".").reduce((value, segment) => value?.[segment], root);
}

function successOutputMarkers(migration) {
  return Array.isArray(migration.successOutputMarkers)
    ? migration.successOutputMarkers
    : [
        "All migrations have been successfully applied.",
        "No pending migrations to apply.",
      ];
}

function requiredMarkerFields(migration) {
  return Array.isArray(migration.successMarkerRequiredFields)
    ? migration.successMarkerRequiredFields
    : [
        "status",
        "completedAt",
        "release.tag",
        "release.version",
        "release.commitSha",
        "release.url",
        "deploy.trigger",
        "migrationImage",
        "databaseUrlEnvVar",
        "exitCode",
        "matchedOutput",
      ];
}

function assertCurrent(options) {
  const context = {
    manifestFile: requireOption(options, "manifest-file"),
    envFile: requireOption(options, "env-file"),
    composeFile: requireOption(options, "compose-file"),
    markerFile: "(unresolved)",
    expectedRelease: "(unresolved)",
  };

  const fail = (message) => {
    console.error(`This release has not recorded a successful database migration: ${message}.`);
    console.error(`Migration marker: ${context.markerFile}`);
    console.error(`Release manifest: ${context.manifestFile}`);
    console.error(`Compose file: ${context.composeFile}`);
    console.error(`Expected release: ${context.expectedRelease}`);
    console.error(
      `Run ./scripts/deploy.sh update --env-file ${context.envFile} --compose-file ${context.composeFile} --manifest-file ${context.manifestFile} before start/restart after pulling a newer release.`,
    );
    console.error(
      `For staged operations without starting services, run ./scripts/deploy.sh update --env-file ${context.envFile} --compose-file ${context.composeFile} --manifest-file ${context.manifestFile} --no-start, then retry start/restart with the same file options.`,
    );
    process.exit(1);
  };

  const manifest = readJson(context.manifestFile, "release manifest", fail);
  const migration = manifest.extensions?.migration ?? {};
  context.expectedRelease = requireManifestString(manifest.release?.tag, "release.tag", fail);
  context.markerFile = markerPathFor(context.manifestFile, manifest, fail).markerFile;

  const marker = readJson(context.markerFile, "migration success marker", fail);
  const successMarkers = successOutputMarkers(migration);

  for (const field of requiredMarkerFields(migration)) {
    const value = getPath(marker, field);
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
      fail(`migration marker required field ${field} is missing`);
    }
  }

  const assertEqual = (actual, expected, field) => {
    if (actual !== expected) {
      fail(`migration marker ${field} is stale (expected ${printable(expected)}, got ${printable(actual)})`);
    }
  };

  assertEqual(marker.schemaVersion, migration.successMarkerSchemaVersion ?? 1, "schemaVersion");
  assertEqual(marker.status, "succeeded", "status");
  assertEqual(marker.release?.tag, context.expectedRelease, "release.tag");
  assertEqual(
    marker.release?.version,
    requireManifestString(manifest.release?.version, "release.version", fail),
    "release.version",
  );
  assertEqual(
    marker.release?.commitSha,
    requireManifestString(manifest.release?.commitSha, "release.commitSha", fail),
    "release.commitSha",
  );
  assertEqual(
    marker.release?.url,
    requireManifestString(manifest.release?.url, "release.url", fail),
    "release.url",
  );
  assertEqual(
    marker.deploy?.trigger,
    requireManifestString(manifest.deploy?.trigger, "deploy.trigger", fail),
    "deploy.trigger",
  );
  assertEqual(marker.migrationImage, immutableMigrationImage(manifest, fail), "migrationImage");
  assertEqual(marker.databaseUrlEnvVar, migration.databaseUrlEnvVar ?? "DATABASE_URL", "databaseUrlEnvVar");
  assertEqual(marker.exitCode, migration.successExitCode ?? 0, "exitCode");

  if (!successMarkers.includes(marker.matchedOutput)) {
    fail(
      `migration marker matchedOutput is stale (expected one of ${printable(successMarkers.join(" | "))}, got ${printable(marker.matchedOutput)})`,
    );
  }
}

function writeSuccess(options) {
  const manifestFile = requireOption(options, "manifest-file");
  const outputFile = requireOption(options, "output-file");
  const timeoutSeconds = Number.parseInt(requireOption(options, "timeout-seconds"), 10);
  const exitCode = Number.parseInt(requireOption(options, "exit-code"), 10);
  const fail = (message) => {
    console.error(`Unable to write migration success marker: ${message}.`);
    process.exit(1);
  };

  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    fail("--timeout-seconds must be a positive integer");
  }
  if (!Number.isInteger(exitCode)) {
    fail("--exit-code must be an integer");
  }

  const manifest = readJson(manifestFile, "release manifest", fail);
  let output;
  try {
    output = fs.readFileSync(outputFile, "utf8");
  } catch {
    fail(`migration output not found at ${outputFile}`);
  }

  const migration = manifest.extensions?.migration ?? {};
  const successMarkers = successOutputMarkers(migration);
  const matchedOutput = successMarkers.find((marker) => output.includes(marker));
  const successExitCode = migration.successExitCode ?? 0;
  if (exitCode !== successExitCode) {
    fail(`migration command exit code ${exitCode} did not match expected ${successExitCode}`);
  }
  if (!matchedOutput) {
    fail("migration output did not include a Prisma success marker");
  }

  const { markerFile } = markerPathFor(manifestFile, manifest, fail);
  const marker = {
    schemaVersion: migration.successMarkerSchemaVersion ?? 1,
    status: "succeeded",
    completedAt: new Date().toISOString(),
    release: {
      tag: requireManifestString(manifest.release?.tag, "release.tag", fail),
      version: requireManifestString(manifest.release?.version, "release.version", fail),
      commitSha: requireManifestString(manifest.release?.commitSha, "release.commitSha", fail),
      url: requireManifestString(manifest.release?.url, "release.url", fail),
    },
    deploy: {
      trigger: requireManifestString(manifest.deploy?.trigger, "deploy.trigger", fail),
    },
    migrationImage: immutableMigrationImage(manifest, fail),
    databaseUrlEnvVar: migration.databaseUrlEnvVar ?? "DATABASE_URL",
    timeoutSeconds,
    exitCode,
    matchedOutput,
  };

  fs.mkdirSync(path.dirname(markerFile), { recursive: true });
  fs.writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`);
  console.log(`Migration success marker written to ${markerFile}`);
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "write-success") {
    writeSuccess(options);
    return;
  }
  if (command === "assert-current") {
    assertCurrent(options);
    return;
  }

  throw new Error(`Unknown migration marker command: ${command ?? "(missing)"}`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
