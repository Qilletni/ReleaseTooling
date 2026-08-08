import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as releaseConfig from "../src/release_config.js";

const VALID_YAML = `
schema_version: 1
repository: Qilletni/Qilletni
components:
  - name: qilletni-core
    kind: maven
    version_file: gradle.properties
    version_key: qilletniVersion
    changelog: CHANGELOG.md
    registry_component: qilletni-core
    artifacts:
      - maven:
          group: dev.qilletni.impl
          artifact: qilletni
        japicmp:
          enabled: true
          report: build/reports/japicmp/qilletni-core.xml
      - maven:
          group: dev.qilletni.api
          artifact: qilletni-api
        japicmp:
          enabled: true
          report: qilletni-api/build/reports/japicmp/qilletni-api.xml
  - name: qilletni-docs
    kind: docs
    version_file: mkdocs.yml
    version_key: version
    changelog: CHANGELOG.md
`;

describe("loadReleaseConfig / parseReleaseConfig", () => {
  it("parses a valid config", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML);
    expect(config.repository).toBe("Qilletni/Qilletni");
    expect(config.components.length).toBe(2);
  });

  it("loads from a file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-tools-"));
    const path = join(tmp, "release.yml");
    writeFileSync(path, VALID_YAML);
    const config = releaseConfig.loadReleaseConfig(path);
    expect(config.repository).toBe("Qilletni/Qilletni");
  });
});

describe("validateReleaseConfig", () => {
  it("has no errors for a valid config", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML);
    expect(releaseConfig.validateReleaseConfig(config)).toEqual([]);
  });

  it("rejects a missing schema_version", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML);
    delete config.schema_version;
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("schema_version"))).toBe(true);
  });

  it("rejects an unsupported schema_version", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML);
    config.schema_version = 99;
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("schema_version"))).toBe(true);
  });

  it("rejects a missing repository", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML);
    delete config.repository;
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("repository"))).toBe(true);
  });

  it("rejects empty components", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML);
    config.components = [];
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("components"))).toBe(true);
  });

  it("rejects a component missing a name", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML);
    delete config.components[0].name;
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("rejects a maven component missing artifacts", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML);
    delete config.components[0].artifacts;
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("artifacts"))).toBe(true);
  });

  it("rejects a maven component with empty artifacts", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML);
    config.components[0].artifacts = [];
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("artifacts"))).toBe(true);
  });

  it("rejects an artifact missing maven.group", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML);
    delete config.components[0].artifacts[0].maven.group;
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("group"))).toBe(true);
  });

  it("rejects an artifact missing maven.artifact", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML);
    delete config.components[0].artifacts[1].maven.artifact;
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("artifact"))).toBe(true);
  });

  it("rejects duplicate component names", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML);
    config.components[1].name = config.components[0].name;
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.toLowerCase().includes("duplicate"))).toBe(true);
  });

  it("rejects an invalid kind", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML);
    config.components[0].kind = "banana";
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("kind"))).toBe(true);
  });

  it("rejects an invalid japicmp policy", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML);
    config.components[0].artifacts[0].japicmp.policy = "banana";
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("japicmp"))).toBe(true);
  });

  it("treats no dependencies as valid", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML);
    expect(config.dependencies).toBeUndefined();
    expect(releaseConfig.validateReleaseConfig(config)).toEqual([]);
  });
});

const VALID_YAML_WITH_DEPENDENCIES =
  VALID_YAML +
  `
dependencies:
  - upstream_component: qilletni-core
    repository: Qilletni/Qilletni
    coordinates:
      - dev.qilletni.impl:qilletni
      - dev.qilletni.api:qilletni-api
    version_file: gradle.properties
    version_key: qilletniCoreVersion
`;

