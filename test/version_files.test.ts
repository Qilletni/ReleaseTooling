import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as versionFiles from "../src/version_files.js";

const PROPERTIES = `mavenCentralPublishing=true
signAllPublications=true

# comment retained
qilletniVersion=1.0.2-SNAPSHOT
`;

describe("getProperty", () => {
  it("reads an existing key", () => {
    expect(versionFiles.getProperty(PROPERTIES, "qilletniVersion")).toBe("1.0.2-SNAPSHOT");
  });

  it("throws for a missing key", () => {
    expect(() => versionFiles.getProperty(PROPERTIES, "doesNotExist")).toThrow();
  });
});

describe("setProperty", () => {
  it("updates an existing key in place", () => {
    const result = versionFiles.setProperty(PROPERTIES, "qilletniVersion", "1.1.0");
    expect(result).toContain("qilletniVersion=1.1.0");
    expect(result).not.toContain("1.0.2-SNAPSHOT");
    // Ordering, comments, and other keys are preserved.
    expect(result).toContain("# comment retained");
    expect(result).toContain("mavenCentralPublishing=true");
    expect(result.split("qilletniVersion=").length - 1).toBe(1);
  });

  it("appends when the key is missing", () => {
    const result = versionFiles.setProperty(PROPERTIES, "newKey", "value");
    expect(result).toContain("newKey=value");
  });

  it("round-trips through a file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-tools-"));
    const path = join(tmp, "gradle.properties");
    writeFileSync(path, PROPERTIES);

    versionFiles.updatePropertyFile(path, "qilletniVersion", "2.0.0");

    expect(readFileSync(path, "utf-8")).toContain("qilletniVersion=2.0.0");
  });
});
