import { describe, it, expect } from "vitest";
import * as platformCandidates from "../src/platform_candidates.js";
import * as platformManifest from "../src/platform_manifest.js";
import * as releaseEvent from "../src/release_event.js";

const VALID_YAML = `
schema_version: 1
components:
  toolchain:
    repository: Qilletni/QilletniToolchain
    version: 1.0.1
    tag: v1.0.1
    commit: f1a6b2e02d1f089745e1c4de923565a82dbd3112
    asset: qilletni-1.0.1.tar.gz
    sha256: 5bf7df3e8804e039b966e5f133324d849e242eac470a33574f54cb931b0c67a2
    embeds:
      core: 1.0.1
      api: 1.0.0
      pkgutil: 1.0.0
      docgen: 1.0.0
  qpm:
    repository: Qilletni/QPMCLI
    version: 1.0.0
    tag: v1.0.0
    commit: d50f8e50b826809b0943344441b749633e8e00f5
    asset: qpm-1.0.0.tar.gz
    sha256: 2613973691eb55be95254773621246771b82244454f43c7e8f2741440a7ca0ee
    embeds:
      api: 1.0.0
      pkgutil: 1.0.0
`;

function toolchainEvent(overrides: Record<string, unknown> = {}) {
  const event = releaseEvent.buildEvent({
    component: "toolchain",
    repository: "Qilletni/QilletniToolchain",
    version: "1.0.2",
    commit: "a".repeat(40),
    asset: "qilletni-1.0.2.tar.gz",
    sha256: "b".repeat(64),
    embeds: { core: "1.0.2", api: "1.0.1", pkgutil: "1.0.1", docgen: "1.0.1" },
  });
  return { ...event, ...overrides } as any;
}

describe("parseCandidates", () => {
  it("parses valid candidates", () => {
    const candidates = platformCandidates.parseCandidates(VALID_YAML);
    expect(candidates.components.toolchain.version).toBe("1.0.1");
  });
});

describe("validateCandidates", () => {
  it("has no errors for valid candidates", () => {
    const candidates = platformCandidates.parseCandidates(VALID_YAML);
    expect(platformCandidates.validateCandidates(candidates)).toEqual([]);
  });

  it("rejects a missing required component", () => {
    const candidates = platformCandidates.parseCandidates(VALID_YAML);
    delete candidates.components.qpm;
    const errors = platformCandidates.validateCandidates(candidates);
    expect(errors.some((e) => e.includes("qpm"))).toBe(true);
  });

  it("does not require platform_version", () => {
    const candidates = platformCandidates.parseCandidates(VALID_YAML);
    expect(candidates.platform_version).toBeUndefined();
    expect(platformCandidates.validateCandidates(candidates)).toEqual([]);
  });

  it("rejects a bad sha256", () => {
    const candidates = platformCandidates.parseCandidates(VALID_YAML);
    candidates.components.toolchain.sha256 = "tooshort";
    const errors = platformCandidates.validateCandidates(candidates);
    expect(errors.some((e) => e.includes("sha256"))).toBe(true);
  });
});

describe("updateCandidateComponent", () => {
  it("updates only the named component", () => {
    const candidates = platformCandidates.parseCandidates(VALID_YAML);
    const event = toolchainEvent();

    const updated = platformCandidates.updateCandidateComponent(candidates, event);

    expect(updated.components.toolchain.version).toBe("1.0.2");
    expect(updated.components.toolchain.commit).toBe("a".repeat(40));
    // qpm untouched
    expect(updated.components.qpm).toEqual(candidates.components.qpm);
  });

  it("does not mutate the original candidates", () => {
    const candidates = platformCandidates.parseCandidates(VALID_YAML);
    const originalToolchain = { ...candidates.components.toolchain };

    platformCandidates.updateCandidateComponent(candidates, toolchainEvent());

    expect(candidates.components.toolchain).toEqual(originalToolchain);
  });

  it("produces candidates that pass validation", () => {
    const candidates = platformCandidates.parseCandidates(VALID_YAML);
    const updated = platformCandidates.updateCandidateComponent(candidates, toolchainEvent());
    expect(platformCandidates.validateCandidates(updated)).toEqual([]);
  });

  it("rejects an invalid event", () => {
    const candidates = platformCandidates.parseCandidates(VALID_YAML);
    expect(() => platformCandidates.updateCandidateComponent(candidates, toolchainEvent({ sha256: "tooshort" }))).toThrow();
  });

  it("rejects a repository mismatch with the existing candidate", () => {
    const candidates = platformCandidates.parseCandidates(VALID_YAML);
    candidates.components.toolchain.repository = "Qilletni/SomeFork";
    expect(() => platformCandidates.updateCandidateComponent(candidates, toolchainEvent())).toThrow();
  });

  it("rejects a component not present in candidates", () => {
    const candidates = platformCandidates.parseCandidates(VALID_YAML);
    delete candidates.components.toolchain;
    expect(() => platformCandidates.updateCandidateComponent(candidates, toolchainEvent())).toThrow();
  });

  it("a qpm event only updates qpm", () => {
    const candidates = platformCandidates.parseCandidates(VALID_YAML);
    const event = releaseEvent.buildEvent({
      component: "qpm",
      repository: "Qilletni/QPMCLI",
      version: "1.0.1",
      commit: "c".repeat(40),
      asset: "qpm-1.0.1.tar.gz",
      sha256: "d".repeat(64),
      embeds: { api: "1.0.1", pkgutil: "1.0.1" },
    });

    const updated = platformCandidates.updateCandidateComponent(candidates, event);

    expect(updated.components.qpm.version).toBe("1.0.1");
    expect(updated.components.toolchain).toEqual(candidates.components.toolchain);
  });
});

describe("promoteToManifest", () => {
  it("promotes candidates into a valid manifest", () => {
    const candidates = platformCandidates.parseCandidates(VALID_YAML);
    const manifest = platformCandidates.promoteToManifest(candidates, "1.1.0");

    expect(manifest.platform_version).toBe("1.1.0");
    expect(manifest.components).toEqual(candidates.components);
    expect(platformManifest.validatePlatformManifest(manifest)).toEqual([]);
  });
});
