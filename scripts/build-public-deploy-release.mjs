#!/usr/bin/env node

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = import.meta.dirname;
const projectRoot = path.resolve(scriptDir, "..");
const DEFAULT_RELEASE_PREFIX = "public-deploy-v";
const DEFAULT_INITIAL_VERSION = "0.1.0";
const VALID_BUMPS = new Set(["patch", "minor", "major"]);

function parseArgs(argv) {
  const args = {
    "repo-root": projectRoot,
    "manifest-file": path.join(projectRoot, "release-manifest.json"),
    "release-dir": path.join(projectRoot, "releases"),
    "output": path.join(projectRoot, ".hustleops", "public-deploy-release-notes.md"),
    "github-output": "",
    "release-prefix": DEFAULT_RELEASE_PREFIX,
    "initial-version": DEFAULT_INITIAL_VERSION,
    "bump": "patch",
    "force": "false",
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

  if (!VALID_BUMPS.has(args.bump)) {
    throw new Error(`--bump must be one of: ${[...VALID_BUMPS].join(", ")}.`);
  }

  parseVersion(args["initial-version"], "--initial-version");

  return {
    ...args,
    "repo-root": path.resolve(args["repo-root"]),
    "manifest-file": path.resolve(args["manifest-file"]),
    "release-dir": path.resolve(args["release-dir"]),
    "output": path.resolve(args.output),
    "github-output": args["github-output"] ? path.resolve(args["github-output"]) : "",
    "force": ["1", "true", "yes"].includes(`${args.force}`.toLowerCase()),
  };
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function parseVersion(value, label = "version") {
  const match = /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)$/.exec(value);

  if (!match?.groups) {
    throw new Error(`${label} must be a semantic version like 1.2.3.`);
  }

  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
  };
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }

  return 0;
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function bumpVersion(version, bump) {
  if (bump === "major") {
    return { major: version.major + 1, minor: 0, patch: 0 };
  }

  if (bump === "minor") {
    return { major: version.major, minor: version.minor + 1, patch: 0 };
  }

  return { major: version.major, minor: version.minor, patch: version.patch + 1 };
}

async function git(repoRoot, gitArgs) {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...gitArgs], {
    maxBuffer: 1024 * 1024 * 20,
  });

  return stdout.trim();
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

