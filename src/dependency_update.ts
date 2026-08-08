/**
 * Applying a validated dependency-dispatch payload (see `dependency_payload`)
 * against a consumer repository's checked-in `.qilletni/release.yml`
 * `dependencies` mapping: upstream component -> exact allowed Maven
 * coordinates -> local version file/key. Used by the
 * `reusable-dependency-update.yml` workflow.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import * as artifactVerify from "./artifact_verify.js";
import * as dependencyPayload from "./dependency_payload.js";
import * as releaseConfig from "./release_config.js";
import * as versionFiles from "./version_files.js";
import type { Json } from "./release_config.js";
import type { Opener } from "./artifact_verify.js";

// A dynamic or non-stable version must never be accepted as the target of a
// dependency update: a consumer's stable build must only ever pin an exact,
// published release.
const DISALLOWED_VERSION_MARKERS = ["SNAPSHOT", "+", "latest."];

/** Returns the `dependencies[]` entry for `upstreamComponent`, or `null`. */
export function findDependency(config: Json, upstreamComponent: string): Json | null {
  for (const dependency of config.dependencies ?? []) {
    if (dependency.upstream_component === upstreamComponent) return dependency;
  }
  return null;
}

function splitGav(coordinates: string): [string, string, string] {
  const parts = coordinates.split(":");
  if (parts.length !== 3) {
    throw new Error(`Artifact coordinates '${coordinates}' must be 'group:artifact:version'`);
  }
  return [parts[0], parts[1], parts[2]];
}

/**
 * Validates a dependency-dispatch payload's own schema, then that it may
 * legitimately update this repository:
 *
 * - its `component` must be a configured `upstream_component`
 * - its `repository` must match exactly the configured one (guards against
 *   a spoofed producer)
 * - its `version` must be a stable, non-dynamic SemVer version
 * - its artifact coordinate set must match the configured set exactly (no
 *   missing, no extra), and every artifact's own embedded version must
 *   agree with the payload's declared `version` (guards against divergent
 *   versions silently reaching the same local version key)
 */
export function validatePayloadAgainstConfig(payload: Json, config: Json): string[] {
  const errors = dependencyPayload.validatePayload(payload);
  if (errors.length > 0) return errors;

  const component = payload.component;
  const dependency = findDependency(config, component);
  if (dependency === null) {
    return [`'${component}' is not a configured dependency ('dependencies[].upstream_component') of this repository`];
  }

  if (payload.repository !== dependency.repository) {
    errors.push(
      `payload 'repository' ('${payload.repository}') does not match the configured repository '${dependency.repository}' for upstream component '${component}'`
    );
  }

  const version: string = payload.version;
  if (DISALLOWED_VERSION_MARKERS.some((marker) => version.includes(marker))) {
    errors.push(`payload 'version' ('${version}') must be a stable release version, not a SNAPSHOT/dynamic one`);
  }

  const configuredCoordinates = new Set(releaseConfig.normalizedCoordinates(dependency).map((entry) => entry.coordinate));
  const payloadCoordinates = new Set<string>();
  for (const artifact of payload.artifacts as Json[]) {
    let group: string, artifactId: string, artifactVersion: string;
    try {
      [group, artifactId, artifactVersion] = splitGav(artifact.coordinates);
    } catch (exc) {
      errors.push((exc as Error).message);
      continue;
    }

    const gavKey = `${group}:${artifactId}`;
    payloadCoordinates.add(gavKey);
    if (artifactVersion !== version) {
      errors.push(`artifact '${gavKey}' version '${artifactVersion}' does not match payload 'version' '${version}'`);
    }
  }

  for (const coordinate of [...configuredCoordinates].filter((c) => !payloadCoordinates.has(c)).sort()) {
    errors.push(`payload is missing required coordinate '${coordinate}' for upstream component '${component}'`);
  }

  for (const coordinate of [...payloadCoordinates].filter((c) => !configuredCoordinates.has(c)).sort()) {
    errors.push(`payload contains unexpected coordinate '${coordinate}' not configured for upstream component '${component}'`);
  }

  return errors;
}

/**
 * Returns the subset of a dependency's `coordinates` that must be present in
 * a consumer's resolved dependency graph - i.e. every coordinate except
 * those marked `resolved: false` (which stay mandatory/hash-verified and
 * coupled to the same version key, but are never expected on the
 * classpath).
 */
export function resolvedCoordinates(dependency: Json): Set<string> {
  return new Set(
    releaseConfig.normalizedCoordinates(dependency).filter((entry) => entry.resolved).map((entry) => entry.coordinate)
  );
}

/**
 * Returns the subset of a dependency's `coordinates` explicitly marked
 * `resolved: false` - excluded from the resolved-dependency-graph presence
 * check.
 */
export function unresolvedCoordinates(dependency: Json): Set<string> {
  return new Set(
    releaseConfig.normalizedCoordinates(dependency).filter((entry) => !entry.resolved).map((entry) => entry.coordinate)
  );
}

/**
 * Returns the exact `[file, key, value]` update(s) to apply for a payload
 * already validated against `dependency` - always exactly the configured
 * `version_file`/`version_key`, set to the payload's version. Never derived
 * from any payload-supplied path or command.
 */
export function planMetadataUpdates(dependency: Json, payload: Json): [string, string, string][] {
  return [[dependency.version_file, dependency.version_key, payload.version]];
}

/**
 * Applies each `[file, key, value]` update under `baseDir`, idempotently: a
 * file already at that value is left untouched (and not reported as
 * changed). Returns the list of file paths actually written.
 */
export function applyMetadataUpdates(updates: [string, string, string][], options: { baseDir?: string } = {}): string[] {
  const baseDir = options.baseDir ?? ".";
  const changed: string[] = [];

  for (const [fileName, key, value] of updates) {
    const path = join(baseDir, fileName);

    let current: string | null;
    try {
      current = versionFiles.getProperty(readFileSync(path, "utf-8"), key);
    } catch {
      current = null;
    }

    if (current === value) continue;

    versionFiles.updatePropertyFile(path, key, value);
    changed.push(path);
  }

  return changed;
}

/**
 * Downloads (streamed) each payload artifact's exact Maven Central jar and
 * confirms its SHA-256 matches the payload-declared digest, before any
 * metadata update is ever applied. `opener` is injectable for tests
 * (defaults to a live network fetch via `artifact_verify.verifyRemoteSha256`).
 */
export async function verifyPayloadArtifactsAvailable(payload: Json, options: { opener?: Opener } = {}): Promise<string[]> {
  const errors: string[] = [];
  for (const artifact of payload.artifacts ?? []) {
    const coordinates = artifact.coordinates;
    let group: string, artifactId: string, version: string;
    try {
      [group, artifactId, version] = splitGav(coordinates);
    } catch (exc) {
      errors.push((exc as Error).message);
      continue;
    }

    const url = artifactVerify.mavenCentralJarUrl(group, artifactId, version);
    let matches: boolean;
    try {
      matches = await artifactVerify.verifyRemoteSha256(url, artifact.sha256, { opener: options.opener });
    } catch (exc) {
      errors.push(`Failed to download/verify '${coordinates}' from '${url}': ${exc}`);
      continue;
    }

    if (!matches) {
      errors.push(`'${coordinates}' downloaded sha256 does not match the payload-declared digest`);
    }
  }

  return errors;
}
