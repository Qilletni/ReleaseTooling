import { describe, it, expect } from "vitest";
import * as componentsRegistry from "../src/components_registry.js";

const VALID_YAML = `
schema_version: 1
components:
  - name: qilletni-core
    repository: Qilletni/Qilletni
    artifacts:
      - dev.qilletni.impl:qilletni
      - dev.qilletni.api:qilletni-api
    consumers:
      - Qilletni/QilletniToolchain
      - Qilletni/QPMCLI
      - Qilletni/QilletniDocgen
  - name: qilletni-pkgutil
    repository: Qilletni/QilletniPackageUtility
    consumers:
      - Qilletni/QilletniToolchain
      - Qilletni/QPMCLI
`;

const ALLOWED_REPOS = [
  "Qilletni/Qilletni",
  "Qilletni/QilletniToolchain",
  "Qilletni/QPMCLI",
  "Qilletni/QilletniPackageUtility",
  "Qilletni/QilletniDocgen",
];

describe("parseRegistry", () => {
  it("parses a valid registry", () => {
    const registry = componentsRegistry.parseRegistry(VALID_YAML);
    expect(registry.components.length).toBe(2);
  });

  it("returns consumers for a component", () => {
    const registry = componentsRegistry.parseRegistry(VALID_YAML);
    const consumers = componentsRegistry.consumersFor(registry, "qilletni-core");
    expect(consumers).toContain("Qilletni/QilletniToolchain");
    expect(consumers).toContain("Qilletni/QilletniDocgen");
  });

  it("throws for an unknown component", () => {
    const registry = componentsRegistry.parseRegistry(VALID_YAML);
    expect(() => componentsRegistry.consumersFor(registry, "does-not-exist")).toThrow();
  });
});

describe("validateRegistry", () => {
  it("has no errors for a valid registry", () => {
    const registry = componentsRegistry.parseRegistry(VALID_YAML);
    expect(componentsRegistry.validateRegistry(registry, { allowedRepositories: ALLOWED_REPOS })).toEqual([]);
  });

  it("rejects a repository outside the onboarded set", () => {
    const registry = componentsRegistry.parseRegistry(VALID_YAML);
    registry.components[0].consumers.push("Someone/RandomRepo");
    const errors = componentsRegistry.validateRegistry(registry, { allowedRepositories: ALLOWED_REPOS });
    expect(errors.some((e) => e.includes("Someone/RandomRepo"))).toBe(true);
  });

  it("rejects duplicate component names", () => {
    const registry = componentsRegistry.parseRegistry(VALID_YAML);
    registry.components.push({ ...registry.components[0] });
    const errors = componentsRegistry.validateRegistry(registry, { allowedRepositories: ALLOWED_REPOS });
    expect(errors.some((e) => e.toLowerCase().includes("duplicate"))).toBe(true);
  });

  it("rejects empty consumers", () => {
    const registry = componentsRegistry.parseRegistry(VALID_YAML);
    registry.components[0].consumers = [];
    const errors = componentsRegistry.validateRegistry(registry, { allowedRepositories: ALLOWED_REPOS });
    expect(errors.some((e) => e.includes("consumers"))).toBe(true);
  });

  it("rejects malformed artifact coordinates", () => {
    const registry = componentsRegistry.parseRegistry(VALID_YAML);
    registry.components[0].artifacts = ["not-a-valid-coordinate"];
    const errors = componentsRegistry.validateRegistry(registry, { allowedRepositories: ALLOWED_REPOS });
    expect(errors.some((e) => e.toLowerCase().includes("artifact"))).toBe(true);
  });

  it("treats artifacts as optional", () => {
    const registry = componentsRegistry.parseRegistry(VALID_YAML);
    delete registry.components[0].artifacts;
    expect(componentsRegistry.validateRegistry(registry, { allowedRepositories: ALLOWED_REPOS })).toEqual([]);
  });

  it("returns artifacts for a component", () => {
    const registry = componentsRegistry.parseRegistry(VALID_YAML);
    const artifacts = componentsRegistry.artifactsFor(registry, "qilletni-core");
    expect(artifacts).toEqual(["dev.qilletni.impl:qilletni", "dev.qilletni.api:qilletni-api"]);
  });
});
