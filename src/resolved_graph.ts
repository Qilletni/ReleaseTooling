/**
 * Parsing a Gradle `dependencies` task text report to assert exactly which
 * versions were resolved onto a build's classpath.
 *
 * Used after `apply-dependency-update` writes a new version into the local
 * metadata file: a transitive conflict elsewhere in the graph must never be
 * allowed to silently override the version a dependency update just
 * requested, so a stable build only ever resolves the exact coordinates it
 * was told to.
 */

import type { Json } from "./release_config.js";

// Matches both a direct resolved entry ('group:artifact:version') and a
// conflict-resolved one ('group:artifact:oldVersion -> newVersion'), as
// printed by Gradle's built-in `dependencies` task.
const ENTRY_RE = /([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)(?:\s*->\s*([A-Za-z0-9_.-]+))?/;

/**
 * Returns `{'group:artifact': effective_version}` for every dependency line
 * found in `reportText`, preferring the conflict-resolved ('-> X') version
 * when present.
 */
export function parseResolvedVersions(reportText: string): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const line of reportText.split(/\r\n|\r|\n/)) {
    const match = ENTRY_RE.exec(line);
    if (!match) continue;
    const key = `${match[1]}:${match[2]}`;
    resolved[key] = match[4] || match[3];
  }
  return resolved;
}

/**
 * Returns human-readable errors for any `expected` coordinate that is
 * either missing from the resolved graph, or resolved to a different
 * version than expected.
 */
export function checkExpectedVersions(reportText: string, expected: Record<string, string>): string[] {
  const resolved = parseResolvedVersions(reportText);
  const errors: string[] = [];
  for (const [coordinate, expectedVersion] of Object.entries(expected)) {
    const actual = resolved[coordinate];
    if (actual === undefined) {
      errors.push(`'${coordinate}' was not found in the resolved dependency graph`);
    } else if (actual !== expectedVersion) {
      errors.push(
        `'${coordinate}' resolved to '${actual}', expected '${expectedVersion}' (a transitive conflict may have overridden the requested version)`
      );
    }
  }
  return errors;
}

/**
 * Builds the `{'group:artifact': version}` map a dependency-dispatch
 * payload's own artifacts expect to see resolved, for use with
 * `checkExpectedVersions`.
 *
 * `excludeCoordinates` drops any `'group:artifact'` entries a consumer's
 * own `dependencies` config marks `resolved: false` - still mandatory and
 * hash-verified, but never expected to actually appear on that consumer's
 * classpath.
 */
export function expectedVersionsFromPayload(payload: Json, options: { excludeCoordinates?: Iterable<string> } = {}): Record<string, string> {
  const exclude = new Set(options.excludeCoordinates ?? []);
  const expected: Record<string, string> = {};
  for (const artifact of payload.artifacts ?? []) {
    const parts = String(artifact.coordinates).split(":");
    if (parts.length === 3) {
      const [group, artifactId, version] = parts;
      const key = `${group}:${artifactId}`;
      if (exclude.has(key)) continue;
      expected[key] = version;
    }
  }
  return expected;
}