function relativePath(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function latestPublicDeployTag(tags, prefix) {
  const tagPattern = new RegExp(`^${escapeRegExp(prefix)}(?<version>\\d+\\.\\d+\\.\\d+)$`);
  const parsedTags = tags.flatMap((tag) => {
    const match = tagPattern.exec(tag);

    if (!match?.groups?.version) {
      return [];
    }

    return [{
      tag,
      version: parseVersion(match.groups.version),
      versionText: match.groups.version,
    }];
  });

  parsedTags.sort((left, right) => compareVersions(left.version, right.version));

  return parsedTags.at(-1) ?? null;
}

async function listMergedPublicDeployTags(repoRoot, prefix) {
  const output = await git(repoRoot, ["tag", "--merged", "HEAD", "--list", `${prefix}*`]);

  if (!output) {
    return [];
  }

  return output.split(/\n/).map((tag) => tag.trim()).filter(Boolean);
}

async function changedFiles(repoRoot, previousTag) {
  const output = previousTag
    ? await git(repoRoot, ["diff", "--name-only", `${previousTag}..HEAD`, "--"])
    : await git(repoRoot, ["ls-tree", "-r", "--name-only", "HEAD"]);

  if (!output) {
    return [];
  }

  return output.split(/\n/).map((file) => file.trim()).filter(Boolean).sort();
}

async function commitSummaries(repoRoot, previousTag) {
  const range = previousTag ? `${previousTag}..HEAD` : "HEAD";
  const output = await git(repoRoot, ["log", "--format=%h%x09%s", range, "--"]);

  if (!output) {
    return [];
  }

  return output.split(/\n/).map((line) => {
    const [shortSha, ...subjectParts] = line.split("\t");

    return {
      shortSha,
      subject: subjectParts.join("\t"),
    };
  });
}

function markdownList(items, formatter, emptyLine) {
  if (items.length === 0) {
    return [`- ${emptyLine}`];
  }

  return items.map(formatter);
}

function fileLooksLikeSourceContractChange(filePath) {
  return (
    filePath === ".env.example" ||
    filePath === "docker-compose.prod.yml" ||
    filePath === "release-manifest.json" ||
    filePath === "release-verification.json" ||
    filePath === "deployment/release-trigger.txt" ||
    /^releases\/v\d+\.\d+\.\d+\.json$/.test(filePath)
  );
}

function buildReleaseNotes({
  releaseTag,
  version,
  previousTag,
  sourceRelease,
  deployTrigger,
  releaseRecordFile,
  changedFilesList,
  commits,
  shouldPublish,
  force,
}) {
  const sourceContractChanged = changedFilesList.some(fileLooksLikeSourceContractChange);
  const releaseReason = [];

  if (changedFilesList.length > 0) {
    releaseReason.push(
      previousTag
        ? `Repository files changed since \`${previousTag}\`.`
        : "This is the first public deploy release for the repository history.",
    );
  }

  if (sourceContractChanged) {
    releaseReason.push("The checked-in source app deployment contract changed.");
  }

  if (force && changedFilesList.length === 0) {
    releaseReason.push("Manual release requested with no file changes since the previous public deploy tag.");
  }

  if (!shouldPublish) {
    releaseReason.push("No release will be published because no repository files changed.");
  }

  return [
    "## Public Deploy Release",
    "",
    "This release tracks the public deploy repository independently from the HustleOps application repository. Source app version metadata is included below for operator traceability.",
    "",
    `- Public deploy tag: \`${releaseTag}\``,
    `- Public deploy version: \`${version}\``,
    `- Previous public deploy tag: \`${previousTag ?? "none"}\``,
    `- Source app release: [${sourceRelease.tag}](${sourceRelease.url})`,
    `- Source app version: \`${sourceRelease.version}\``,
    `- Source app commit: \`${sourceRelease.commitSha}\``,
    `- Deployment trigger: \`${deployTrigger}\``,
    releaseRecordFile ? `- Source contract record: \`${releaseRecordFile}\`` : "- Source contract record: unavailable",
    "",
    "## Release Reason",
    "",
    ...markdownList(releaseReason, (reason) => `- ${reason}`, "No release reason recorded."),
    "",
    "## Commits",
    "",
    ...markdownList(
      commits.slice(0, 100),
      (commit) => `- ${commit.subject} (${commit.shortSha})`,
      "No commits since the previous public deploy tag.",
    ),
    ...(commits.length > 100 ? [`- ${commits.length - 100} additional commits omitted from notes.`] : []),
    "",
    "## Changed Files",
    "",
    ...markdownList(
      changedFilesList.slice(0, 200),
      (filePath) => `- \`${filePath}\``,
      "No changed files since the previous public deploy tag.",
    ),
    ...(changedFilesList.length > 200 ? [`- ${changedFilesList.length - 200} additional files omitted from notes.`] : []),
    "",
    "## Release Assets",
    "",
    "- `release-manifest.json`",
    "- `release-verification.json`",
    releaseRecordFile ? `- \`${releaseRecordFile}\`` : "- Source contract record was not found for the current source app tag.",
    "",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await readJson(args["manifest-file"], "release manifest");
  const sourceRelease = {
    tag: requireString(manifest.release?.tag, "release-manifest.json release.tag"),
    version: requireString(manifest.release?.version, "release-manifest.json release.version"),
    commitSha: requireString(manifest.release?.commitSha, "release-manifest.json release.commitSha"),
    url: requireString(manifest.release?.url, "release-manifest.json release.url"),
  };
  const deployTrigger = requireString(manifest.deploy?.trigger, "release-manifest.json deploy.trigger");
  const releaseRecordPath = path.join(args["release-dir"], `${sourceRelease.tag}.json`);
  const releaseRecordFile = existsSync(releaseRecordPath)
    ? relativePath(args["repo-root"], releaseRecordPath)
    : "";
  const tags = await listMergedPublicDeployTags(args["repo-root"], args["release-prefix"]);
  const latestTag = latestPublicDeployTag(tags, args["release-prefix"]);
  const files = await changedFiles(args["repo-root"], latestTag?.tag ?? "");
  const commits = await commitSummaries(args["repo-root"], latestTag?.tag ?? "");
  const shouldPublish = args.force || files.length > 0;
  const nextVersion = latestTag
    ? formatVersion(bumpVersion(latestTag.version, args.bump))
    : args["initial-version"];
  const releaseTag = `${args["release-prefix"]}${nextVersion}`;
  const releaseTitle = `HustleOps Public Deploy ${nextVersion}`;
  const releaseNotes = buildReleaseNotes({
    releaseTag,
    version: nextVersion,
    previousTag: latestTag?.tag ?? "",
    sourceRelease,
    deployTrigger,
    releaseRecordFile,
    changedFilesList: files,
    commits,
    shouldPublish,
    force: args.force,
  });
  const githubOutputs = [
    `should_publish=${shouldPublish ? "true" : "false"}`,
    `release_tag=${releaseTag}`,
    `release_title=${releaseTitle}`,
    `version=${nextVersion}`,
    `previous_tag=${latestTag?.tag ?? ""}`,
    `source_release_tag=${sourceRelease.tag}`,
    `source_release_version=${sourceRelease.version}`,
    `release_record_file=${releaseRecordFile}`,
    `release_notes_file=${relativePath(args["repo-root"], args.output)}`,
  ].join("\n");

  await mkdir(path.dirname(args.output), { recursive: true });
  await writeFile(args.output, releaseNotes);

  if (args["github-output"]) {
    await mkdir(path.dirname(args["github-output"]), { recursive: true });
    await writeFile(args["github-output"], `${githubOutputs}\n`);
  }

  process.stdout.write(`${JSON.stringify(
    {
      shouldPublish,
      releaseTag,
      releaseTitle,
      version: nextVersion,
      previousTag: latestTag?.tag ?? "",
      sourceReleaseTag: sourceRelease.tag,
      sourceReleaseVersion: sourceRelease.version,
      changedFileCount: files.length,
      commitCount: commits.length,
      releaseRecordFile,
      releaseNotesFile: args.output,
    },
    null,
    2,
  )}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
