import { describe, it, expect } from "vitest";
import * as releaseEvent from "../src/release_event.js";

function validToolchainEvent(overrides: Record<string, unknown> = {}) {
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

describe("buildEvent", () => {
  it("builds the expected shape", () => {
    const event = validToolchainEvent();
    expect(event.schema_version).toBe(1);
    expect(event.tag).toBe("v1.0.2");
    expect(event.component).toBe("toolchain");
  });
});

describe("validateEvent", () => {
  it("has no errors for a valid toolchain event", () => {
    expect(releaseEvent.validateEvent(validToolchainEvent())).toEqual([]);
  });

  it("has no errors for a valid qpm event", () => {
    const event = releaseEvent.buildEvent({
      component: "qpm",
      repository: "Qilletni/QPMCLI",
      version: "1.0.1",
      commit: "c".repeat(40),
      asset: "qpm-1.0.1.tar.gz",
      sha256: "d".repeat(64),
      embeds: { api: "1.0.1", pkgutil: "1.0.1" },
    });
    expect(releaseEvent.validateEvent(event)).toEqual([]);
  });

  it("rejects the wrong schema version", () => {
    const event = validToolchainEvent({ schema_version: 2 });
    const errors = releaseEvent.validateEvent(event);
    expect(errors.some((e) => e.includes("schema_version"))).toBe(true);
  });

  it("rejects an unknown component", () => {
    const event = validToolchainEvent({ component: "pkgutil" });
    const errors = releaseEvent.validateEvent(event);
    expect(errors.some((e) => e.includes("component"))).toBe(true);
  });

  it("rejects a repository/component mismatch", () => {
    const event = validToolchainEvent({ repository: "Qilletni/QPMCLI" });
    const errors = releaseEvent.validateEvent(event);
    expect(errors.some((e) => e.includes("repository"))).toBe(true);
  });

  it("rejects a qpm component with a toolchain repository", () => {
    const event = releaseEvent.buildEvent({
      component: "qpm",
      repository: "Qilletni/QilletniToolchain",
      version: "1.0.1",
      commit: "c".repeat(40),
      asset: "qpm-1.0.1.tar.gz",
      sha256: "d".repeat(64),
      embeds: { api: "1.0.1", pkgutil: "1.0.1" },
    });
    const errors = releaseEvent.validateEvent(event);
    expect(errors.some((e) => e.includes("repository"))).toBe(true);
  });

  it("rejects an invalid version", () => {
    const event = validToolchainEvent({ version: "not-a-version" });
    const errors = releaseEvent.validateEvent(event);
    expect(errors.some((e) => e.includes("version"))).toBe(true);
  });

  it("rejects a tag not matching version", () => {
    const event = validToolchainEvent({ tag: "v9.9.9" });
    const errors = releaseEvent.validateEvent(event);
    expect(errors.some((e) => e.includes("tag"))).toBe(true);
  });

  it("rejects a malformed commit", () => {
    const event = validToolchainEvent({ commit: "not-a-sha" });
    const errors = releaseEvent.validateEvent(event);
    expect(errors.some((e) => e.includes("commit"))).toBe(true);
  });

  it("rejects a missing asset", () => {
    const event = validToolchainEvent({ asset: "" });
    const errors = releaseEvent.validateEvent(event);
    expect(errors.some((e) => e.includes("asset"))).toBe(true);
  });

  it("rejects asset path traversal", () => {
    const event = validToolchainEvent({ asset: "../../etc/passwd" });
    const errors = releaseEvent.validateEvent(event);
    expect(errors.some((e) => e.includes("asset"))).toBe(true);
  });

  it("rejects an asset with a path separator", () => {
    const event = validToolchainEvent({ asset: "sub/dir/qilletni-1.0.2.tar.gz" });
    const errors = releaseEvent.validateEvent(event);
    expect(errors.some((e) => e.includes("asset"))).toBe(true);
  });

  it("rejects an asset with shell metacharacters", () => {
    const event = validToolchainEvent({ asset: "qilletni-1.0.2.tar.gz; rm -rf /" });
    const errors = releaseEvent.validateEvent(event);
    expect(errors.some((e) => e.includes("asset"))).toBe(true);
  });

  it("rejects a malformed sha256", () => {
    const event = validToolchainEvent({ sha256: "tooshort" });
    const errors = releaseEvent.validateEvent(event);
    expect(errors.some((e) => e.includes("sha256"))).toBe(true);
  });

  it("rejects a missing required embed", () => {
    const event = validToolchainEvent();
    delete event.embeds.docgen;
    const errors = releaseEvent.validateEvent(event);
    expect(errors.some((e) => e.includes("docgen"))).toBe(true);
  });

  it("requires embed versions to be valid semver", () => {
    const event = validToolchainEvent();
    event.embeds.core = "not-a-version";
    const errors = releaseEvent.validateEvent(event);
    expect(errors.some((e) => e.includes("core"))).toBe(true);
  });
});

describe("verifyLiveProvenance", () => {
  it("has no errors when tag and asset match live data", async () => {
    const event = validToolchainEvent();

    const errors = await releaseEvent.verifyLiveProvenance(event, {
      fetchTagRef: async () => ({ object: { type: "commit", sha: event.commit } }),
      fetchTagObject: async () => ({}),
      fetchRelease: async () => ({ assets: [{ name: event.asset, digest: `sha256:${event.sha256}` }] }),
    });
    expect(errors).toEqual([]);
  });

  it("reports an error when the tag dereferences elsewhere", async () => {
    const event = validToolchainEvent();

    const errors = await releaseEvent.verifyLiveProvenance(event, {
      fetchTagRef: async () => ({ object: { type: "commit", sha: "f".repeat(40) } }),
      fetchTagObject: async () => ({}),
      fetchRelease: async () => ({ assets: [{ name: event.asset, digest: `sha256:${event.sha256}` }] }),
    });
    expect(errors.some((e) => e.includes("commit"))).toBe(true);
  });

  it("reports an error on sha256 mismatch", async () => {
    const event = validToolchainEvent();

    const errors = await releaseEvent.verifyLiveProvenance(event, {
      fetchTagRef: async () => ({ object: { type: "commit", sha: event.commit } }),
      fetchTagObject: async () => ({}),
      fetchRelease: async () => ({ assets: [{ name: event.asset, digest: "sha256:" + "f".repeat(64) }] }),
    });
    expect(errors.some((e) => e.includes("sha256"))).toBe(true);
  });

  it("rejects an invalid event before making any network calls", async () => {
    const event = validToolchainEvent({ sha256: "tooshort" });
    const calls: string[] = [];

    const errors = await releaseEvent.verifyLiveProvenance(event, {
      fetchTagRef: async () => {
        calls.push("tag_ref");
        return { object: { type: "commit", sha: event.commit } };
      },
      fetchTagObject: async () => ({}),
      fetchRelease: async () => ({ assets: [] }),
    });
    expect(errors.some((e) => e.includes("sha256"))).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("JSON round trip", () => {
  it("round-trips through JSON", () => {
    const event = validToolchainEvent();
    const restored = releaseEvent.fromJson(releaseEvent.toJson(event));
    expect(restored).toEqual(event);
  });

  it("produces valid JSON", () => {
    const event = validToolchainEvent();
    expect(() => JSON.parse(releaseEvent.toJson(event))).not.toThrow();
  });
});
