import { describe, it, expect } from "vitest";
import * as releaseMarker from "../src/release_marker.js";

describe("buildMarker", () => {
  it("round-trips through JSON", () => {
    const marker = releaseMarker.buildMarker({ component: "qilletni-core", fromVersion: "1.0.1", toVersion: "1.0.2", bump: "patch" });
    const text = releaseMarker.toJson(marker);
    expect(releaseMarker.fromJson(text)).toEqual(marker);
  });
});

describe("validateMarker", () => {
  it("has no errors for a valid marker", () => {
    const marker = releaseMarker.buildMarker({ component: "qilletni-core", fromVersion: "1.0.1", toVersion: "1.0.2", bump: "patch" });
    const errors = releaseMarker.validateMarker(marker, { expectedComponent: "qilletni-core", expectedVersion: "1.0.2" });
    expect(errors).toEqual([]);
  });

  it("rejects missing fields", () => {
    const errors = releaseMarker.validateMarker({}, { expectedComponent: "qilletni-core", expectedVersion: "1.0.2" });
    for (const field of releaseMarker.REQUIRED_FIELDS) {
      expect(errors.some((e) => e.includes(field)), `expected an error mentioning '${field}'`).toBe(true);
    }
  });

  it("rejects a component mismatch", () => {
    const marker = releaseMarker.buildMarker({ component: "qilletni-pkgutil", fromVersion: "1.0.1", toVersion: "1.0.2", bump: "patch" });
    const errors = releaseMarker.validateMarker(marker, { expectedComponent: "qilletni-core", expectedVersion: "1.0.2" });
    expect(errors.some((e) => e.toLowerCase().includes("component"))).toBe(true);
  });

  it("rejects a version mismatch", () => {
    const marker = releaseMarker.buildMarker({ component: "qilletni-core", fromVersion: "1.0.1", toVersion: "1.0.2", bump: "patch" });
    const errors = releaseMarker.validateMarker(marker, { expectedComponent: "qilletni-core", expectedVersion: "9.9.9" });
    expect(errors.some((e) => e.includes("to_version"))).toBe(true);
  });

  it("rejects an unknown bump kind", () => {
    const marker = releaseMarker.buildMarker({ component: "qilletni-core", fromVersion: "1.0.1", toVersion: "1.0.2", bump: "banana" });
    const errors = releaseMarker.validateMarker(marker, { expectedComponent: "qilletni-core", expectedVersion: "1.0.2" });
    expect(errors.some((e) => e.toLowerCase().includes("bump"))).toBe(true);
  });
});

describe("expectedBranchName", () => {
  it("builds the expected branch name", () => {
    expect(releaseMarker.expectedBranchName({ component: "qilletni-core", version: "1.0.2" })).toBe("release/qilletni-core-1.0.2");
  });
});

describe("validateMergeProvenance", () => {
  function pull(options: { headRef: string; labels: string[]; mergedAt?: string | null }) {
    return {
      head: { ref: options.headRef },
      labels: options.labels.map((name) => ({ name })),
      merged_at: options.mergedAt === undefined ? "2024-01-01T00:00:00Z" : options.mergedAt,
    };
  }

  it("accepts a matching merged release PR", () => {
    const pulls = [pull({ headRef: "release/qilletni-core-1.0.2", labels: ["release"] })];
    const errors = releaseMarker.validateMergeProvenance(pulls, { component: "qilletni-core", version: "1.0.2" });
    expect(errors).toEqual([]);
  });

  it("rejects when no pull matches", () => {
    const pulls = [pull({ headRef: "some-other-branch", labels: ["release"] })];
    const errors = releaseMarker.validateMergeProvenance(pulls, { component: "qilletni-core", version: "1.0.2" });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects a pull missing the release label", () => {
    const pulls = [pull({ headRef: "release/qilletni-core-1.0.2", labels: ["chore"] })];
    const errors = releaseMarker.validateMergeProvenance(pulls, { component: "qilletni-core", version: "1.0.2" });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects an unmerged pull", () => {
    const pulls = [pull({ headRef: "release/qilletni-core-1.0.2", labels: ["release"], mergedAt: null })];
    const errors = releaseMarker.validateMergeProvenance(pulls, { component: "qilletni-core", version: "1.0.2" });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects an empty pull list", () => {
    const errors = releaseMarker.validateMergeProvenance([], { component: "qilletni-core", version: "1.0.2" });
    expect(errors.length).toBeGreaterThan(0);
  });
});
