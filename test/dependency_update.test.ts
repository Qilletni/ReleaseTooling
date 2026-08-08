import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as dependencyUpdate from "../src/dependency_update.js";
import * as releaseConfig from "../src/release_config.js";

const CONFIG_YAML = `
schema_version: 1
repository: Qilletni/QilletniToolchain
components:
  - name: toolchain
    kind: cli
    version_file: gradle.properties
    version_key: toolchainVersion
    changelog: CHANGELOG.md
dependencies:
  - upstream_component: qilletni-core
    repository: Qilletni/Qilletni
    coordinates:
      - dev.qilletni.impl:qilletni
      - dev.qilletni.api:qilletni-api
    version_file: gradle.properties
    version_key: qilletniCoreVersion
`;

function payload(overrides: Record<string, unknown> = {}) {
  return {
    component: "qilletni-core",
    version: "1.1.0",
    commit: "a".repeat(40),
    repository: "Qilletni/Qilletni",
    artifacts: [
      { coordinates: "dev.qilletni.impl:qilletni:1.1.0", sha256: "b".repeat(64) },
      { coordinates: "dev.qilletni.api:qilletni-api:1.1.0", sha256: "c".repeat(64) },
    ],
    ...overrides,
  } as any;
}

describe("findDependency", () => {
  it("finds a configured dependency", () => {
    const config = releaseConfig.parseReleaseConfig(CONFIG_YAML);
    const dependency = dependencyUpdate.findDependency(config, "qilletni-core");
    expect(dependency).not.toBeNull();
    expect(dependency!.version_key).toBe("qilletniCoreVersion");
  });

  it("returns null for an unconfigured component", () => {
    const config = releaseConfig.parseReleaseConfig(CONFIG_YAML);
    expect(dependencyUpdate.findDependency(config, "not-configured")).toBeNull();
  });
});

describe("validatePayloadAgainstConfig", () => {
  let config: any;
  beforeEach(() => {
    config = releaseConfig.parseReleaseConfig(CONFIG_YAML);
  });

  it("has no errors for a valid payload", () => {
    expect(dependencyUpdate.validatePayloadAgainstConfig(payload(), config)).toEqual([]);
  });

  it("rejects an unconfigured component", () => {
    const errors = dependencyUpdate.validatePayloadAgainstConfig(payload({ component: "not-configured" }), config);
    expect(errors.some((e) => e.includes("not-configured"))).toBe(true);
  });

  it("rejects a spoofed repository", () => {
    const errors = dependencyUpdate.validatePayloadAgainstConfig(payload({ repository: "Qilletni/SomeoneElse" }), config);
    expect(errors.some((e) => e.includes("repository"))).toBe(true);
  });

  it("rejects a missing coordinate", () => {
    const p = payload();
    p.artifacts = [p.artifacts[0]];
    const errors = dependencyUpdate.validatePayloadAgainstConfig(p, config);
    expect(errors.some((e) => e.toLowerCase().includes("missing") && e.includes("qilletni-api"))).toBe(true);
  });

  it("rejects an extra coordinate", () => {
    const p = payload();
    p.artifacts.push({ coordinates: "com.example:extra:1.1.0", sha256: "d".repeat(64) });
    const errors = dependencyUpdate.validatePayloadAgainstConfig(p, config);
    expect(errors.some((e) => e.includes("com.example:extra"))).toBe(true);
  });

  it("rejects a divergent version at the same key", () => {
    const p = payload();
    p.artifacts[1].coordinates = "dev.qilletni.api:qilletni-api:1.1.1";
    const errors = dependencyUpdate.validatePayloadAgainstConfig(p, config);
    expect(errors.some((e) => e.includes("1.1.1"))).toBe(true);
  });

  it("rejects a dynamic snapshot version", () => {
    const p = payload({ version: "1.1.0-SNAPSHOT" });
    p.artifacts[0].coordinates = "dev.qilletni.impl:qilletni:1.1.0-SNAPSHOT";
    p.artifacts[1].coordinates = "dev.qilletni.api:qilletni-api:1.1.0-SNAPSHOT";
    const errors = dependencyUpdate.validatePayloadAgainstConfig(p, config);
    expect(errors.some((e) => e.toLowerCase().includes("snapshot"))).toBe(true);
  });

  it("rejects a malformed payload schema before the config lookup", () => {
    const p = payload();
    delete p.commit;
    const errors = dependencyUpdate.validatePayloadAgainstConfig(p, config);
    expect(errors.some((e) => e.includes("commit"))).toBe(true);
  });
});

