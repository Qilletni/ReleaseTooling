#!/usr/bin/env node
/**
 * Command-line entry point used by the reusable GitHub Actions workflows.
 *
 * Every subcommand is intentionally small and single-purpose so it can be
 * wired into a workflow step with plain shell variable capture. Run
 * `node --import tsx src/cli.ts <subcommand> --help` for details. See
 * `tools/release/README.md` for the full caller contract.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Command, Option } from "commander";
import yaml from "js-yaml";

import * as artifactVerify from "./artifact_verify.js";
import * as changelog from "./changelog.js";
import * as componentsRegistry from "./components_registry.js";
import * as dependencyPayload from "./dependency_payload.js";
import * as dependencyUpdate from "./dependency_update.js";
import * as japicmpPolicy from "./japicmp_policy.js";
import * as platformCandidates from "./platform_candidates.js";
import * as platformManifest from "./platform_manifest.js";
import * as releaseConfig from "./release_config.js";
import * as releaseEvent from "./release_event.js";
import * as releaseMarker from "./release_marker.js";
import * as resolveJapicmpBaseline from "./resolve_japicmp_baseline.js";
import * as resolvedGraph from "./resolved_graph.js";
import * as semver from "./semver.js";
import * as versionFiles from "./version_files.js";
import type { Json } from "./release_config.js";

// Test-only stdin override, so tests can feed stdin-reading subcommands
// without piping a real OS-level stream.
let stdinOverride: string | null = null;
export function __setStdinForTests(text: string | null): void {
  stdinOverride = text;
}

async function readStdin(): Promise<string> {
  if (stdinOverride !== null) return stdinOverride;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** Thrown by `report()` on validation failure; caught once, centrally, in `main()`. */
export class ReportedErrors extends Error {
  constructor(public errors: string[]) {
    super(errors.join("; "));
  }
}

function report(errors: string[]): void {
  if (errors.length > 0) {
    throw new ReportedErrors(errors);
  }
  console.log("OK");
}

/** Identity passthrough - kept as a seam so every command's handler has a consistent shape. */
function action<Args extends unknown[]>(fn: (...args: Args) => void | Promise<void>) {
  return fn;
}

