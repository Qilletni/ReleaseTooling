/**
 * Validation and construction of the cross-repository dependency-dispatch
 * payload.
 *
 * This is the exact JSON shape sent (via a GitHub App token) to every
 * consumer repository registered in `release/components.yml` after a
 * component's Maven Central publication has been verified.
 */

import * as semver from "./semver.js";
import type { Json } from "./release_config.js";

const SHA256_RE = /^[0-9a-fA-F]{64}$/;
const COMMIT_RE = /^[0-9a-fA-F]{40}$/;

export interface DependencyPayload {
  component: string;
  version: string;
  commit: string;
  repository: string;
  artifacts: { coordinates: string; sha256: string }[];
}

export function buildPayload(options: {
  component: string;
  version: string;
  commit: string;
  repository: string;
  artifacts: Iterable<[string, string]>;
}): DependencyPayload {
  return {
    component: options.component,
    version: options.version,
    commit: options.commit,
    repository: options.repository,
    artifacts: Array.from(options.artifacts, ([coordinates, sha256]) => ({ coordinates, sha256 })),
  };
}

export function validatePayload(payload: Json): string[] {
  const errors: string[] = [];

  if (!payload.component) errors.push("Missing required field 'component'");
  if (!payload.repository) errors.push("Missing required field 'repository'");

  const version = payload.version;
  if (!version) {
    errors.push("Missing required field 'version'");
  } else {
    try {
      semver.parse(version);
    } catch (exc) {
      errors.push(`Invalid 'version': ${(exc as Error).message}`);
    }
  }

  const commit = payload.commit;
  if (!commit) {
    errors.push("Missing required field 'commit'");
  } else if (!COMMIT_RE.test(commit)) {
    errors.push(`'commit' must be a 40-character hex SHA, got '${commit}'`);
  }

  const artifacts: Json[] = payload.artifacts;
  if (!artifacts || artifacts.length === 0) {
    errors.push("'artifacts' must contain at least one entry");
  } else {
    artifacts.forEach((artifact: Json, index: number) => {
      const prefix = `artifacts[${index}]`;
      if (!artifact.coordinates) errors.push(`${prefix}: missing required field 'coordinates'`);

      const sha256 = artifact.sha256;
      if (!sha256) {
        errors.push(`${prefix}: missing required field 'sha256'`);
      } else if (!SHA256_RE.test(sha256)) {
        errors.push(`${prefix}: 'sha256' must be a 64-character hex digest, got '${sha256}'`);
      }
    });
  }

  return errors;
}

export function toJson(payload: DependencyPayload): string {
  return JSON.stringify(sortKeysDeep(payload));
}

export function fromJson(text: string): DependencyPayload {
  return JSON.parse(text);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sortKeysDeep(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = sortKeysDeep(value[key]);
    }
    return result;
  }
  return value;
}
