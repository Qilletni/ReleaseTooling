/**
 * Loading and validating a repository's `.qilletni/release.yml`.
 */

import { readFileSync } from "node:fs";
import yaml from "js-yaml";

export const SUPPORTED_SCHEMA_VERSIONS = [1] as const;
export const SUPPORTED_KINDS = ["maven", "cli", "docs"] as const;
export const SUPPORTED_JAPICMP_LEVELS = ["patch", "minor", "major"] as const;

// A 'group:artifact' Maven coordinate with no version segment - the exact
// coordinate a `dependencies[].coordinates` entry declares as allowed.
const DEPENDENCY_COORDINATE_RE = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.startsWith("\\") || path.includes(":")) {
    return false;
  }
  return !path.replace(/\\/g, "/").split("/").includes("..");
}

interface ParsedCoordinateEntry {
  coordinate: Json;
  resolved: boolean | null;
  error: string | null;
}

/**
 * Parses a single 'dependencies[].coordinates' entry - either a plain
 * 'group:artifact' string (implicitly 'resolved: true'), or a mapping with
 * a required 'coordinate' and an optional 'resolved' boolean flag.
 *
 * A coordinate marked 'resolved: false' stays mandatory and hash-verified
 * like any other, but is excluded from the resolved-dependency-graph
 * presence check.
 */
function parseCoordinateEntry(entry: Json): ParsedCoordinateEntry {
  if (typeof entry === "string") {
    return { coordinate: entry, resolved: true, error: null };
  }
  if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
    if (!("coordinate" in entry)) {
      return { coordinate: null, resolved: null, error: "coordinate mapping is missing required field 'coordinate'" };
    }
    const coordinate = entry.coordinate;
    const resolved = "resolved" in entry ? entry.resolved : true;
    if (typeof resolved !== "boolean") {
      return { coordinate, resolved: null, error: `'resolved' must be a boolean, got ${JSON.stringify(resolved)}` };
    }
    return { coordinate, resolved, error: null };
  }
  return { coordinate: null, resolved: null, error: `must be a 'group:artifact' string or a mapping with 'coordinate', got ${JSON.stringify(entry)}` };
}

export interface NormalizedCoordinate {
  coordinate: string;
  resolved: boolean;
}

/**
 * Returns a dependency's 'coordinates' normalized to
 * `[{coordinate, resolved}, ...]`, expanding plain 'group:artifact' string
 * entries to 'resolved: true'. Assumes `dependency` has already passed
 * `validateReleaseConfig`.
 */
export function normalizedCoordinates(dependency: Json): NormalizedCoordinate[] {
  const result: NormalizedCoordinate[] = [];
  for (const entry of dependency.coordinates ?? []) {
    const { coordinate, resolved } = parseCoordinateEntry(entry);
    result.push({ coordinate, resolved: resolved === null ? true : resolved });
  }
  return result;
}

export function parseReleaseConfig(text: string): Json {
  const data = yaml.load(text);
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("release.yml must contain a top-level mapping");
  }
  return data;
}

export function loadReleaseConfig(path: string): Json {
  return parseReleaseConfig(readFileSync(path, "utf-8"));
}