function repeatable(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/** Builds a fresh Command tree - called once per `main()` invocation so no parser state leaks across calls (tests call `main()` repeatedly). */
export function buildProgram(): Command {
  const program = new Command();
  program.name("release-cli").description("Qilletni release automation CLI").exitOverride();

  // ---------------------------------------------------------------------------
  // Primary release and validation subcommands
  // ---------------------------------------------------------------------------

program
  .command("validate-release-config")
  .requiredOption("--config <path>")
  .action(
    action((opts: { config: string }) => {
      const config = releaseConfig.loadReleaseConfig(opts.config);
      report(releaseConfig.validateReleaseConfig(config));
    })
  );

program
  .command("validate-components-registry")
  .requiredOption("--registry <path>")
  .option("--allowed-repository <repo>", "may be repeated", repeatable, [] as string[])
  .action(
    action((opts: { registry: string; allowedRepository: string[] }) => {
      const registry = componentsRegistry.loadRegistry(opts.registry);
      const allowed = opts.allowedRepository.length > 0 ? opts.allowedRepository : undefined;
      report(componentsRegistry.validateRegistry(registry, { allowedRepositories: allowed }));
    })
  );

program
  .command("validate-platform-manifest")
  .requiredOption("--manifest <path>")
  .action(
    action((opts: { manifest: string }) => {
      const manifest = platformManifest.loadPlatformManifest(opts.manifest);
      const errors = platformManifest.validatePlatformManifest(manifest);
      errors.push(...platformManifest.validateManifestFilename(opts.manifest, manifest.platform_version));
      report(errors);
    })
  );

program
  .command("verify-platform-manifest-commits")
  .description("Re-verify each component's tag still dereferences to its declared commit (live GitHub API)")
  .requiredOption("--manifest <path>")
  .option("--token <token>", "GitHub token, to raise the API rate limit")
  .action(
    action(async (opts: { manifest: string; token?: string }) => {
      const manifest = platformManifest.loadPlatformManifest(opts.manifest);
      const token = opts.token;
      const errors = await platformManifest.verifyComponentCommits(manifest, {
        fetchTagRef: (repo, tag) => artifactVerify.fetchTagRef(repo, tag, { token }),
        fetchTagObject: (repo, sha) => artifactVerify.fetchGitTagObject(repo, sha, { token }),
      });
      report(errors);
    })
  );

program
  .command("validate-platform-candidates")
  .requiredOption("--candidates <path>")
  .action(
    action((opts: { candidates: string }) => {
      const candidates = platformCandidates.loadCandidates(opts.candidates);
      report(platformCandidates.validateCandidates(candidates));
    })
  );

program
  .command("build-release-event")
  .description("Build+validate the release event a component's own publish workflow dispatches")
  .addOption(new Option("--component <name>").choices(["toolchain", "qpm"]).makeOptionMandatory())
  .requiredOption("--repository <owner/repo>")
  .requiredOption("--version <version>")
  .requiredOption("--commit <sha>")
  .requiredOption("--asset <name>")
  .requiredOption("--sha256 <hex>")
  .option("--embed <name=version>", "may be repeated", repeatable, [] as string[])
  .action(
    action((opts: { component: string; repository: string; version: string; commit: string; asset: string; sha256: string; embed: string[] }) => {
      const embeds: Record<string, string> = {};
      for (const entry of opts.embed) {
        const [name, value] = entry.split("=", 2);
        embeds[name] = value;
      }

      const event = releaseEvent.buildEvent({
        component: opts.component,
        repository: opts.repository,
        version: opts.version,
        commit: opts.commit,
        asset: opts.asset,
        sha256: opts.sha256,
        embeds,
      });
      const errors = releaseEvent.validateEvent(event);
      if (errors.length > 0) {
        report(errors);
        return;
      }
      console.log(releaseEvent.toJson(event));
    })
  );

program
  .command("update-platform-candidates")
  .requiredOption("--candidates <path>")
  .requiredOption("--event <path>", "Path to a JSON release event file")
  .option("--output <path>", "Defaults to overwriting --candidates in place")
  .action(
    action((opts: { candidates: string; event: string; output?: string }) => {
      const candidates = platformCandidates.loadCandidates(opts.candidates);
      const event = releaseEvent.fromJson(readFileSync(opts.event, "utf-8"));

      const updated = platformCandidates.updateCandidateComponent(candidates, event);

      const output = opts.output ?? opts.candidates;
      writeFile(output, platformCandidates.toYaml(updated));
    })
  );

program
  .command("latest-platform-version")
  .description(
    "Read newline-separated release/platform/ filenames from stdin, print the highest 'X.Y.Z.yml' manifest version (or empty if none exist yet)"
  )
  .action(
    action(async () => {
      const filenames = (await readStdin()).split(/\r\n|\r|\n/);
      console.log(platformManifest.latestPlatformVersion(filenames) ?? "");
    })
  );

program
  .command("promote-candidates-to-platform-manifest")
  .description("Copy a reviewed release/platform/candidates.yml into a new, immutable release/platform/X.Y.Z.yml")
  .requiredOption("--candidates <path>")
  .requiredOption("--platform-version <version>")
  .requiredOption("--output <path>", "Refuses to overwrite an existing file")
  .action(
    action((opts: { candidates: string; platformVersion: string; output: string }) => {
      if (existsSync(opts.output)) {
        report([`'${opts.output}' already exists; refusing to overwrite an existing platform manifest`]);
        return;
      }

      const candidates = platformCandidates.loadCandidates(opts.candidates);
      const manifest = platformCandidates.promoteToManifest(candidates, opts.platformVersion);
      const errors = platformManifest.validatePlatformManifest(manifest);
      if (errors.length > 0) {
        report(errors);
        return;
      }

      writeFile(opts.output, platformCandidates.toYaml(manifest));
    })
  );

program
  .command("verify-live-asset-provenance")
  .description(
    "Re-verify each component's asset name + sha256 against its live GitHub release (works against either a platform manifest or candidates.yml)"
  )
  .requiredOption("--manifest <path>")
  .option("--token <token>", "GitHub token, to raise the API rate limit")
  .action(
    action(async (opts: { manifest: string; token?: string }) => {
      // Works against either a full manifest or candidates.yml - both share
      // the same per-component 'components' shape that this function reads.
      const manifest = platformCandidates.loadCandidates(opts.manifest);
      const token = opts.token;
      const errors = await platformManifest.verifyLiveAssetProvenance(manifest, {
        fetchRelease: (repo, tag) => artifactVerify.fetchGithubRelease(repo, tag, { token }),
      });
      report(errors);
    })
  );

program
  .command("verify-release-event-provenance")
  .description("Re-verify a release event's tag/commit/asset/sha256 against the live GitHub API")
  .requiredOption("--event <path>", "Path to a JSON release event file")
  .option("--token <token>", "GitHub token, to raise the API rate limit")
  .action(
    action(async (opts: { event: string; token?: string }) => {
      const event = releaseEvent.fromJson(readFileSync(opts.event, "utf-8"));
      const token = opts.token;
      const errors = await releaseEvent.verifyLiveProvenance(event, {
        fetchTagRef: (repo, tag) => artifactVerify.fetchTagRef(repo, tag, { token }),
        fetchTagObject: (repo, sha) => artifactVerify.fetchGitTagObject(repo, sha, { token }),
        fetchRelease: (repo, tag) => artifactVerify.fetchGithubRelease(repo, tag, { token }),
      });
      report(errors);
    })
  );

program
  .command("next-version")
  .description("Compute the next SemVer version")
  .requiredOption("--current-version <version>")
  .option("--bump <kind>", "major|minor|patch", "patch")
  .option("--snapshot", "Compute the next -SNAPSHOT dev version instead", false)
  .action(
    action((opts: { currentVersion: string; bump: string; snapshot: boolean }) => {
      const current = semver.parse(opts.currentVersion);
      if (opts.snapshot) {
        console.log(semver.nextSnapshot(current));
      } else {
        console.log(semver.toStringVersion(semver.bump(current, opts.bump)));
      }
    })
  );

program
  .command("classify-bump")
  .description("Classify a version jump as patch/minor/major")
  .requiredOption("--old-version <version>")
  .requiredOption("--new-version <version>")
  .action(
    action((opts: { oldVersion: string; newVersion: string }) => {
      console.log(semver.classifyBump(semver.parse(opts.oldVersion), semver.parse(opts.newVersion)));
    })
  );

program
  .command("latest-stable-tag")
  .description("Read newline-separated git tags from stdin, print the highest stable 'vX.Y.Z' version (or empty)")
  .action(
    action(async () => {
      const tags = (await readStdin()).split(/\r\n|\r|\n/);
      console.log(semver.latestStableTag(tags) ?? "");
    })
  );

program
  .command("next-release-version")
  .description(
    "Compute the next release version, preferring the latest published stable tag over a pre-bumped SNAPSHOT version-file value"
  )
  .requiredOption("--current-file-version <version>")
  .requiredOption("--bump <kind>", "major|minor|patch")
  .option("--latest-stable-version <version>", "Omit before the first release has ever been published")
  .action(
    action((opts: { currentFileVersion: string; bump: string; latestStableVersion?: string }) => {
      console.log(
        semver.nextReleaseVersion({
          currentFileVersion: opts.currentFileVersion,
          bumpKind: opts.bump,
          latestStableVersion: opts.latestStableVersion ?? null,
        })
      );
    })
  );

program
  .command("promote-changelog")
  .description("Promote the Unreleased changelog section")
  .requiredOption("--changelog <path>")
  .requiredOption("--version <version>")
  .option("--date <date>", "Defaults to today (UTC) in YYYY-MM-DD form")
  .option("--check", "Validate only, do not write the file", false)
  .action(
    action((opts: { changelog: string; version: string; date?: string; check: boolean }) => {
      const text = readFileSync(opts.changelog, "utf-8");
      const date = opts.date ?? new Date().toISOString().slice(0, 10);
      const updated = changelog.promoteUnreleased(text, opts.version, date);

      if (opts.check) {
        console.log("OK");
        return;
      }

      writeFile(opts.changelog, updated);
    })
  );

program
  .command("check-changelog-unreleased")
  .description("Fail if the Unreleased section is empty")
  .requiredOption("--changelog <path>")
  .action(
    action((opts: { changelog: string }) => {
      const text = readFileSync(opts.changelog, "utf-8");
      if (!changelog.hasUnreleasedContent(text)) {
        report(["Changelog 'Unreleased' section is empty; nothing to release"]);
        return;
      }
      report([]);
    })
  );

program
  .command("set-property")
  .description("Set a key=value in a .properties file")
  .requiredOption("--file <path>")
  .requiredOption("--key <key>")
  .requiredOption("--value <value>")
  .action(
    action((opts: { file: string; key: string; value: string }) => {
      versionFiles.updatePropertyFile(opts.file, opts.key, opts.value);
    })
  );

program
  .command("get-property")
  .description("Read a key=value from a .properties file")
  .requiredOption("--file <path>")
  .requiredOption("--key <key>")
  .action(
    action((opts: { file: string; key: string }) => {
      console.log(versionFiles.getProperty(readFileSync(opts.file, "utf-8"), opts.key));
    })
  );

program
  .command("check-japicmp-report")
  .description("Apply the patch/minor/major API compatibility policy")
  .requiredOption("--report <path>", "Path to the japicmp XML report")
  .requiredOption("--policy <tier>", "patch|minor|major")
  .option("--has-migration-doc", "A docs/migrations/X.Y.Z.md guide exists", false)
  .action(
    action((opts: { report: string; policy: string; hasMigrationDoc: boolean }) => {
      const xmlText = readFileSync(opts.report, "utf-8");
      const [ok, violations] = japicmpPolicy.evaluate(xmlText, { policy: opts.policy, hasMigrationDoc: opts.hasMigrationDoc });
      report(ok ? [] : violations);
    })
  );

program
  .command("build-dependency-payload")
  .description("Build+validate a dependency-dispatch payload")
  .requiredOption("--component <name>")
  .requiredOption("--version <version>")
  .requiredOption("--commit <sha>")
  .requiredOption("--repository <owner/repo>")
  .option("--artifact <coordinates=sha256>", "may be repeated", repeatable, [] as string[])
  .action(
    action((opts: { component: string; version: string; commit: string; repository: string; artifact: string[] }) => {
      if (opts.artifact.length === 0) {
        throw new Error("--artifact is required (may be repeated)");
      }

      const artifacts: [string, string][] = opts.artifact.map((entry) => {
        const idx = entry.lastIndexOf("=");
        return [entry.slice(0, idx), entry.slice(idx + 1)];
      });

      const payload = dependencyPayload.buildPayload({
        component: opts.component,
        version: opts.version,
        commit: opts.commit,
        repository: opts.repository,
        artifacts,
      });
      const errors = dependencyPayload.validatePayload(payload);
      if (errors.length > 0) {
        report(errors);
        return;
      }

      console.log(dependencyPayload.toJson(payload));
    })
  );

program
  .command("validate-dependency-payload")
  .description("Validate a dependency-dispatch payload against this repository's .qilletni/release.yml 'dependencies'")
  .requiredOption("--payload <path>", "Path to a JSON dependency-dispatch payload file")
  .requiredOption("--config <path>", "Path to this repository's release.yml")
  .action(
    action((opts: { payload: string; config: string }) => {
      const payload = dependencyPayload.fromJson(readFileSync(opts.payload, "utf-8"));
      const config = releaseConfig.loadReleaseConfig(opts.config);
      report(dependencyUpdate.validatePayloadAgainstConfig(payload, config));
    })
  );

program
  .command("verify-dependency-artifacts")
  .description("Download (streamed) and hash-verify each payload artifact against Maven Central")
  .requiredOption("--payload <path>", "Path to a JSON dependency-dispatch payload file")
  .action(
    action(async (opts: { payload: string }) => {
      const payload = dependencyPayload.fromJson(readFileSync(opts.payload, "utf-8"));
      report(await dependencyUpdate.verifyPayloadArtifactsAvailable(payload));
    })
  );

program
  .command("apply-dependency-update")
  .description("Validate a dependency-dispatch payload, then idempotently update only its configured version file/key")
  .requiredOption("--payload <path>", "Path to a JSON dependency-dispatch payload file")
  .requiredOption("--config <path>", "Path to this repository's release.yml")
  .option("--base-dir <dir>", "Directory version_file paths are resolved relative to", ".")
  .action(
    action((opts: { payload: string; config: string; baseDir: string }) => {
      const payload = dependencyPayload.fromJson(readFileSync(opts.payload, "utf-8"));
      const config = releaseConfig.loadReleaseConfig(opts.config);

      const errors = dependencyUpdate.validatePayloadAgainstConfig(payload, config);
      if (errors.length > 0) {
        report(errors);
        return;
      }

      const dependency = dependencyUpdate.findDependency(config, payload.component);
      const updates = dependencyUpdate.planMetadataUpdates(dependency, payload);
      const changed = dependencyUpdate.applyMetadataUpdates(updates, { baseDir: opts.baseDir });

      for (const path of changed) console.log(path);
    })
  );

program
  .command("check-resolved-dependency-versions")
  .description("Read a Gradle 'dependencies' task text report from stdin, confirm every payload artifact resolved to exactly its declared version")
  .requiredOption("--payload <path>", "Path to a JSON dependency-dispatch payload file")
  .option(
    "--config <path>",
    "Path to this repository's release.yml; when given, coordinates the matching dependency marks 'resolved: false' are excluded from the presence check"
  )
  .action(
    action(async (opts: { payload: string; config?: string }) => {
      const payload = dependencyPayload.fromJson(readFileSync(opts.payload, "utf-8"));

      let excludeCoordinates = new Set<string>();
      if (opts.config) {
        const config = releaseConfig.loadReleaseConfig(opts.config);
        const dependency = dependencyUpdate.findDependency(config, payload.component);
        if (dependency !== null) {
          excludeCoordinates = dependencyUpdate.unresolvedCoordinates(dependency);
        }
      }

      const reportText = await readStdin();
      const expected = resolvedGraph.expectedVersionsFromPayload(payload, { excludeCoordinates });
      report(resolvedGraph.checkExpectedVersions(reportText, expected));
    })
  );

program
  .command("write-release-marker")
  .description("Write release/pending-release.json for the release-preparation PR")
  .requiredOption("--marker <path>")
  .requiredOption("--component <name>")
  .requiredOption("--from-version <version>")
  .requiredOption("--to-version <version>")
  .requiredOption("--bump <kind>", "major|minor|patch")
  .action(
    action((opts: { marker: string; component: string; fromVersion: string; toVersion: string; bump: string }) => {
      const marker = releaseMarker.buildMarker({
        component: opts.component,
        fromVersion: opts.fromVersion,
        toVersion: opts.toVersion,
        bump: opts.bump,
      });
      writeFile(opts.marker, releaseMarker.toJson(marker));
    })
  );

program
  .command("check-release-marker")
  .description("Validate release/pending-release.json against the version being released")
  .requiredOption("--marker <path>")
  .requiredOption("--expected-component <name>")
  .requiredOption("--expected-version <version>")
  .action(
    action((opts: { marker: string; expectedComponent: string; expectedVersion: string }) => {
      const marker = releaseMarker.fromJson(readFileSync(opts.marker, "utf-8"));
      report(releaseMarker.validateMarker(marker, { expectedComponent: opts.expectedComponent, expectedVersion: opts.expectedVersion }));
    })
  );

program
  .command("check-merge-provenance")
  .description("Read a commit's associated pull requests (GitHub API JSON) from stdin and confirm one of them is a merged release-preparation PR")
  .requiredOption("--component <name>")
  .requiredOption("--version <version>")
  .action(
    action(async (opts: { component: string; version: string }) => {
      const pullRequests = JSON.parse(await readStdin());
      report(releaseMarker.validateMergeProvenance(pullRequests, { component: opts.component, version: opts.version }));
    })
  );

// ---------------------------------------------------------------------------
// Workflow-support subcommands: structured field reads, Maven Central polling,
// and manifest/baseline resolution, so no workflow step embeds source inline.
// ---------------------------------------------------------------------------

program
  .command("read-component-metadata")
  .description("Print a component's version_file/version_key/changelog/kind from a release.yml (was a release_config heredoc)")
  .requiredOption("--config <path>")
  .requiredOption("--component <name>")
  .action(
    action((opts: { config: string; component: string }) => {
      const config = releaseConfig.loadReleaseConfig(opts.config);
      const component = (config.components as Json[]).find((c: Json) => c.name === opts.component);
      if (!component) {
        throw new Error(`Component '${opts.component}' not found in ${opts.config}`);
      }
      console.log(`version_file=${component.version_file}`);
      console.log(`version_key=${component.version_key}`);
      console.log(`changelog=${component.changelog}`);
      console.log(`kind=${component.kind}`);
    })
  );

program
  .command("read-payload-fields")
  .description("Print a dependency-dispatch payload's component/version (was a dependency_payload heredoc)")
  .requiredOption("--payload <path>")
  .action(
    action((opts: { payload: string }) => {
      const payload = dependencyPayload.fromJson(readFileSync(opts.payload, "utf-8"));
      console.log(`component=${payload.component}`);
      console.log(`version=${payload.version}`);
    })
  );

program
  .command("consumers-for")
  .description("Print the JSON array of consumer repositories for a component in components.yml (was a components_registry heredoc)")
  .requiredOption("--registry <path>")
  .requiredOption("--component <name>")
  .action(
    action((opts: { registry: string; component: string }) => {
      const registry = componentsRegistry.loadRegistry(opts.registry);
      const consumers = componentsRegistry.consumersFor(registry, opts.component);
      console.log(`json=${JSON.stringify(consumers)}`);
    })
  );

program
  .command("read-event-fields")
  .description("Print a release event's component/version/repository (was a release_event heredoc)")
  .requiredOption("--event <path>")
  .action(
    action((opts: { event: string }) => {
      const event = releaseEvent.fromJson(readFileSync(opts.event, "utf-8"));
      console.log(`component=${event.component}`);
      console.log(`version=${event.version}`);
      console.log(`repository=${event.repository}`);
    })
  );

program
  .command("validate-release-event")
  .description("Validate a release event's schema only, no live verification (was a release_event heredoc)")
  .requiredOption("--event <path>")
  .action(
    action((opts: { event: string }) => {
      const event = releaseEvent.fromJson(readFileSync(opts.event, "utf-8"));
      report(releaseEvent.validateEvent(event));
    })
  );

program
  .command("read-marker-bump")
  .description("Print only the 'bump' field of a release marker (was a release_marker heredoc)")
  .requiredOption("--marker <path>")
  .action(
    action((opts: { marker: string }) => {
      const marker = releaseMarker.fromJson(readFileSync(opts.marker, "utf-8"));
      console.log(marker.bump);
    })
  );

program
  .command("poll-maven-central")
  .description("Poll Maven Central until a coordinate's POM is mirrored (was an artifact_verify heredoc)")
  .requiredOption("--group <group>")
  .requiredOption("--artifact <artifact>")
  .requiredOption("--version <version>")
  .option("--max-attempts <n>", "Maximum poll attempts", "12")
  .option("--initial-delay <seconds>", "Initial delay in seconds before the first retry", "15")
  .action(
    action(async (opts: { group: string; artifact: string; version: string; maxAttempts: string; initialDelay: string }) => {
      const url = artifactVerify.mavenCentralPomUrl(opts.group, opts.artifact, opts.version);
      await artifactVerify.pollUntilAvailable(artifactVerify.headRequestCheck, {
        url,
        maxAttempts: parseInt(opts.maxAttempts, 10),
        initialDelay: parseFloat(opts.initialDelay),
      });
      console.log(`Verified ${opts.group}:${opts.artifact}:${opts.version} is available on Maven Central`);
    })
  );

program
  .command("resolve-japicmp-baseline")
  .description("Read release asset names from stdin, print the exact comparable baseline jar name if one exists (never fabricated)")
  .option("--component <name>", "Component name prefix", "toolchain-logging")
  .option("--version <version>", "Exact baseline version to require, if known")
  .action(
    action(async (opts: { component: string; version?: string }) => {
      const assets = (await readStdin())
        .split(/\r\n|\r|\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const baseline = resolveJapicmpBaseline.findBaselineAsset(assets, { component: opts.component, version: opts.version ?? null });
      if (baseline) console.log(baseline);
    })
  );

program
  .command("resolve-platform-manifest")
  .description("Resolve+live-verify a platform manifest for the Docker workflow, printing every downstream build input (was a build-docker.yml heredoc)")
  .requiredOption("--manifest <path>")
  .option("--token <token>", "GitHub token, to raise the API rate limit")
  .action(
    action(async (opts: { manifest: string; token?: string }) => {
      const manifest = platformManifest.loadPlatformManifest(opts.manifest);
      const errors = platformManifest.validatePlatformManifest(manifest);
      if (errors.length > 0) throw new Error(errors.join("\n"));

      const token = opts.token;
      const fetchTagRef = (repo: string, tag: string) => artifactVerify.fetchTagRef(repo, tag, { token });
      const fetchTagObject = (repo: string, sha: string) => artifactVerify.fetchGitTagObject(repo, sha, { token });
      const fetchRelease = (repo: string, tag: string) => artifactVerify.fetchGithubRelease(repo, tag, { token });

      const commitErrors = await platformManifest.verifyComponentCommits(manifest, { fetchTagRef, fetchTagObject });
      if (commitErrors.length > 0) throw new Error(commitErrors.join("\n"));

      const lines: string[] = [];

      for (const [key, component] of Object.entries(manifest.components) as [string, Json][]) {
        const releaseJson = await fetchRelease(component.repository, component.tag);

        const liveSha256 = artifactVerify.findAssetSha256(releaseJson, component.asset);
        if (liveSha256.toLowerCase() !== component.sha256.toLowerCase()) {
          throw new Error(
            `sha256 mismatch for ${key} asset '${component.asset}': manifest has ${component.sha256}, live release has ${liveSha256}`
          );
        }

        // A component may publish its own manifest artifact (e.g. a
        // per-component SBOM/version manifest) that is cross-checked here
        // directly. Absent that (as for a legacy seed), the tag->commit
        // re-derivation above is the explicit provenance check instead.
        const componentManifest = component.component_manifest;
        if (componentManifest) {
          const assetName = componentManifest.asset;
          const releaseAsset = (releaseJson.assets ?? []).find((a: Json) => a.name === assetName);
          const assetUrl = releaseAsset?.browser_download_url;
          if (!assetUrl) {
            throw new Error(`${key}: component_manifest asset '${assetName}' not found in release ${component.tag}`);
          }
          const response = await fetch(assetUrl, { signal: AbortSignal.timeout(15_000) });
          const content = yaml.load(await response.text()) as Json;
          const crossCheckErrors = platformManifest.validateComponentManifestContent(component, content);
          if (crossCheckErrors.length > 0) {
            throw new Error(crossCheckErrors.map((e) => `${key}: ${e}`).join("\n"));
          }
          console.error(`${key}: verified against published component_manifest asset '${assetName}'`);
        } else {
          console.error(`${key}: no published component_manifest asset; verified via live tag->commit dereference (legacy)`);
        }

        const url = `https://github.com/${component.repository}/releases/download/${component.tag}/${component.asset}`;
        lines.push(`${key}_asset_url=${url}`);
        lines.push(`${key}_sha256=${component.sha256}`);
        lines.push(`${key}_version=${component.version}`);
        lines.push(`${key}_commit=${component.commit}`);
      }

      lines.push(`core_version=${manifest.components.toolchain.embeds.core}`);

      const manifestBytes = readFileSync(opts.manifest);
      lines.push(`manifest_sha256=${createHash("sha256").update(manifestBytes).digest("hex")}`);

      lines.push(`created=${new Date().toISOString().split(".")[0]}Z`);

      console.log(lines.join("\n"));
    })
  );

  return program;
}

function writeFile(path: string, content: string): void {
  writeFileSync(path, content, "utf-8");
}

/**
 * Parses and dispatches `argv` (no node/script prefix - just the subcommand
 * and its flags), returning the process exit code without ever calling
 * `process.exit` itself, so tests can invoke this directly and inspect
 * stdout/stderr/return code.
 */
export async function main(argv: string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (exc) {
    if (exc instanceof ReportedErrors) {
      for (const error of exc.errors) {
        console.error(`::error::${error}`);
      }
      return 1;
    }
    console.error(`::error::${(exc as Error).message}`);
    return 1;
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
