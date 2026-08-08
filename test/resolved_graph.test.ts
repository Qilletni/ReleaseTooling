import { describe, it, expect } from "vitest";
import * as resolvedGraph from "../src/resolved_graph.js";

const REPORT = `
> Task :dependencies

------------------------------------------------------------
Root project 'qilletni-toolchain'
------------------------------------------------------------

runtimeClasspath - Runtime classpath of source set 'main'.
+--- dev.qilletni.impl:qilletni:1.1.0
+--- dev.qilletni.api:qilletni-api:1.0.1 -> 1.1.0
\\--- org.apache.logging.log4j:log4j-api:2.25.1
`;

describe("parseResolvedVersions", () => {
  it("parses direct and conflict-resolved entries", () => {
    const resolved = resolvedGraph.parseResolvedVersions(REPORT);
    expect(resolved["dev.qilletni.impl:qilletni"]).toBe("1.1.0");
    expect(resolved["dev.qilletni.api:qilletni-api"]).toBe("1.1.0");
    expect(resolved["org.apache.logging.log4j:log4j-api"]).toBe("2.25.1");
  });

  it("ignores unrelated lines", () => {
    const resolved = resolvedGraph.parseResolvedVersions(REPORT);
    expect(resolved["Root project 'qilletni-toolchain'"]).toBeUndefined();
  });
});

describe("checkExpectedVersions", () => {
  it("passes when all expected versions are present", () => {
    const expected = {
      "dev.qilletni.impl:qilletni": "1.1.0",
      "dev.qilletni.api:qilletni-api": "1.1.0",
    };
    expect(resolvedGraph.checkExpectedVersions(REPORT, expected)).toEqual([]);
  });

  it("reports a missing coordinate", () => {
    const expected = { "com.example:missing": "1.0.0" };
    const errors = resolvedGraph.checkExpectedVersions(REPORT, expected);
    expect(errors.some((e) => e.includes("com.example:missing"))).toBe(true);
  });

  it("reports a divergent resolved version", () => {
    const expected = { "dev.qilletni.api:qilletni-api": "9.9.9" };
    const errors = resolvedGraph.checkExpectedVersions(REPORT, expected);
    expect(errors.some((e) => e.includes("9.9.9") && e.includes("1.1.0"))).toBe(true);
  });
});

describe("expectedVersionsFromPayload", () => {
  it("builds the expected map from payload artifacts", () => {
    const payload = {
      artifacts: [
        { coordinates: "dev.qilletni.impl:qilletni:1.1.0", sha256: "a".repeat(64) },
        { coordinates: "dev.qilletni.api:qilletni-api:1.1.0", sha256: "b".repeat(64) },
      ],
    };
    const expected = resolvedGraph.expectedVersionsFromPayload(payload);
    expect(expected).toEqual({
      "dev.qilletni.impl:qilletni": "1.1.0",
      "dev.qilletni.api:qilletni-api": "1.1.0",
    });
  });

  it("removes excluded coordinates", () => {
    const payload = {
      artifacts: [
        { coordinates: "dev.qilletni.impl:qilletni:1.1.0", sha256: "a".repeat(64) },
        { coordinates: "dev.qilletni.api:qilletni-api:1.1.0", sha256: "b".repeat(64) },
      ],
    };
    const expected = resolvedGraph.expectedVersionsFromPayload(payload, { excludeCoordinates: ["dev.qilletni.impl:qilletni"] });
    expect(expected).toEqual({ "dev.qilletni.api:qilletni-api": "1.1.0" });
  });
});
