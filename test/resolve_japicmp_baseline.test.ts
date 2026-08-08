import { describe, it, expect } from "vitest";
import { findBaselineAsset } from "../src/resolve_japicmp_baseline.js";

describe("findBaselineAsset", () => {
  it("returns null when there are no assets", () => {
    expect(findBaselineAsset([])).toBeNull();
  });

  it("returns null when no matching component is found", () => {
    expect(findBaselineAsset(["qilletni-1.0.1.tar.gz", "QilletniToolchain.jar"])).toBeNull();
  });

  it("returns the single match when no version is given", () => {
    expect(findBaselineAsset(["qilletni-1.0.1.tar.gz", "toolchain-logging-1.0.1.jar"])).toBe("toolchain-logging-1.0.1.jar");
  });

  it("matches an exact version", () => {
    const assets = ["toolchain-logging-1.0.0.jar", "toolchain-logging-1.0.1.jar"];
    expect(findBaselineAsset(assets, { version: "1.0.1" })).toBe("toolchain-logging-1.0.1.jar");
  });

  it("returns null when the exact version is not present", () => {
    const assets = ["toolchain-logging-1.0.0.jar"];
    expect(findBaselineAsset(assets, { version: "9.9.9" })).toBeNull();
  });

  it("returns null for an ambiguous match without a version - never guesses", () => {
    const assets = ["toolchain-logging-1.0.0.jar", "toolchain-logging-1.0.1.jar"];
    expect(findBaselineAsset(assets)).toBeNull();
  });

  it("respects a different component name", () => {
    const assets = ["qilletni-toolchain-1.0.1.jar"];
    expect(findBaselineAsset(assets, { component: "toolchain-logging" })).toBeNull();
    expect(findBaselineAsset(assets, { component: "qilletni-toolchain" })).toBe("qilletni-toolchain-1.0.1.jar");
  });
});
