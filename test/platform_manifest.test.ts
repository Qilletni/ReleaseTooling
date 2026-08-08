import { describe, it, expect } from "vitest";
import * as platformManifest from "../src/platform_manifest.js";

const VALID_YAML = `
schema_version: 1
platform_version: 1.0.0
legacy_verification: true
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

function manifest() {
  return platformManifest.parsePlatformManifest(VALID_YAML);
}

describe("parsePlatformManifest", () => {
  it("parses a valid manifest", () => {
    const m = manifest();
    expect(m.platform_version).toBe("1.0.0");
    expect(m.components.toolchain.asset).toBe("qilletni-1.0.1.tar.gz");
    expect(m.components.toolchain.embeds.core).toBe("1.0.1");
  });
});

describe("validatePlatformManifest", () => {
  it("has no errors for a valid manifest", () => {
    expect(platformManifest.validatePlatformManifest(manifest())).toEqual([]);
  });

  it("rejects a missing required component", () => {
    const m = manifest();
    delete m.components.qpm;
    const errors = platformManifest.validatePlatformManifest(m);
    expect(errors.some((e) => e.includes("qpm"))).toBe(true);
  });

  it("rejects a bad sha256", () => {
    const m = manifest();
    m.components.toolchain.sha256 = "tooshort";
    const errors = platformManifest.validatePlatformManifest(m);
    expect(errors.some((e) => e.includes("sha256"))).toBe(true);
  });

  it("requires platform_version to be semver", () => {
    const m = manifest();
    m.platform_version = "latest";
    const errors = platformManifest.validatePlatformManifest(m);
    expect(errors.some((e) => e.includes("platform_version"))).toBe(true);
  });

  it("requires tag to reference version", () => {
    const m = manifest();
    m.components.toolchain.tag = "v9.9.9";
    const errors = platformManifest.validatePlatformManifest(m);
    expect(errors.some((e) => e.includes("tag"))).toBe(true);
  });

  it("requires the manifest filename to match platform_version", () => {
    expect(platformManifest.validateManifestFilename("release/platform/1.0.0.yml", "1.0.0")).toEqual([]);
    expect(platformManifest.validateManifestFilename("release/platform/1.0.0.yml", "1.1.0")).not.toEqual([]);
  });

  it("rejects a missing commit", () => {
    const m = manifest();
    delete m.components.toolchain.commit;
    const errors = platformManifest.validatePlatformManifest(m);
    expect(errors.some((e) => e.includes("commit"))).toBe(true);
  });

  it("rejects a malformed commit", () => {
    const m = manifest();
    m.components.toolchain.commit = "not-a-sha";
    const errors = platformManifest.validatePlatformManifest(m);
    expect(errors.some((e) => e.includes("commit"))).toBe(true);
  });

  it("rejects missing embeds", () => {
    const m = manifest();
    delete m.components.toolchain.embeds;
    const errors = platformManifest.validatePlatformManifest(m);
    expect(errors.some((e) => e.includes("embeds"))).toBe(true);
  });

  it("rejects toolchain missing a required embed", () => {
    const m = manifest();
    delete m.components.toolchain.embeds.docgen;
    const errors = platformManifest.validatePlatformManifest(m);
    expect(errors.some((e) => e.includes("docgen"))).toBe(true);
  });

  it("rejects qpm missing a required embed", () => {
    const m = manifest();
    delete m.components.qpm.embeds.pkgutil;
    const errors = platformManifest.validatePlatformManifest(m);
    expect(errors.some((e) => e.includes("pkgutil"))).toBe(true);
  });

  it("requires embed versions to be semver", () => {
    const m = manifest();
    m.components.toolchain.embeds.core = "not-a-version";
    const errors = platformManifest.validatePlatformManifest(m);
    expect(errors.some((e) => e.includes("core"))).toBe(true);
  });

  it("treats component_manifest as optional", () => {
    expect(platformManifest.validatePlatformManifest(manifest())).toEqual([]);
  });

  it("rejects component_manifest missing asset", () => {
    const m = manifest();
    m.components.toolchain.component_manifest = {};
    const errors = platformManifest.validatePlatformManifest(m);
    expect(errors.some((e) => e.includes("component_manifest"))).toBe(true);
  });

  it("accepts component_manifest with an asset", () => {
    const m = manifest();
    m.components.toolchain.component_manifest = { asset: "qilletni-1.0.1-manifest.json" };
    expect(platformManifest.validatePlatformManifest(m)).toEqual([]);
  });
});

describe("validateComponentManifestContent", () => {
  it("has no errors when version and commit match", () => {
    const component = { version: "1.0.1", commit: "f1a6b2e02d1f089745e1c4de923565a82dbd3112" };
    const content = { version: "1.0.1", commit: "f1a6b2e02d1f089745e1c4de923565a82dbd3112" };
    expect(platformManifest.validateComponentManifestContent(component, content)).toEqual([]);
  });

  it("reports an error on version mismatch", () => {
    const component = { version: "1.0.1", commit: "f1a6b2e02d1f089745e1c4de923565a82dbd3112" };
    const content = { version: "9.9.9", commit: "f1a6b2e02d1f089745e1c4de923565a82dbd3112" };
    const errors = platformManifest.validateComponentManifestContent(component, content);
    expect(errors.some((e) => e.includes("version"))).toBe(true);
  });

  it("reports an error on commit mismatch", () => {
    const component = { version: "1.0.1", commit: "f1a6b2e02d1f089745e1c4de923565a82dbd3112" };
    const content = { version: "1.0.1", commit: "0".repeat(40) };
    const errors = platformManifest.validateComponentManifestContent(component, content);
    expect(errors.some((e) => e.includes("commit"))).toBe(true);
  });

  it("compares version as string regardless of YAML numeric parsing", () => {
    // Guards against a YAML-parsed numeric scalar (e.g. an unquoted decimal
    // version fragment) failing to compare equal to its string counterpart.
    // Uses 1.5 rather than a trailing-zero value like 1.0, since `String(1.0)`
    // collapses to "1", which wouldn't exercise the intended string-vs-number
    // compare.
    const component = { version: "1.5", commit: "f1a6b2e02d1f089745e1c4de923565a82dbd3112" };
    const content = { version: 1.5, commit: "f1a6b2e02d1f089745e1c4de923565a82dbd3112" };
    expect(platformManifest.validateComponentManifestContent(component, content)).toEqual([]);
  });
});

describe("verifyComponentCommits", () => {
  it("has no errors when every tag dereferences to its declared commit", async () => {
    const m = manifest();
    const errors = await platformManifest.verifyComponentCommits(m, {
      fetchTagRef: async (repository, tag) => {
        for (const component of Object.values(m.components) as any[]) {
          if (component.repository === repository && component.tag === tag) {
            return { object: { type: "commit", sha: component.commit } };
          }
        }
        throw new Error(`unexpected repository/tag: ${repository} ${tag}`);
      },
      fetchTagObject: async () => ({}),
    });
    expect(errors).toEqual([]);
  });

  it("reports an error when a tag dereferences to a different commit", async () => {
    const m = manifest();
    const errors = await platformManifest.verifyComponentCommits(m, {
      fetchTagRef: async () => ({ object: { type: "commit", sha: "f".repeat(40) } }),
      fetchTagObject: async () => ({}),
    });
    expect(errors.some((e) => e.includes("toolchain"))).toBe(true);
    expect(errors.some((e) => e.includes("qpm"))).toBe(true);
  });

  it("dereferences annotated tags via fetchTagObject", async () => {
    const m = manifest();
    const errors = await platformManifest.verifyComponentCommits(m, {
      fetchTagRef: async () => ({ object: { type: "tag", sha: "e".repeat(40) } }),
      fetchTagObject: async (repository) => {
        for (const component of Object.values(m.components) as any[]) {
          if (component.repository === repository) {
            return { object: { type: "commit", sha: component.commit } };
          }
        }
        throw new Error(`unexpected repository: ${repository}`);
      },
    });
    expect(errors).toEqual([]);
  });
});

describe("latestPlatformVersion", () => {
  it("returns the highest manifest version", () => {
    expect(platformManifest.latestPlatformVersion(["1.0.0.yml", "1.2.0.yml", "1.1.0.yml"])).toBe("1.2.0");
  });

  it("ignores non-manifest files", () => {
    expect(platformManifest.latestPlatformVersion(["candidates.yml", "1.0.0.yml", "README.md"])).toBe("1.0.0");
  });

  it("returns null when no manifest exists yet", () => {
    expect(platformManifest.latestPlatformVersion(["candidates.yml"])).toBeNull();
  });

  it("handles full paths", () => {
    expect(platformManifest.latestPlatformVersion(["release/platform/1.0.0.yml", "release/platform/2.0.0.yml"])).toBe("2.0.0");
  });
});

describe("verifyLiveAssetProvenance", () => {
  it("has no errors when sha256 matches the live release", async () => {
    const m = manifest();
    const errors = await platformManifest.verifyLiveAssetProvenance(m, {
      fetchRelease: async (repository, tag) => {
        for (const component of Object.values(m.components) as any[]) {
          if (component.repository === repository && component.tag === tag) {
            return { assets: [{ name: component.asset, digest: `sha256:${component.sha256}` }] };
          }
        }
        throw new Error(`unexpected repository/tag: ${repository} ${tag}`);
      },
    });
    expect(errors).toEqual([]);
  });

  it("reports an error on sha256 mismatch", async () => {
    const m = manifest();
    const errors = await platformManifest.verifyLiveAssetProvenance(m, {
      fetchRelease: async (repository, tag) => {
        for (const component of Object.values(m.components) as any[]) {
          if (component.repository === repository && component.tag === tag) {
            return { assets: [{ name: component.asset, digest: "sha256:" + "f".repeat(64) }] };
          }
        }
        throw new Error(`unexpected repository/tag: ${repository} ${tag}`);
      },
    });
    expect(errors.some((e) => e.includes("sha256"))).toBe(true);
  });

  it("reports an error when the asset is missing from the live release", async () => {
    const m = manifest();
    const errors = await platformManifest.verifyLiveAssetProvenance(m, {
      fetchRelease: async () => ({ assets: [] }),
    });
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});