export function validateReleaseConfig(config: Json): string[] {
  const errors: string[] = [];

  const schemaVersion = config.schema_version;
  if (schemaVersion === undefined || schemaVersion === null) {
    errors.push("Missing required field 'schema_version'");
  } else if (!(SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(schemaVersion)) {
    errors.push(`Unsupported schema_version ${JSON.stringify(schemaVersion)}, expected one of ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}`);
  }

  if (!config.repository) {
    errors.push("Missing required field 'repository'");
  }

  let components: Json[] = config.components ?? [];
  if (!components || components.length === 0) {
    errors.push("'components' must contain at least one entry");
    components = [];
  }

  const seenNames = new Set<string>();
  components.forEach((component: Json, index: number) => {
    const prefix = `components[${index}]`;

    const name = component.name;
    if (!name) {
      errors.push(`${prefix}: missing required field 'name'`);
    } else if (seenNames.has(name)) {
      errors.push(`${prefix}: duplicate component name '${name}'`);
    } else {
      seenNames.add(name);
    }

    const kind = component.kind;
    if (!kind) {
      errors.push(`${prefix}: missing required field 'kind'`);
    } else if (!(SUPPORTED_KINDS as readonly string[]).includes(kind)) {
      errors.push(`${prefix}: unsupported kind '${kind}', expected one of ${SUPPORTED_KINDS.join(", ")}`);
    }

    if (!component.version_file) errors.push(`${prefix}: missing required field 'version_file'`);
    if (!component.version_key) errors.push(`${prefix}: missing required field 'version_key'`);
    if (!component.changelog) errors.push(`${prefix}: missing required field 'changelog'`);

    if (kind === "maven") {
      const artifacts: Json[] = component.artifacts;
      if (!artifacts || artifacts.length === 0) {
        errors.push(`${prefix}: 'artifacts' must contain at least one entry when kind is 'maven'`);
      } else {
        artifacts.forEach((artifact: Json, artifactIndex: number) => {
          const artifactPrefix = `${prefix}.artifacts[${artifactIndex}]`;

          const maven = artifact.maven;
          if (!maven) {
            errors.push(`${artifactPrefix}: 'maven' block is required`);
          } else {
            if (!maven.group) errors.push(`${artifactPrefix}.maven: missing required field 'group'`);
            if (!maven.artifact) errors.push(`${artifactPrefix}.maven: missing required field 'artifact'`);
          }

          const japicmp = artifact.japicmp;
          if (
            japicmp &&
            japicmp.enabled &&
            japicmp.policy !== undefined &&
            japicmp.policy !== null &&
            !(SUPPORTED_JAPICMP_LEVELS as readonly string[]).includes(japicmp.policy)
          ) {
            errors.push(`${artifactPrefix}.japicmp: unsupported policy '${japicmp.policy}'`);
          }
        });
      }
    }
  });

  // 'dependencies' is optional - a pure release producer with nothing of its
  // own to consume declares none. Each entry maps one upstream component to
  // the exact Maven coordinates it publishes together and the single local
  // version file/key that tracks them.
  const dependencies: Json[] = config.dependencies ?? [];
  const seenUpstreamComponents = new Set<string>();
  const seenCoordinates = new Set<string>();
  dependencies.forEach((dependency: Json, index: number) => {
    const prefix = `dependencies[${index}]`;

    const upstreamComponent = dependency.upstream_component;
    if (!upstreamComponent) {
      errors.push(`${prefix}: missing required field 'upstream_component'`);
    } else if (seenUpstreamComponents.has(upstreamComponent)) {
      errors.push(`${prefix}: duplicate upstream_component '${upstreamComponent}'`);
    } else {
      seenUpstreamComponents.add(upstreamComponent);
    }

    if (!dependency.repository) {
      errors.push(`${prefix}: missing required field 'repository'`);
    }

    const coordinates: Json[] = dependency.coordinates;
    if (!coordinates || coordinates.length === 0) {
      errors.push(`${prefix}: 'coordinates' must contain at least one entry`);
    } else {
      let resolvedCount = 0;
      coordinates.forEach((coordinateEntry: Json, coordIndex: number) => {
        const coordPrefix = `${prefix}.coordinates[${coordIndex}]`;
        const { coordinate, resolved, error: entryError } = parseCoordinateEntry(coordinateEntry);
        if (entryError) {
          errors.push(`${coordPrefix}: ${entryError}`);
          return;
        }
        if (typeof coordinate !== "string" || !DEPENDENCY_COORDINATE_RE.test(coordinate)) {
          errors.push(
            `${coordPrefix}: '${coordinate}' is not a valid 'group:artifact' Maven coordinate (no version segment allowed)`
          );
          return;
        }
        if (seenCoordinates.has(coordinate)) {
          errors.push(
            `${coordPrefix}: duplicate mapping - coordinate '${coordinate}' is already declared by another 'dependencies' entry`
          );
          return;
        }
        seenCoordinates.add(coordinate);
        if (resolved) resolvedCount++;
      });

      if (resolvedCount === 0) {
        errors.push(
          `${prefix}: at least one 'coordinates' entry must be 'resolved: true' (all entries are marked 'resolved: false')`
        );
      }
    }

    const versionFile = dependency.version_file;
    if (!versionFile) {
      errors.push(`${prefix}: missing required field 'version_file'`);
    } else if (!isSafeRelativePath(versionFile)) {
      errors.push(
        `${prefix}: 'version_file' must be a safe relative path (no '..' or absolute path), got '${versionFile}'`
      );
    }

    if (!dependency.version_key) {
      errors.push(`${prefix}: missing required field 'version_key'`);
    }
  });

  return errors;
}
