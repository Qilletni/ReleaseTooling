/**
 * The checked-in release marker (`release/pending-release.json`).
 *
 * The release-preparation PR commits this marker alongside its version/
 * changelog changes. It is the durable, checked-in record of *which*
 * upcoming release a given commit represents, so that:
 *
 * - the japicmp policy tier (patch/minor/major) is recoverable at publish
 *   time without re-deriving it from Maven Central lookups, and
 * - the post-merge automation can confirm a stable version landed on
 *   `master` *because* a genuine, reviewed release-preparation PR was
 *   merged, rather than being spoofed by an unrelated pull request.
 */

import type { Json } from "./release_config.js";

export const REQUIRED_FIELDS = ["component", "from_version", "to_version", "bump"] as const;
const BUMP_KINDS = ["major", "minor", "patch"] as const;

export interface ReleaseMarker {
  component: string;
  from_version: string;
  to_version: string;
  bump: string;
}

export function buildMarker(options: { component: string; fromVersion: string; toVersion: string; bump: string }): ReleaseMarker {
  return {
    component: options.component,
    from_version: options.fromVersion,
    to_version: options.toVersion,
    bump: options.bump,
  };
}

export function toJson(marker: ReleaseMarker): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(marker).sort()) {
    ordered[key] = (marker as unknown as Record<string, unknown>)[key];
  }
  return JSON.stringify(ordered, null, 2) + "\n";
}

export function fromJson(text: string): ReleaseMarker {
  return JSON.parse(text);
}

/** Validates a marker matches the component/version that is actually being released. */
export function validateMarker(marker: Json, options: { expectedComponent: string; expectedVersion: string }): string[] {
  const errors: string[] = [];
  const { expectedComponent, expectedVersion } = options;

  for (const field of REQUIRED_FIELDS) {
    if (!marker[field]) {
      errors.push(`Missing required field '${field}' in release marker`);
    }
  }

  const component = marker.component;
  if (component && component !== expectedComponent) {
    errors.push(`Release marker component '${component}' does not match expected '${expectedComponent}'`);
  }

  const toVersion = marker.to_version;
  if (toVersion && toVersion !== expectedVersion) {
    errors.push(`Release marker to_version '${toVersion}' does not match released version '${expectedVersion}'`);
  }

  const bump = marker.bump;
  if (bump && !(BUMP_KINDS as readonly string[]).includes(bump)) {
    errors.push(`Release marker has unknown bump kind '${bump}', expected one of ${BUMP_KINDS.join(", ")}`);
  }

  return errors;
}

/** The branch name the reusable release-preparation workflow always uses. */
export function expectedBranchName(options: { component: string; version: string }): string {
  return `release/${options.component}-${options.version}`;
}

export interface PullRequest {
  head?: { ref?: string };
  labels?: { name?: string }[];
  merged_at?: string | null;
}

/**
 * Confirms the merge commit came from a genuine, merged release-preparation
 * PR.
 *
 * `pullRequests` is the GitHub API response for
 * `GET /repos/{owner}/{repo}/commits/{sha}/pulls` (the pull request(s)
 * associated with a commit). At least one of them must be merged, from the
 * exact `release/<component>-<version>` branch, and carry the `release`
 * label applied exclusively by the reusable release-preparation workflow's
 * `peter-evans/create-pull-request` step - so an unrelated PR (which would
 * not have that branch name/label combination) cannot spoof a release.
 */
export function validateMergeProvenance(pullRequests: PullRequest[], options: { component: string; version: string }): string[] {
  const expectedRef = expectedBranchName({ component: options.component, version: options.version });

  for (const pull of pullRequests) {
    const headRef = pull.head?.ref;
    const labels = (pull.labels ?? []).map((label) => label.name);

    if (headRef === expectedRef && labels.includes("release") && pull.merged_at) {
      return [];
    }
  }

  return [
    `No merged pull request from branch '${expectedRef}' with the 'release' label was found for this commit; refusing to auto-publish.`,
  ];
}
