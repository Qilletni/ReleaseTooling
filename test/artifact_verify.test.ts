import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import * as artifactVerify from "../src/artifact_verify.js";

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function* toAsyncIterable(data: Buffer): AsyncIterable<Uint8Array> {
  yield data;
}

describe("verifySha256", () => {
  it("passes for a matching hash", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-tools-"));
    const path = join(tmp, "asset.bin");
    writeFileSync(path, "hello world");
    const expected = sha256Hex(Buffer.from("hello world"));
    expect(artifactVerify.verifySha256(path, expected)).toBe(true);
  });

  it("fails for a mismatched hash", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-tools-"));
    const path = join(tmp, "asset.bin");
    writeFileSync(path, "hello world");
    expect(artifactVerify.verifySha256(path, "0".repeat(64))).toBe(false);
  });

  it("compares case-insensitively", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-tools-"));
    const path = join(tmp, "asset.bin");
    writeFileSync(path, "hello world");
    const expected = sha256Hex(Buffer.from("hello world")).toUpperCase();
    expect(artifactVerify.verifySha256(path, expected)).toBe(true);
  });
});

describe("pollUntilAvailable", () => {
  it("returns true once the check succeeds", async () => {
    const responses: (Error | true)[] = [new artifactVerify.PollTransientError("not yet"), true];
    const fakeCheck = async () => {
      const result = responses.shift();
      if (result instanceof Error) throw result;
      return result;
    };

    const sleeps: number[] = [];
    const found = await artifactVerify.pollUntilAvailable(fakeCheck, {
      maxAttempts: 5,
      initialDelay: 0.01,
      sleep: async (s) => {
        sleeps.push(s);
      },
    });
    expect(found).toBe(true);
    expect(sleeps.length).toBe(1);
  });

  it("throws after exhausting attempts", async () => {
    const alwaysFail = async () => {
      throw new artifactVerify.PollTransientError("still missing");
    };

    await expect(
      artifactVerify.pollUntilAvailable(alwaysFail, { maxAttempts: 3, initialDelay: 0.01, sleep: async () => {} })
    ).rejects.toThrow(artifactVerify.ArtifactNotFoundError);
  });

  it("increases the backoff delay", async () => {
    const alwaysFail = async () => {
      throw new artifactVerify.PollTransientError("still missing");
    };

    const delays: number[] = [];
    await expect(
      artifactVerify.pollUntilAvailable(alwaysFail, {
        maxAttempts: 4,
        initialDelay: 1.0,
        backoffFactor: 2.0,
        sleep: async (s) => {
          delays.push(s);
        },
      })
    ).rejects.toThrow(artifactVerify.ArtifactNotFoundError);
    expect(delays).toEqual([1.0, 2.0, 4.0]);
  });
});

describe("mavenCentralPomUrl", () => {
  it("builds the expected URL for a release", () => {
    const url = artifactVerify.mavenCentralPomUrl("dev.qilletni.impl", "qilletni", "1.1.0");
    expect(url).toBe("https://repo1.maven.org/maven2/dev/qilletni/impl/qilletni/1.1.0/qilletni-1.1.0.pom");
  });
});

describe("mavenCentralJarUrl", () => {
  it("builds the expected jar URL", () => {
    const url = artifactVerify.mavenCentralJarUrl("dev.qilletni.impl", "qilletni", "1.1.0");
    expect(url).toBe("https://repo1.maven.org/maven2/dev/qilletni/impl/qilletni/1.1.0/qilletni-1.1.0.jar");
  });

  it("builds a URL with classifier and extension", () => {
    const url = artifactVerify.mavenCentralJarUrl("dev.qilletni.impl", "qilletni", "1.1.0", { classifier: "sources", extension: "jar" });
    expect(url).toBe("https://repo1.maven.org/maven2/dev/qilletni/impl/qilletni/1.1.0/qilletni-1.1.0-sources.jar");
  });
});

describe("verifyRemoteSha256", () => {
  it("passes for a matching hash", async () => {
    const data = Buffer.from("the jar file contents");
    const expected = sha256Hex(data);
    const opener = async () => toAsyncIterable(data);
    expect(await artifactVerify.verifyRemoteSha256("https://example.invalid/a.jar", expected, { opener })).toBe(true);
  });

  it("fails for a mismatched hash", async () => {
    const data = Buffer.from("the jar file contents");
    const opener = async () => toAsyncIterable(data);
    expect(await artifactVerify.verifyRemoteSha256("https://example.invalid/a.jar", "0".repeat(64), { opener })).toBe(false);
  });

  it("compares case-insensitively", async () => {
    const data = Buffer.from("the jar file contents");
    const expected = sha256Hex(data).toUpperCase();
    const opener = async () => toAsyncIterable(data);
    expect(await artifactVerify.verifyRemoteSha256("https://example.invalid/a.jar", expected, { opener })).toBe(true);
  });

  it("streams large content in chunks", async () => {
    const data = Buffer.alloc(1024 * 1024 * 3 + 17, "x");
    const expected = sha256Hex(data);
    const opener = async () => Readable.from(data);
    expect(await artifactVerify.verifyRemoteSha256("https://example.invalid/a.jar", expected, { opener })).toBe(true);
  });
});

describe("findAssetSha256", () => {
  it("finds a matching asset digest", () => {
    const releaseJson = {
      assets: [
        { name: "qilletni-1.0.1.tar.gz", digest: "sha256:" + "a".repeat(64) },
        { name: "QilletniToolchain.jar", digest: "sha256:" + "b".repeat(64) },
      ],
    };
    const digest = artifactVerify.findAssetSha256(releaseJson, "qilletni-1.0.1.tar.gz");
    expect(digest).toBe("a".repeat(64));
  });

  it("throws for a missing asset", () => {
    const releaseJson = { assets: [] };
    expect(() => artifactVerify.findAssetSha256(releaseJson, "missing.tar.gz")).toThrow(artifactVerify.ArtifactNotFoundError);
  });
});

describe("verifyTagDereferencesToCommit", () => {
  it("matches directly for a lightweight tag", () => {
    const refJson = { object: { type: "commit", sha: "c".repeat(40) } };
    expect(artifactVerify.verifyTagDereferencesToCommit(refJson, "c".repeat(40))).toBe(true);
  });

  it("mismatches for a lightweight tag", () => {
    const refJson = { object: { type: "commit", sha: "c".repeat(40) } };
    expect(artifactVerify.verifyTagDereferencesToCommit(refJson, "d".repeat(40))).toBe(false);
  });

  it("matches an annotated tag via the tag object", () => {
    const refJson = { object: { type: "tag", sha: "e".repeat(40) } };
    const tagObjectJson = { object: { type: "commit", sha: "c".repeat(40) } };
    expect(artifactVerify.verifyTagDereferencesToCommit(refJson, "c".repeat(40), { tagObjectJson })).toBe(true);
  });

  it("mismatches an annotated tag via the tag object", () => {
    const refJson = { object: { type: "tag", sha: "e".repeat(40) } };
    const tagObjectJson = { object: { type: "commit", sha: "c".repeat(40) } };
    expect(artifactVerify.verifyTagDereferencesToCommit(refJson, "d".repeat(40), { tagObjectJson })).toBe(false);
  });

  it("throws for an annotated tag without a tag object", () => {
    const refJson = { object: { type: "tag", sha: "e".repeat(40) } };
    expect(() => artifactVerify.verifyTagDereferencesToCommit(refJson, "c".repeat(40))).toThrow();
  });
});