describe("validateReleaseConfig with dependencies", () => {
  it("has no errors for valid dependencies", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML_WITH_DEPENDENCIES);
    expect(releaseConfig.validateReleaseConfig(config)).toEqual([]);
  });

  it("rejects a dependency missing upstream_component", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML_WITH_DEPENDENCIES);
    delete config.dependencies[0].upstream_component;
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("upstream_component"))).toBe(true);
  });

  it("rejects a dependency missing repository", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML_WITH_DEPENDENCIES);
    delete config.dependencies[0].repository;
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("repository"))).toBe(true);
  });

  it("rejects a dependency missing coordinates", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML_WITH_DEPENDENCIES);
    delete config.dependencies[0].coordinates;
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("coordinates"))).toBe(true);
  });

  it("rejects a dependency with empty coordinates", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML_WITH_DEPENDENCIES);
    config.dependencies[0].coordinates = [];
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("coordinates"))).toBe(true);
  });

  it("rejects a malformed coordinate", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML_WITH_DEPENDENCIES);
    config.dependencies[0].coordinates.push("not-a-coordinate");
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("not-a-coordinate"))).toBe(true);
  });

  it("rejects a coordinate with a version segment", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML_WITH_DEPENDENCIES);
    config.dependencies[0].coordinates.push("dev.qilletni.impl:qilletni:1.0.0");
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("dev.qilletni.impl:qilletni:1.0.0"))).toBe(true);
  });

  it("rejects a dependency missing version_file", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML_WITH_DEPENDENCIES);
    delete config.dependencies[0].version_file;
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("version_file"))).toBe(true);
  });

  it("rejects a dependency missing version_key", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML_WITH_DEPENDENCIES);
    delete config.dependencies[0].version_key;
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("version_key"))).toBe(true);
  });

  it("rejects version_file path traversal", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML_WITH_DEPENDENCIES);
    config.dependencies[0].version_file = "../../etc/passwd";
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("version_file"))).toBe(true);
  });

  it("rejects an absolute version_file path", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML_WITH_DEPENDENCIES);
    config.dependencies[0].version_file = "/etc/passwd";
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("version_file"))).toBe(true);
  });

  it("rejects a duplicate upstream_component", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML_WITH_DEPENDENCIES);
    config.dependencies.push({ ...config.dependencies[0] });
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.toLowerCase().includes("duplicate"))).toBe(true);
  });

  it("rejects a duplicate coordinate across dependencies", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML_WITH_DEPENDENCIES);
    config.dependencies.push({
      upstream_component: "other-component",
      repository: "Qilletni/Other",
      coordinates: ["dev.qilletni.impl:qilletni"],
      version_file: "other.properties",
      version_key: "otherVersion",
    });
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.toLowerCase().includes("duplicate"))).toBe(true);
  });
});

const VALID_YAML_WITH_UNRESOLVED_COORDINATE =
  VALID_YAML +
  `
dependencies:
  - upstream_component: qilletni-core
    repository: Qilletni/Qilletni
    coordinates:
      - dev.qilletni.impl:qilletni
      - coordinate: dev.qilletni.api:qilletni-api
        resolved: false
    version_file: gradle.properties
    version_key: qilletniCoreVersion
`;

describe("resolved flag on dependency coordinates", () => {
  it("allows a mix of resolved and unresolved coordinates", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML_WITH_UNRESOLVED_COORDINATE);
    expect(releaseConfig.validateReleaseConfig(config)).toEqual([]);
  });

  it("normalizedCoordinates returns coordinate and resolved flag", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML_WITH_UNRESOLVED_COORDINATE);
    const normalized = releaseConfig.normalizedCoordinates(config.dependencies[0]);
    expect(normalized).toEqual([
      { coordinate: "dev.qilletni.impl:qilletni", resolved: true },
      { coordinate: "dev.qilletni.api:qilletni-api", resolved: false },
    ]);
  });

  it("defaults plain string coordinates to resolved: true", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML_WITH_DEPENDENCIES);
    const normalized = releaseConfig.normalizedCoordinates(config.dependencies[0]);
    expect(normalized.every((entry) => entry.resolved)).toBe(true);
  });

  it("rejects an invalid resolved type", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML_WITH_UNRESOLVED_COORDINATE);
    config.dependencies[0].coordinates[1].resolved = "no";
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("resolved"))).toBe(true);
  });

  it("rejects a coordinate mapping missing the coordinate key", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML_WITH_UNRESOLVED_COORDINATE);
    delete config.dependencies[0].coordinates[1].coordinate;
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.includes("coordinate"))).toBe(true);
  });

  it("rejects all coordinates being unresolved", () => {
    const config = releaseConfig.parseReleaseConfig(VALID_YAML_WITH_UNRESOLVED_COORDINATE);
    config.dependencies[0].coordinates[0] = { coordinate: "dev.qilletni.impl:qilletni", resolved: false };
    const errors = releaseConfig.validateReleaseConfig(config);
    expect(errors.some((e) => e.toLowerCase().includes("resolved"))).toBe(true);
  });
});
