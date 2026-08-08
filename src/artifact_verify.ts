/**
 * Published-artifact polling and SHA-256 verification.
 *
 * Used after publishing to Maven Central (poll until the POM is reachable
 * before dispatching downstream notifications) and when consuming pinned
 * GitHub release assets (e.g. building the platform Docker image), where the
 * exact asset name and SHA-256 digest must match before download.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import type { Json } from "./release_config.js";

export class ArtifactNotFoundError extends Error {}

/** Raised (thrown) by a `check` callable to signal 'not ready yet, retry later'. */
export class PollTransientError extends Error {}

/** Returns true if the file at `path` hashes to `expectedSha256` (case-insensitive). */
export function verifySha256(path: string, expectedSha256: string): boolean {
  const digest = createHash("sha256");
  digest.update(readFileSync(path));
  return digest.digest("hex").toLowerCase() === expectedSha256.toLowerCase();
}

export interface PollOptions {
  url?: string;
  maxAttempts?: number;
  initialDelay?: number;
  backoffFactor?: number;
  sleep?: (seconds: number) => Promise<void>;
}

const defaultSleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * Calls `check(url)` until it stops raising `PollTransientError`.
 *
 * Sleeps `initialDelay * backoffFactor ** attempt` seconds between attempts
 * (via the injectable `sleep` callable, for deterministic tests). Throws
 * ArtifactNotFoundError once `maxAttempts` is exhausted.
 */
export async function pollUntilAvailable<T>(
  check: (url: string) => Promise<T> | T,
  options: PollOptions = {}
): Promise<T> {
  const { url = "", maxAttempts = 10, initialDelay = 5.0, backoffFactor = 2.0, sleep = defaultSleep } = options;

  let delay = initialDelay;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await check(url);
    } catch (exc) {
      if (!(exc instanceof PollTransientError)) throw exc;
      lastError = exc;
      if (attempt === maxAttempts - 1) break;
      await sleep(delay);
      delay *= backoffFactor;
    }
  }

  throw new ArtifactNotFoundError(`Artifact was not available after ${maxAttempts} attempts: ${lastError}`);
}

export function mavenCentralPomUrl(group: string, artifact: string, version: string): string {
  const groupPath = group.replace(/\./g, "/");
  return `https://repo1.maven.org/maven2/${groupPath}/${artifact}/${version}/${artifact}-${version}.pom`;
}

export function mavenCentralJarUrl(
  group: string,
  artifact: string,
  version: string,
  options: { classifier?: string; extension?: string } = {}
): string {
  const { classifier, extension = "jar" } = options;
  const groupPath = group.replace(/\./g, "/");
  const suffix = classifier ? `-${classifier}` : "";
  return `https://repo1.maven.org/maven2/${groupPath}/${artifact}/${version}/${artifact}-${version}${suffix}.${extension}`;
}

export type Opener = (url: string) => Promise<AsyncIterable<Uint8Array>>;

const defaultOpener: Opener = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    const error = new Error(`Request to '${url}' failed with status ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  if (!response.body) throw new Error(`No response body from '${url}'`);
  return Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream);
};

/**
 * Streams `url` through SHA-256 (never buffering the whole response in
 * memory) and compares against `expectedSha256` (case-insensitive).
 *
 * `opener(url)` must return an async-iterable of chunks (defaults to a live
 * `fetch`); injectable so tests never touch the network.
 */
export async function verifyRemoteSha256(url: string, expectedSha256: string, options: { opener?: Opener } = {}): Promise<boolean> {
  const opener = options.opener ?? defaultOpener;
  const digest = createHash("sha256");

  const body = await opener(url);
  for await (const chunk of body) {
    digest.update(chunk);
  }

  return digest.digest("hex").toLowerCase() === expectedSha256.toLowerCase();
}

/**
 * Default `check` callable for `pollUntilAvailable`: a HEAD request.
 *
 * Throws `PollTransientError` on 404 (not yet published) and re-throws any
 * other HTTP/network error unchanged.
 */
export async function headRequestCheck(url: string): Promise<boolean> {
  const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
  if (response.status === 404) {
    throw new PollTransientError(`'${url}' is not published yet (404)`);
  }
  return response.status === 200;
}

/**
 * Confirms a `GET .../git/ref/tags/{tag}` response dereferences to
 * `expectedCommit`.
 *
 * A lightweight tag's `object` points directly at a commit. An annotated
 * tag's `object` points at a tag object instead, which itself must be
 * fetched (`GET .../git/tags/{sha}`, passed in as `tagObjectJson`) and
 * dereferenced one level further to reach the commit.
 */
export function verifyTagDereferencesToCommit(
  refJson: Json,
  expectedCommit: string,
  options: { tagObjectJson?: Json | null } = {}
): boolean {
  const obj = refJson.object ?? {};

  if (obj.type === "commit") {
    return obj.sha === expectedCommit;
  }

  if (obj.type === "tag") {
    if (!options.tagObjectJson) {
      throw new Error("Annotated tag requires 'tagObjectJson' (the dereferenced tag object) to verify the commit");
    }
    return options.tagObjectJson.object?.sha === expectedCommit;
  }

  return false;
}

/** Extracts the SHA-256 digest of a named asset from a GitHub release API payload. */
export function findAssetSha256(releaseJson: Json, assetName: string): string {
  for (const asset of releaseJson.assets ?? []) {
    if (asset.name === assetName) {
      const digest = asset.digest ?? "";
      if (typeof digest === "string" && digest.startsWith("sha256:")) {
        return digest.slice("sha256:".length);
      }
      throw new ArtifactNotFoundError(`Asset '${assetName}' has no sha256 digest available`);
    }
  }

  throw new ArtifactNotFoundError(`Asset '${assetName}' not found in release assets`);
}

async function fetchGithubJson(url: string, options: { token?: string | null } = {}): Promise<Json> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`GitHub API request to '${url}' failed with status ${response.status}`);
  }
  return response.json();
}

/** Fetches a GitHub release's JSON payload by tag (used to discover exact asset digests). */
export function fetchGithubRelease(repository: string, tag: string, options: { token?: string | null } = {}): Promise<Json> {
  return fetchGithubJson(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, options);
}

/** Fetches `GET /repos/{repository}/git/ref/tags/{tag}` (used with `verifyTagDereferencesToCommit`). */
export function fetchTagRef(repository: string, tag: string, options: { token?: string | null } = {}): Promise<Json> {
  return fetchGithubJson(`https://api.github.com/repos/${repository}/git/ref/tags/${tag}`, options);
}

/** Fetches `GET /repos/{repository}/git/tags/{sha}`, dereferencing an annotated tag one level further. */
export function fetchGitTagObject(repository: string, sha: string, options: { token?: string | null } = {}): Promise<Json> {
  return fetchGithubJson(`https://api.github.com/repos/${repository}/git/tags/${sha}`, options);
}

/** Fetches `GET /repos/{repository}/commits/{sha}/pulls` (used with `release_marker.validateMergeProvenance`). */
export function fetchCommitPullRequests(repository: string, commitSha: string, options: { token?: string | null } = {}): Promise<Json> {
  return fetchGithubJson(`https://api.github.com/repos/${repository}/commits/${commitSha}/pulls`, options);
}
