import { describe, it, expect } from "vitest";
import * as dependencyPayload from "../src/dependency_payload.js";

const VALID_PAYLOAD = {
  component: "qilletni-core",
  version: "1.1.0",
  commit: "a".repeat(40),
  repository: "Qilletni/Qilletni",
  artifacts: [
    { coordinates: "dev.qilletni.impl:qilletni:1.1.0", sha256: "b".repeat(64) },
    { coordinates: "dev.qilletni.api:qilletni-api:1.1.0", sha256: "c".repeat(64) },
  ],
};

describe("buildPayload", () => {
  it("produces the expected shape", () => {
    const payload = dependencyPayload.buildPayload({
      component: "qilletni-core",
      version: "1.1.0",
      commit: "a".repeat(40),
      repository: "Qilletni/Qilletni",
      artifacts: [["dev.qilletni.impl:qilletni:1.1.0", "b".repeat(64)]],
    });
    expect(payload.component).toBe("qilletni-core");
    expect(payload.artifacts[0].coordinates).toBe("dev.qilletni.impl:qilletni:1.1.0");
    expect(dependencyPayload.validatePayload(payload)).toEqual([]);
  });
});

describe("validatePayload", () => {
  it("has no errors for a valid payload", () => {
    expect(dependencyPayload.validatePayload(VALID_PAYLOAD)).toEqual([]);
  });

  it("rejects a missing component", () => {
    const payload = { ...VALID_PAYLOAD } as any;
    delete payload.component;
    const errors = dependencyPayload.validatePayload(payload);
    expect(errors.some((e) => e.includes("component"))).toBe(true);
  });

  it("rejects a bad semver version", () => {
    const payload = { ...VALID_PAYLOAD, version: "not-a-version" };
    const errors = dependencyPayload.validatePayload(payload);
    expect(errors.some((e) => e.includes("version"))).toBe(true);
  });

  it("rejects a bad commit sha", () => {
    const payload = { ...VALID_PAYLOAD, commit: "short" };
    const errors = dependencyPayload.validatePayload(payload);
    expect(errors.some((e) => e.includes("commit"))).toBe(true);
  });

  it("rejects empty artifacts", () => {
    const payload = { ...VALID_PAYLOAD, artifacts: [] };
    const errors = dependencyPayload.validatePayload(payload);
    expect(errors.some((e) => e.includes("artifacts"))).toBe(true);
  });

  it("rejects a bad sha256 in an artifact", () => {
    const payload = { ...VALID_PAYLOAD, artifacts: [{ coordinates: "g:a:1.0.0", sha256: "nothex" }] };
    const errors = dependencyPayload.validatePayload(payload);
    expect(errors.some((e) => e.includes("sha256"))).toBe(true);
  });

  it("round-trips through JSON", () => {
    const text = dependencyPayload.toJson(VALID_PAYLOAD);
    const restored = dependencyPayload.fromJson(text);
    expect(restored).toEqual(VALID_PAYLOAD);
  });
});
