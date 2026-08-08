/**
 * Validation for `release/platform/X.Y.Z.yml` platform manifests.
 *
 * A platform manifest pins the exact Toolchain and QPM release assets (name +
 * SHA-256) that the manually-triggered Docker workflow consumes for a given
 * `platform_version`.
 */

import { basename } from "node:path";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import * as semver from "./semver.js";
import * as artifactVerify from "./artifact_verify.js";
import type { Json } from "./release_config.js";
import type { FetchTagRef, FetchTagObject, FetchRelease } from "./release_event.js";

export const REQUIRED_COMPONENTS = ["toolchain", "qpm"] as const;

// Every component pinned by a platform manifest must record which versions of
// its own dependencies it embeds, so the Docker workflow can label and audit
// the exact composition of a platform release without re-downloading and
// inspecting each archive.
export const REQUIRED_EMBEDS: Record<string, string[]> = {
  toolchain: ["core", "api", "pkgutil", "docgen"],
  qpm: ["api", "pkgutil"],
};

const SHA256_RE = /^[0-9a-fA-F]{64}$/;
const COMMIT_RE = /^[0-9a-fA-F]{40}$/;

export function parsePlatformManifest(text: string): Json {
  const data = yaml.load(text) as Json;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("Platform manifest must contain a top-level mapping");
  }
  // Normalize numeric-looking scalars (e.g. `1.0.0` parsed by YAML) to strings.
  data.platform_version = String(data.platform_version);
  for (const component of Object.values(data.components ?? {}) as Json[]) {
    if ("version" in component) component.version = String(component.version);
    const embeds = component.embeds;
    if (embeds && typeof embeds === "object") {
      for (const key of Object.keys(embeds)) embeds[key] = String(embeds[key]);
    }
  }
  return data;
}

export function loadPlatformManifest(path: string): Json {
  return parsePlatformManifest(readFileSync(path, "utf-8"));
}

/**
 * Validates the per-component fields shared by both a full platform manifest
 * (`release/platform/X.Y.Z.yml`) and the mutable staging file
 * (`release/platform/candidates.yml`), neither of which requires the same
 * `platform_version`/filename checks the other does.
 */
export function validateComponents(components: Record<string, Json>): string[] {
  const errors: string[] = [];

  for (const [name, component] of Object.entries(components)) {
    const prefix = `components.${name}`;

    if (!component.repository) errors.push(`${prefix}: missing required field 'repository'`);

    const version = component.version;
    if (!version) {
      errors.push(`${prefix}: missing required field 'version'`);
    } else {
      try {
        semver.parse(version);
      } catch (exc) {
        errors.push(`${prefix}.version: ${(exc as Error).message}`);
      }
    }

    const tag = component.tag;
    if (!tag) {
      errors.push(`${prefix}: missing required field 'tag'`);
    } else if (version && tag !== `v${version}`) {
      errors.push(`${prefix}.tag: '${tag}' does not reference version '${version}' (expected 'v${version}')`);
    }

    if (!component.asset) errors.push(`${prefix}: missing required field 'asset'`);

    const sha256 = component.sha256;
    if (!sha256) {
      errors.push(`${prefix}: missing required field 'sha256'`);
    } else if (!SHA256_RE.test(sha256)) {
      errors.push(`${prefix}.sha256: must be a 64-character hex digest, got '${sha256}'`);
    }

    const commit = component.commit;
    if (!commit) {
      errors.push(`${prefix}: missing required field 'commit'`);
    } else if (!COMMIT_RE.test(commit)) {
      errors.push(`${prefix}.commit: must be a 40-character hex commit SHA, got '${commit}'`);
    }

    const embeds = component.embeds;
    const requiredEmbeds = REQUIRED_EMBEDS[name] ?? [];
    if (!embeds) {
      errors.push(`${prefix}: missing required field 'embeds'`);
    } else {
      for (const embedName of requiredEmbeds) {
        const embedVersion = embeds[embedName];
        if (!embedVersion) {
          errors.push(`${prefix}.embeds: missing required embedded version '${embedName}'`);
        } else {
          try {
            semver.parse(embedVersion);
          } catch (exc) {
            errors.push(`${prefix}.embeds.${embedName}: ${(exc as Error).message}`);
          }
        }
      }
    }

    // Optional: a component may publish its own manifest artifact (e.g. a
    // per-component SBOM/version manifest release asset) that the Docker
    // workflow can download and cross-check against the fields declared
    // here. When absent (as for a legacy seed manifest with no such
    // artifact yet published), verification instead falls back to
    // re-deriving `commit` from the live tag (see `verifyComponentCommits`).
    const componentManifest = component.component_manifest;
    if (componentManifest !== undefined && componentManifest !== null) {
      if (typeof componentManifest !== "object" || Array.isArray(componentManifest) || !componentManifest.asset) {
        errors.push(`${prefix}.component_manifest: must be a mapping with a non-empty 'asset' field`);
      }
    }
  }

  return errors;
}

export function validatePlatformManifest(manifest: Json): string[] {
  const errors: string[] = [];

  const platformVersion = manifest.platform_version;
  if (!platformVersion) {
    errors.push("Missing required field 'platform_version'");
  } else {
    try {
      semver.parse(platformVersion);
    } catch (exc) {
      errors.push(`Invalid 'platform_version': ${(exc as Error).message}`);
    }
  }

  const components = manifest.components ?? {};
  for (const required of REQUIRED_COMPONENTS) {
    if (!(required in components)) errors.push(`Missing required component '${required}'`);
  }

  errors.push(...validateComponents(components));

  return errors;
}

