import { describe, it, expect } from "vitest";
import * as semver from "../src/semver.js";

describe("parse", () => {
  it("parses a plain version", () => {
    const v = semver.parse("1.2.3");
    expect([v.major, v.minor, v.patch]).toEqual([1, 2, 3]);
    expect(v.prerelease).toBeNull();
    expect(v.build).toBeNull();
  });

  it("parses a SNAPSHOT prerelease", () => {
    const v = semver.parse("1.2.3-SNAPSHOT");
    expect([v.major, v.minor, v.patch]).toEqual([1, 2, 3]);
    expect(v.prerelease).toBe("SNAPSHOT");
  });

  it("parses build metadata", () => {
    const v = semver.parse("1.2.3+build.5");
    expect(v.build).toBe("build.5");
  });

  it("parses prerelease and build together", () => {
    const v = semver.parse("2.0.0-rc.1+exp.sha.5114f85");
    expect(v.prerelease).toBe("rc.1");
    expect(v.build).toBe("exp.sha.5114f85");
  });

  it("rejects a leading v", () => {
    expect(() => semver.parse("v1.2.3")).toThrow();
  });

  it("rejects malformed versions", () => {
    for (const bad of ["1.2", "1.2.x", "", "1.2.3.4", "1.02.3"]) {
      expect(() => semver.parse(bad)).toThrow();
    }
  });
});

describe("toStringVersion", () => {
  it("round-trips a plain version", () => {
    expect(semver.toStringVersion(semver.parse("1.2.3"))).toBe("1.2.3");
  });

  it("round-trips a snapshot version", () => {
    expect(semver.toStringVersion(semver.parse("1.2.3-SNAPSHOT"))).toBe("1.2.3-SNAPSHOT");
  });

  it("round-trips a full version", () => {
    const text = "1.2.3-rc.1+build.5";
    expect(semver.toStringVersion(semver.parse(text))).toBe(text);
  });
});

describe("bump", () => {
  it("bumps patch", () => {
    expect(semver.toStringVersion(semver.bump(semver.parse("1.2.3"), "patch"))).toBe("1.2.4");
  });

  it("bumps minor and resets patch", () => {
    expect(semver.toStringVersion(semver.bump(semver.parse("1.2.3"), "minor"))).toBe("1.3.0");
  });

  it("bumps major and resets minor and patch", () => {
    expect(semver.toStringVersion(semver.bump(semver.parse("1.2.3"), "major"))).toBe("2.0.0");
  });

  it("strips prerelease and build on bump", () => {
    const result = semver.bump(semver.parse("1.2.3-SNAPSHOT+build.1"), "patch");
    expect(result.prerelease).toBeNull();
    expect(result.build).toBeNull();
  });

  it("rejects an unknown bump kind", () => {
    expect(() => semver.bump(semver.parse("1.2.3"), "banana")).toThrow();
  });

  it("computes the next snapshot", () => {
    expect(semver.nextSnapshot(semver.parse("1.2.3"))).toBe("1.2.4-SNAPSHOT");
  });

  it("rejects computing next snapshot from an existing prerelease", () => {
    expect(() => semver.nextSnapshot(semver.parse("1.2.3-SNAPSHOT"))).toThrow();
  });
});

describe("compare", () => {
  it("orders by major, minor, patch", () => {
    expect(semver.compare(semver.parse("1.2.3"), semver.parse("1.2.4"))).toBeLessThan(0);
    expect(semver.compare(semver.parse("1.2.3"), semver.parse("1.3.0"))).toBeLessThan(0);
    expect(semver.compare(semver.parse("1.2.3"), semver.parse("2.0.0"))).toBeLessThan(0);
  });

  it("sorts prerelease before release", () => {
    expect(semver.compare(semver.parse("1.2.3-SNAPSHOT"), semver.parse("1.2.3"))).toBeLessThan(0);
  });

  it("treats equal versions as equal", () => {
    expect(semver.compare(semver.parse("1.2.3"), semver.parse("1.2.3"))).toBe(0);
  });

  it("reports isPrerelease correctly", () => {
    expect(semver.isPrerelease(semver.parse("1.2.3-SNAPSHOT"))).toBe(true);
    expect(semver.isPrerelease(semver.parse("1.2.3"))).toBe(false);
  });
});

describe("classifyBump", () => {
  it("classifies a patch bump", () => {
    expect(semver.classifyBump(semver.parse("1.2.3"), semver.parse("1.2.4"))).toBe("patch");
  });

  it("classifies a minor bump", () => {
    expect(semver.classifyBump(semver.parse("1.2.3"), semver.parse("1.3.0"))).toBe("minor");
  });

  it("classifies a major bump", () => {
    expect(semver.classifyBump(semver.parse("1.2.3"), semver.parse("2.0.0"))).toBe("major");
  });

  it("rejects a non-increasing version", () => {
    expect(() => semver.classifyBump(semver.parse("1.2.3"), semver.parse("1.2.3"))).toThrow();
    expect(() => semver.classifyBump(semver.parse("1.2.4"), semver.parse("1.2.3"))).toThrow();
  });
});

describe("latestStableTag", () => {
  it("picks the highest stable tag", () => {
    const tags = ["v1.0.0", "v1.0.1", "v1.1.0", "v0.9.0"];
    expect(semver.latestStableTag(tags)).toBe("1.1.0");
  });

  it("ignores prerelease tags", () => {
    const tags = ["v1.0.0", "v1.1.0-rc.1"];
    expect(semver.latestStableTag(tags)).toBe("1.0.0");
  });

  it("ignores non-matching and blank entries", () => {
    const tags = ["", "  ", "snapshot", "std-v1.0.0", "v1.0.0"];
    expect(semver.latestStableTag(tags)).toBe("1.0.0");
  });

  it("returns null when no stable tag is found", () => {
    expect(semver.latestStableTag([])).toBeNull();
    expect(semver.latestStableTag(["v1.0.0-SNAPSHOT", "snapshot"])).toBeNull();
  });
});

describe("nextReleaseVersion", () => {
  it("bumps from the latest stable tag, not the pre-bumped snapshot file", () => {
    // Regression test: gradle.properties already reads '1.0.2-SNAPSHOT'
    // (the pending next release) after 'v1.0.1' was published. A patch
    // release-prepare run must compute '1.0.2', not double-bump to '1.0.3'.
    const result = semver.nextReleaseVersion({
      currentFileVersion: "1.0.2-SNAPSHOT",
      bumpKind: "patch",
      latestStableVersion: "1.0.1",
    });
    expect(result).toBe("1.0.2");
  });

  it("bumps minor and major from the latest stable tag", () => {
    expect(
      semver.nextReleaseVersion({ currentFileVersion: "1.0.2-SNAPSHOT", bumpKind: "minor", latestStableVersion: "1.0.1" })
    ).toBe("1.1.0");
    expect(
      semver.nextReleaseVersion({ currentFileVersion: "1.0.2-SNAPSHOT", bumpKind: "major", latestStableVersion: "1.0.1" })
    ).toBe("2.0.0");
  });

  it("uses the file version stripped of prerelease on the first-release edge case", () => {
    const result = semver.nextReleaseVersion({
      currentFileVersion: "0.1.0-SNAPSHOT",
      bumpKind: "patch",
      latestStableVersion: null,
    });
    expect(result).toBe("0.1.0");
  });
});
