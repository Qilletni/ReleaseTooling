/**
 * Minimal SemVer 2.0.0 parsing, comparison and bumping.
 *
 * Only the subset of the spec actually used by the Qilletni release tooling is
 * implemented (no leading `v`, numeric major/minor/patch, optional
 * `-prerelease` and `+build` metadata).
 */

const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export const BUMP_KINDS = ["major", "minor", "patch"] as const;
export type BumpKind = (typeof BUMP_KINDS)[number];

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  build: string | null;
}

export function parse(versionStr: string): SemVer {
  if (typeof versionStr !== "string") {
    throw new Error(`Version must be a string, got ${typeof versionStr}`);
  }

  const match = VERSION_RE.exec(versionStr);
  if (!match) {
    throw new Error(`'${versionStr}' is not a valid SemVer version (expected X.Y.Z[-pre][+build])`);
  }

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] ?? null,
    build: match[5] ?? null,
  };
}

export function toStringVersion(version: SemVer): string {
  let text = `${version.major}.${version.minor}.${version.patch}`;
  if (version.prerelease) text += `-${version.prerelease}`;
  if (version.build) text += `+${version.build}`;
  return text;
}

export function bump(version: SemVer, kind: string): SemVer {
  if (!(BUMP_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Unknown bump kind '${kind}', expected one of ${BUMP_KINDS.join(", ")}`);
  }

  if (kind === "major") return { major: version.major + 1, minor: 0, patch: 0, prerelease: null, build: null };
  if (kind === "minor") return { major: version.major, minor: version.minor + 1, patch: 0, prerelease: null, build: null };
  return { major: version.major, minor: version.minor, patch: version.patch + 1, prerelease: null, build: null };
}

/**
 * Computes the next development snapshot version (patch+1, `-SNAPSHOT`).
 *
 * Used for the follow-up PR that is opened right after a release is
 * published, so `master` immediately moves on to `X.Y.(Z+1)-SNAPSHOT`.
 */
export function nextSnapshot(version: SemVer): string {
  if (version.prerelease !== null) {
    throw new Error(`Cannot compute next snapshot from a prerelease version '${toStringVersion(version)}'`);
  }

  const bumped = bump(version, "patch");
  return toStringVersion({ ...bumped, prerelease: "SNAPSHOT" });
}

export function isPrerelease(version: SemVer): boolean {
  return version.prerelease !== null;
}

/**
 * Classifies `newVersion` relative to `old` as 'major', 'minor' or 'patch'.
 *
 * Used by the publish workflow to derive the japicmp policy tier purely from
 * the two released version numbers, without needing to thread the
 * originally-chosen bump kind across the release-preparation PR and the
 * later tag-triggered publish job.
 */
export function classifyBump(old: SemVer, newVersion: SemVer): BumpKind {
  if (compare(newVersion, old) <= 0) {
    throw new Error(`'${toStringVersion(newVersion)}' is not greater than '${toStringVersion(old)}'`);
  }

  if (newVersion.major !== old.major) return "major";
  if (newVersion.minor !== old.minor) return "minor";
  return "patch";
}

/** Returns -1, 0 or 1, following SemVer 2.0.0 precedence rules. */
export function compare(a: SemVer, b: SemVer): number {
  const parts: [number, number][] = [
    [a.major, b.major],
    [a.minor, b.minor],
    [a.patch, b.patch],
  ];
  for (const [left, right] of parts) {
    if (left !== right) return left < right ? -1 : 1;
  }

  if (a.prerelease === b.prerelease) return 0;

  // A version without a prerelease has higher precedence than one with.
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;

  return a.prerelease < b.prerelease ? -1 : 1;
}

const TAG_RE = /^v(\d.*)$/;

/**
 * Returns the highest stable (non-prerelease) `vX.Y.Z` tag as a version
 * string.
 *
 * Blank entries, tags that don't match `vX.Y.Z...` (e.g. `std-v1.0.0`,
 * `snapshot`) and prerelease tags are ignored. Returns null if no stable
 * release tag is found, e.g. before the very first release has been
 * published (see `nextReleaseVersion`'s first-release edge case).
 */
export function latestStableTag(tags: Iterable<string>): string | null {
  let best: SemVer | null = null;

  for (let raw of tags) {
    raw = raw.trim();
    if (!raw) continue;

    const match = TAG_RE.exec(raw);
    if (!match) continue;

    let version: SemVer;
    try {
      version = parse(match[1]);
    } catch {
      continue;
    }

    if (isPrerelease(version)) continue;

    if (best === null || compare(version, best) > 0) {
      best = version;
    }
  }

  return best !== null ? toStringVersion(best) : null;
}

/**
 * Computes the next release version for a "release prepare" run.
 *
 * Bumps from the latest *published* stable tag rather than the current
 * version-file value, which by design already holds the pending
 * `X.Y.Z-SNAPSHOT` version anticipated for the next release. Bumping from
 * the file's own value would double-increment (e.g. a checked-in
 * `1.0.2-SNAPSHOT` after `v1.0.1` was released must next release as
 * `1.0.2`, not `1.0.3`).
 *
 * When no stable tag has ever been published (first release), there is
 * nothing to bump from: the file's version, with any prerelease/build
 * metadata stripped, is already the intended first release version.
 */
export function nextReleaseVersion(options: {
  currentFileVersion: string;
  bumpKind: string;
  latestStableVersion?: string | null;
}): string {
  const { currentFileVersion, bumpKind, latestStableVersion } = options;

  if (latestStableVersion) {
    return toStringVersion(bump(parse(latestStableVersion), bumpKind));
  }

  const current = parse(currentFileVersion);
  return toStringVersion({ major: current.major, minor: current.minor, patch: current.patch, prerelease: null, build: null });
}