describe("planMetadataUpdates / applyMetadataUpdates", () => {
  it("targets only the configured file and key", () => {
    const config = releaseConfig.parseReleaseConfig(CONFIG_YAML);
    const dependency = dependencyUpdate.findDependency(config, "qilletni-core")!;
    const plan = dependencyUpdate.planMetadataUpdates(dependency, payload());
    expect(plan).toEqual([["gradle.properties", "qilletniCoreVersion", "1.1.0"]]);
  });

  it("writes the file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-tools-"));
    const path = join(tmp, "gradle.properties");
    writeFileSync(path, "qilletniCoreVersion=1.0.0\n");

    const changed = dependencyUpdate.applyMetadataUpdates([["gradle.properties", "qilletniCoreVersion", "1.1.0"]], { baseDir: tmp });
    expect(changed).toEqual([path]);
    expect(readFileSync(path, "utf-8")).toContain("qilletniCoreVersion=1.1.0");
  });

  it("is idempotent", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-tools-"));
    const path = join(tmp, "gradle.properties");
    writeFileSync(path, "qilletniCoreVersion=1.1.0\n");

    const changed = dependencyUpdate.applyMetadataUpdates([["gradle.properties", "qilletniCoreVersion", "1.1.0"]], { baseDir: tmp });
    expect(changed).toEqual([]);
    expect(readFileSync(path, "utf-8")).toContain("qilletniCoreVersion=1.1.0");
  });
});

describe("verifyPayloadArtifactsAvailable", () => {
  it("passes when all artifacts match hash", async () => {
    const p = payload();
    const dataByCoord: Record<string, Buffer> = {
      "dev.qilletni.impl:qilletni:1.1.0": Buffer.from("core jar bytes"),
      "dev.qilletni.api:qilletni-api:1.1.0": Buffer.from("api jar bytes"),
    };
    for (const artifact of p.artifacts) {
      artifact.sha256 = createHash("sha256").update(dataByCoord[artifact.coordinates]).digest("hex");
    }

    async function* toAsyncIterable(data: Buffer) {
      yield data;
    }

    const opener = async (url: string) => {
      for (const [coord, data] of Object.entries(dataByCoord)) {
        const [, artifactId, version] = coord.split(":");
        if (url.includes(`${artifactId}-${version}.jar`)) return toAsyncIterable(data);
      }
      throw new Error(`unexpected url ${url}`);
    };

    const errors = await dependencyUpdate.verifyPayloadArtifactsAvailable(p, { opener });
    expect(errors).toEqual([]);
  });

  it("reports a hash mismatch", async () => {
    const p = payload();
    async function* toAsyncIterable(data: Buffer) {
      yield data;
    }
    const opener = async () => toAsyncIterable(Buffer.from("wrong content"));

    const errors = await dependencyUpdate.verifyPayloadArtifactsAvailable(p, { opener });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("reports a malformed coordinate", async () => {
    const p = payload();
    p.artifacts[0].coordinates = "not-a-full-gav";
    const opener = async () => {
      throw new Error("should not be called");
    };

    const errors = await dependencyUpdate.verifyPayloadArtifactsAvailable(p, { opener });
    expect(errors.some((e) => e.includes("not-a-full-gav"))).toBe(true);
  });
});

const CONFIG_YAML_WITH_UNRESOLVED_COORDINATE = `
schema_version: 1
repository: Qilletni/QPMCLI
components:
  - name: qpm
    kind: cli
    version_file: gradle.properties
    version_key: qpmVersion
    changelog: CHANGELOG.md
dependencies:
  - upstream_component: qilletni-core
    repository: Qilletni/Qilletni
    coordinates:
      - dev.qilletni.api:qilletni-api
      - coordinate: dev.qilletni.impl:qilletni
        resolved: false
    version_file: gradle.properties
    version_key: qilletniCoreVersion
`;

describe("resolved and unresolved coordinates", () => {
  let config: any;
  let dependency: any;
  beforeEach(() => {
    config = releaseConfig.parseReleaseConfig(CONFIG_YAML_WITH_UNRESOLVED_COORDINATE);
    dependency = dependencyUpdate.findDependency(config, "qilletni-core");
  });

  it("resolvedCoordinates excludes the flagged entry", () => {
    expect(dependencyUpdate.resolvedCoordinates(dependency)).toEqual(new Set(["dev.qilletni.api:qilletni-api"]));
  });

  it("unresolvedCoordinates returns the flagged entry", () => {
    expect(dependencyUpdate.unresolvedCoordinates(dependency)).toEqual(new Set(["dev.qilletni.impl:qilletni"]));
  });

  it("the payload must still contain the unresolved coordinate", () => {
    // A 'resolved: false' coordinate stays mandatory and hash-verified -
    // only excluded from the resolved-dependency-graph presence check.
    const p = payload();
    p.artifacts = [p.artifacts[1]]; // drop the unresolved one
    const errors = dependencyUpdate.validatePayloadAgainstConfig(p, config);
    expect(errors.some((e) => e.toLowerCase().includes("missing") && e.includes("dev.qilletni.impl:qilletni"))).toBe(true);
  });

  it("a valid full payload has no errors", () => {
    expect(dependencyUpdate.validatePayloadAgainstConfig(payload(), config)).toEqual([]);
  });
});
