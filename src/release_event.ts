/**
 * The immutable platform-component release event payload.
 *
 * Sent (as a `repository_dispatch` `client_payload`) by QilletniToolchain or
 * QPMCLI right after publishing a release, so this repository can update
 * `release/platform/candidates.yml` with that release's exact asset/commit
 * provenance without a human hand-editing the YAML.
 */

import * as semver from "./semver.js";
import * as platformManifest from "./platform_manifest.js";
import * as artifactVerify from "./artifact_verify.js";
import { sortKeysDeep } from "./dependency_payload.js";
import type { Json } from "./release_config.js";

export const SCHEMA_VERSION = 1;

// The only repository allowed to send an event naming a given component -
// guards against, e.g., a `qpm` event masquerading as a `toolchain` update
// even before the candidate's own recorded repository is cross-checked.
export const COMPONENT_REPOSITORIES: Record<string, string> = {
  toolchain: "Qilletni/QilletniToolchain",
  qpm: "Qilletni/QPMCLI",
};

const COMMIT_RE = /^[0-9a-fA-F]{40}$/;
const SHA256_RE = /^[0-9a-fA-F]{64}$/;
// Deliberately excludes path separators, '..' and any character not needed
// by a plain release-asset filename: 'asset' is never treated as - or
// allowed to resolve to - a filesystem path, nor may it carry executable
// content of its own (it only ever names a remote GitHub release asset).
const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ReleaseEvent {
  schema_version: number;
  component: string;
  repository: string;
  version: string;
  tag: string;
  commit: string;
  asset: string;
  sha256: string;
  embeds: Record<string, string>;
}

export function buildEvent(options: {
  component: string;
  repository: string;
  version: string;
  commit: string;
  asset: string;
  sha256: string;
  embeds: Record<string, string>;
}): ReleaseEvent {
  return {
    schema_version: SCHEMA_VERSION,
    component: options.component,
    repository: options.repository,
    version: options.version,
    tag: `v${options.version}`,
    commit: options.commit,
    asset: options.asset,
    sha256: options.sha256,
    embeds: { ...options.embeds },
  };
}

export function validateEvent(event: Json): string[] {
  const errors: string[] = [];

  const schemaVersion = event.schema_version;
  if (schemaVersion !== SCHEMA_VERSION) {
    errors.push(`Unsupported schema_version ${JSON.stringify(schemaVersion)}, expected ${SCHEMA_VERSION}`);
  }

  const component = event.component;
  if (!component) {
    errors.push("Missing required field 'component'");
  } else if (!(component in COMPONENT_REPOSITORIES)) {
    errors.push(`Unknown component '${component}', expected one of ${Object.keys(COMPONENT_REPOSITORIES).join(", ")}`);
  }

  const repository = event.repository;
  if (!repository) {
    errors.push("Missing required field 'repository'");
  } else if (component in COMPONENT_REPOSITORIES && repository !== COMPONENT_REPOSITORIES[component]) {
    errors.push(
      `'repository' ('${repository}') does not match the expected repository '${COMPONENT_REPOSITORIES[component]}' for component '${component}'`
    );
  }

  const version = event.version;
  if (!version) {
    errors.push("Missing required field 'version'");
  } else {
    try {
      semver.parse(version);
    } catch (exc) {
      errors.push(`Invalid 'version': ${(exc as Error).message}`);
    }
  }

  const tag = event.tag;
  if (!tag) {
    errors.push("Missing required field 'tag'");
  } else if (version && tag !== `v${version}`) {
    errors.push(`'tag' ('${tag}') does not reference version '${version}' (expected 'v${version}')`);
  }

  const commit = event.commit;
  if (!commit) {
    errors.push("Missing required field 'commit'");
  } else if (!COMMIT_RE.test(commit)) {
    errors.push(`'commit' must be a 40-character hex SHA, got '${commit}'`);
  }

  const asset = event.asset;
  if (!asset) {
    errors.push("Missing required field 'asset'");
  } else if (!ASSET_NAME_RE.test(asset)) {
    errors.push(`'asset' must be a plain filename (no path separators or '..'), got '${asset}'`);
  }

  const sha256 = event.sha256;
  if (!sha256) {
    errors.push("Missing required field 'sha256'");
  } else if (!SHA256_RE.test(sha256)) {
    errors.push(`'sha256' must be a 64-character hex digest, got '${sha256}'`);
  }

  const embeds = event.embeds;
  const requiredEmbeds = platformManifest.REQUIRED_EMBEDS[component] ?? [];
  if (!embeds) {
    errors.push("Missing required field 'embeds'");
  } else if (typeof embeds !== "object" || Array.isArray(embeds)) {
    errors.push("'embeds' must be a mapping");
  } else {
    for (const embedName of requiredEmbeds) {
      const embedVersion = embeds[embedName];
      if (!embedVersion) {
        errors.push(`embeds: missing required embedded version '${embedName}'`);
      } else {
        try {
          semver.parse(embedVersion);
        } catch (exc) {
          errors.push(`embeds.${embedName}: ${(exc as Error).message}`);
        }
      }
    }
  }

  return errors;
}

export type FetchTagRef = (repository: string, tag: string) => Promise<Json> | Json;
export type FetchTagObject = (repository: string, sha: string) => Promise<Json> | Json;
export type FetchRelease = (repository: string, tag: string) => Promise<Json> | Json;

/**
 * Re-verifies a validated event's `tag`/`commit`/`asset`/`sha256` against the
 * live GitHub API.
 *
 * Fails schema validation first, before making any network call, so a
 * malformed event is rejected without ever dereferencing an
 * attacker-influenced tag/asset name. `fetchTagRef`/`fetchTagObject`/
 * `fetchRelease` are injectable (the CLI wires them to the matching
 * `artifact_verify` functions).
 */
export async function verifyLiveProvenance(
  event: Json,
  options: { fetchTagRef: FetchTagRef; fetchTagObject: FetchTagObject; fetchRelease: FetchRelease }
): Promise<string[]> {
  const errors = validateEvent(event);
  if (errors.length > 0) return errors;

  const { fetchTagRef, fetchTagObject, fetchRelease } = options;
  const repository = event.repository;
  const tag = event.tag;

  const refJson = await fetchTagRef(repository, tag);
  let tagObjectJson: Json | null = null;
  if (refJson.object?.type === "tag") {
    tagObjectJson = await fetchTagObject(repository, refJson.object.sha);
  }

  if (!artifactVerify.verifyTagDereferencesToCommit(refJson, event.commit, { tagObjectJson: tagObjectJson ?? undefined })) {
    errors.push(`tag '${tag}' of '${repository}' does not dereference to the event's claimed commit '${event.commit}'`);
  }

  const releaseJson = await fetchRelease(repository, tag);
  try {
    const liveSha256 = artifactVerify.findAssetSha256(releaseJson, event.asset);
    if (liveSha256.toLowerCase() !== String(event.sha256).toLowerCase()) {
      errors.push(`sha256 mismatch for asset '${event.asset}': event claims '${event.sha256}', live release has '${liveSha256}'`);
    }
  } catch (exc) {
    if (exc instanceof artifactVerify.ArtifactNotFoundError) {
      errors.push(exc.message);
    } else {
      throw exc;
    }
  }

  return errors;
}

export function toJson(event: ReleaseEvent): string {
  return JSON.stringify(sortKeysDeep(event));
}

export function fromJson(text: string): ReleaseEvent {
  return JSON.parse(text);
}