/**
 * Cross-checks a fetched per-component `component_manifest` asset's own
 * declared `version`/`commit` against the values the platform manifest
 * records for that component.
 *
 * Used when a component publishes its own manifest artifact; components
 * without one (e.g. a legacy seed) are instead verified via
 * `verifyComponentCommits`.
 */
export function validateComponentManifestContent(component: Json, content: Json): string[] {
  const errors: string[] = [];

  const expectedVersion = String(component.version);
  const actualVersion = String(content.version);
  if (actualVersion !== expectedVersion) {
    errors.push(`component_manifest version '${actualVersion}' does not match platform manifest version '${expectedVersion}'`);
  }

  const expectedCommit = component.commit;
  const actualCommit = content.commit;
  if (actualCommit !== expectedCommit) {
    errors.push(`component_manifest commit '${actualCommit}' does not match platform manifest commit '${expectedCommit}'`);
  }

  return errors;
}

/**
 * Re-verifies that each component's declared `tag` still dereferences to its
 * declared `commit`.
 *
 * `fetchTagRef(repository, tag)` must return a `GET .../git/ref/tags/{tag}`
 * style payload, and `fetchTagObject(repository, sha)` a
 * `GET .../git/tags/{sha}` style payload (only called for annotated tags).
 * Both are injectable so this can be exercised without any network access;
 * the CLI wires them to `artifact_verify.fetchTagRef`/`fetchGitTagObject`
 * for real verification.
 */
export async function verifyComponentCommits(
  manifest: Json,
  options: { fetchTagRef: FetchTagRef; fetchTagObject: FetchTagObject }
): Promise<string[]> {
  const errors: string[] = [];
  for (const [name, component] of Object.entries(manifest.components ?? {}) as [string, Json][]) {
    const repository = component.repository;
    const tag = component.tag;
    const commit = component.commit;
    if (!(repository && tag && commit)) continue;

    const refJson = await options.fetchTagRef(repository, tag);
    let tagObjectJson: Json | null = null;
    if (refJson.object?.type === "tag") {
      tagObjectJson = await options.fetchTagObject(repository, refJson.object.sha);
    }

    if (!artifactVerify.verifyTagDereferencesToCommit(refJson, commit, { tagObjectJson: tagObjectJson ?? undefined })) {
      errors.push(`components.${name}.commit: tag '${tag}' of '${repository}' no longer dereferences to declared commit '${commit}'`);
    }
  }

  return errors;
}

export function validateManifestFilename(path: string, platformVersion: string): string[] {
  const expected = `${platformVersion}.yml`;
  const actual = basename(path);
  if (actual !== expected) {
    return [`Manifest filename '${actual}' does not match platform_version '${platformVersion}' (expected '${expected}')`];
  }
  return [];
}

const MANIFEST_FILENAME_RE = /^(\d+\.\d+\.\d+)\.yml$/;

/**
 * Given `release/platform/` filenames, returns the highest `X.Y.Z` manifest
 * version present.
 *
 * Non-manifest files (e.g. `candidates.yml`) are ignored. Returns `null` if
 * no `X.Y.Z.yml` manifest exists yet (the very first platform release),
 * matching `semver.latestStableTag`'s "no prior release yet" convention.
 */
export function latestPlatformVersion(filenames: string[]): string | null {
  let best: semver.SemVer | null = null;
  for (const filename of filenames) {
    const match = MANIFEST_FILENAME_RE.exec(basename(filename));
    if (!match) continue;
    const version = semver.parse(match[1]);
    if (best === null || semver.compare(version, best) > 0) best = version;
  }

  return best !== null ? semver.toStringVersion(best) : null;
}

/**
 * Re-verifies each component's declared `asset`/`sha256` against its live
 * GitHub release.
 *
 * `fetchRelease(repository, tag)` must return a `GET .../releases/tags/{tag}`
 * style payload (injectable for tests; the CLI wires it to
 * `artifact_verify.fetchGithubRelease`).
 */
export async function verifyLiveAssetProvenance(manifest: Json, options: { fetchRelease: FetchRelease }): Promise<string[]> {
  const errors: string[] = [];
  for (const [name, component] of Object.entries(manifest.components ?? {}) as [string, Json][]) {
    const repository = component.repository;
    const tag = component.tag;
    const asset = component.asset;
    const sha256 = component.sha256;
    if (!(repository && tag && asset && sha256)) continue;

    const releaseJson = await options.fetchRelease(repository, tag);
    let liveSha256: string;
    try {
      liveSha256 = artifactVerify.findAssetSha256(releaseJson, asset);
    } catch (exc) {
      if (exc instanceof artifactVerify.ArtifactNotFoundError) {
        errors.push(`components.${name}: ${exc.message}`);
        continue;
      }
      throw exc;
    }

    if (liveSha256.toLowerCase() !== String(sha256).toLowerCase()) {
      errors.push(`components.${name}.sha256: manifest has '${sha256}', live release asset '${asset}' has '${liveSha256}'`);
    }
  }

  return errors;
}
