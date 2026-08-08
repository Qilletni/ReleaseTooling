import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/artifact_verify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/artifact_verify.js")>();
  return {
    ...actual,
    fetchTagRef: vi.fn(actual.fetchTagRef),
    fetchGitTagObject: vi.fn(actual.fetchGitTagObject),
    fetchGithubRelease: vi.fn(actual.fetchGithubRelease),
  };
});

import * as artifactVerify from "../src/artifact_verify.js";
import { main, __setStdinForTests } from "../src/cli.js";
import * as platformCandidates from "../src/platform_candidates.js";
import * as platformManifest from "../src/platform_manifest.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "release-tools-"));
}

async function runCli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
    outLines.push(String(msg ?? ""));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
    errLines.push(String(msg ?? ""));
  });
  try {
    const code = await main(argv);
    return { code, out: outLines.join("\n"), err: errLines.join("\n") };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

afterEach(() => {
  __setStdinForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("next-version", () => {
  it("applies a patch bump", async () => {
    const { code, out } = await runCli(["next-version", "--current-version", "1.2.3", "--bump", "patch"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("1.2.4");
  });

  it("computes a snapshot", async () => {
    const { code, out } = await runCli(["next-version", "--current-version", "1.2.3", "--snapshot"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("1.2.4-SNAPSHOT");
  });

  it("reports an error for an invalid version", async () => {
    const { code, err } = await runCli(["next-version", "--current-version", "not-a-version"]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });
});

describe("latest-stable-tag", () => {
  it("prints the highest stable tag from stdin", async () => {
    __setStdinForTests("v1.0.0\nv1.0.1\nv1.1.0\n");
    const { code, out } = await runCli(["latest-stable-tag"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("1.1.0");
  });

  it("prints an empty line when no stable tag is found", async () => {
    __setStdinForTests("");
    const { code, out } = await runCli(["latest-stable-tag"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("");
  });
});

describe("next-release-version", () => {
  it("bumps from the latest stable tag", async () => {
    const { code, out } = await runCli([
      "next-release-version",
      "--current-file-version",
      "1.0.2-SNAPSHOT",
      "--bump",
      "patch",
      "--latest-stable-version",
      "1.0.1",
    ]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("1.0.2");
  });

  it("handles the first-release edge with no latest stable version", async () => {
    const { code, out } = await runCli(["next-release-version", "--current-file-version", "0.1.0-SNAPSHOT", "--bump", "patch"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("0.1.0");
  });
});

describe("check-changelog-unreleased", () => {
  it("reports OK for a non-empty unreleased section", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "CHANGELOG.md");
    writeFileSync(path, "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Thing\n");
    const { code, out } = await runCli(["check-changelog-unreleased", "--changelog", path]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("OK");
  });

  it("reports an error for an empty unreleased section", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "CHANGELOG.md");
    writeFileSync(path, "# Changelog\n\n## [Unreleased]\n");
    const { code, err } = await runCli(["check-changelog-unreleased", "--changelog", path]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });
});

describe("release marker write/check", () => {
  it("writes then checks a release marker", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "pending-release.json");
    const write = await runCli([
      "write-release-marker",
      "--marker",
      path,
      "--component",
      "qilletni-core",
      "--from-version",
      "1.0.1",
      "--to-version",
      "1.0.2",
      "--bump",
      "patch",
    ]);
    expect(write.code).toBe(0);

    const check = await runCli(["check-release-marker", "--marker", path, "--expected-component", "qilletni-core", "--expected-version", "1.0.2"]);
    expect(check.code).toBe(0);
    expect(check.out.trim()).toBe("OK");
  });

  it("rejects a version mismatch", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "pending-release.json");
    await runCli([
      "write-release-marker",
      "--marker",
      path,
      "--component",
      "qilletni-core",
      "--from-version",
      "1.0.1",
      "--to-version",
      "1.0.2",
      "--bump",
      "patch",
    ]);
    const { code, err } = await runCli(["check-release-marker", "--marker", path, "--expected-component", "qilletni-core", "--expected-version", "9.9.9"]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });
});

describe("check-merge-provenance", () => {
  it("accepts a matching release pull", async () => {
    __setStdinForTests(JSON.stringify([{ head: { ref: "release/qilletni-core-1.0.2" }, labels: [{ name: "release" }], merged_at: "x" }]));
    const { code } = await runCli(["check-merge-provenance", "--component", "qilletni-core", "--version", "1.0.2"]);
    expect(code).toBe(0);
  });

  it("rejects when no matching pull exists", async () => {
    __setStdinForTests(JSON.stringify([{ head: { ref: "unrelated" }, labels: [], merged_at: null }]));
    const { code, err } = await runCli(["check-merge-provenance", "--component", "qilletni-core", "--version", "1.0.2"]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });
});

describe("classify-bump", () => {
  it("classifies a major bump", async () => {
    const { code, out } = await runCli(["classify-bump", "--old-version", "1.2.3", "--new-version", "2.0.0"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("major");
  });

  it("rejects a non-increasing version", async () => {
    const { code, err } = await runCli(["classify-bump", "--old-version", "1.2.3", "--new-version", "1.2.3"]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });
});

describe("set-property / get-property", () => {
  it("sets then gets a property", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "gradle.properties");
    writeFileSync(path, "qilletniVersion=1.0.0\n");

    const set = await runCli(["set-property", "--file", path, "--key", "qilletniVersion", "--value", "1.1.0"]);
    expect(set.code).toBe(0);

    const get = await runCli(["get-property", "--file", path, "--key", "qilletniVersion"]);
    expect(get.code).toBe(0);
    expect(get.out.trim()).toBe("1.1.0");
  });

  it("reports an error for a missing key", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "gradle.properties");
    writeFileSync(path, "qilletniVersion=1.0.0\n");
    const { code, err } = await runCli(["get-property", "--file", path, "--key", "missing"]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });
});

describe("promote-changelog", () => {
  it("promotes and writes the file", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "CHANGELOG.md");
    writeFileSync(path, "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Thing\n");

    const { code } = await runCli(["promote-changelog", "--changelog", path, "--version", "1.1.0", "--date", "2026-01-01"]);
    expect(code).toBe(0);
    expect(readFileSync(path, "utf-8")).toContain("## [1.1.0] - 2026-01-01");
  });

  it("does not write in check mode", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "CHANGELOG.md");
    const original = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Thing\n";
    writeFileSync(path, original);

    const { code, out } = await runCli(["promote-changelog", "--changelog", path, "--version", "1.1.0", "--date", "2026-01-01", "--check"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("OK");
    expect(readFileSync(path, "utf-8")).toBe(original);
  });

  it("reports an error for an empty unreleased section", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "CHANGELOG.md");
    writeFileSync(path, "# Changelog\n\n## [Unreleased]\n");
    const { code, err } = await runCli(["promote-changelog", "--changelog", path, "--version", "1.1.0"]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });
});

describe("validate-release-config", () => {
  it("reports OK for a valid config", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "release.yml");
    writeFileSync(
      path,
      `
schema_version: 1
repository: Qilletni/Qilletni
components:
  - name: qilletni-core
    kind: maven
    version_file: gradle.properties
    version_key: qilletniVersion
    changelog: CHANGELOG.md
    artifacts:
      - maven:
          group: dev.qilletni.impl
          artifact: qilletni
`
    );
    const { code, out } = await runCli(["validate-release-config", "--config", path]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("OK");
  });

  it("reports errors and a nonzero exit for an invalid config", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "release.yml");
    writeFileSync(path, "schema_version: 1\n");
    const { code, err } = await runCli(["validate-release-config", "--config", path]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });
});

describe("check-japicmp-report", () => {
  const REPORT = `
<japicmp>
  <classes>
    <class fullyQualifiedName="dev.qilletni.api.Foo" changeStatus="MODIFIED"
           binaryCompatible="false" sourceCompatible="false"/>
  </classes>
</japicmp>
`;

  it("minor policy rejects a breaking change", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "japicmp.xml");
    writeFileSync(path, REPORT);
    const { code, err } = await runCli(["check-japicmp-report", "--report", path, "--policy", "minor"]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });

  it("major policy allows a breaking change with a migration doc", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "japicmp.xml");
    writeFileSync(path, REPORT);
    const { code, out } = await runCli(["check-japicmp-report", "--report", path, "--policy", "major", "--has-migration-doc"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("OK");
  });
});

describe("verify-platform-manifest-commits", () => {
  const MANIFEST = `
schema_version: 1
platform_version: 1.0.0
legacy_verification: true
components:
  toolchain:
    repository: Qilletni/QilletniToolchain
    version: 1.0.1
    tag: v1.0.1
    commit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
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
    commit: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    asset: qpm-1.0.0.tar.gz
    sha256: 2613973691eb55be95254773621246771b82244454f43c7e8f2741440a7ca0ee
    embeds:
      api: 1.0.0
      pkgutil: 1.0.0
`;

  it("reports OK when tags match declared commits", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "1.0.0.yml");
    writeFileSync(path, MANIFEST);

    vi.mocked(artifactVerify.fetchTagRef).mockImplementation(async (repository: string) => {
      const sha = repository.endsWith("QilletniToolchain") ? "a".repeat(40) : "b".repeat(40);
      return { object: { type: "commit", sha } };
    });

    const { code, out } = await runCli(["verify-platform-manifest-commits", "--manifest", path]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("OK");
  });

  it("reports an error when a tag no longer matches", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "1.0.0.yml");
    writeFileSync(path, MANIFEST);

    vi.mocked(artifactVerify.fetchTagRef).mockImplementation(async () => ({ object: { type: "commit", sha: "f".repeat(40) } }));

    const { code, err } = await runCli(["verify-platform-manifest-commits", "--manifest", path]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });
});

describe("build-dependency-payload", () => {
  it("builds a valid JSON payload", async () => {
    const { code, out } = await runCli([
      "build-dependency-payload",
      "--component",
      "qilletni-core",
      "--version",
      "1.1.0",
      "--commit",
      "a".repeat(40),
      "--repository",
      "Qilletni/Qilletni",
      "--artifact",
      `dev.qilletni.impl:qilletni:1.1.0=${"b".repeat(64)}`,
    ]);
    expect(code).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.component).toBe("qilletni-core");
    expect(payload.artifacts[0].sha256).toBe("b".repeat(64));
  });

  it("rejects an invalid artifact hash", async () => {
    const { code, err } = await runCli([
      "build-dependency-payload",
      "--component",
      "qilletni-core",
      "--version",
      "1.1.0",
      "--commit",
      "a".repeat(40),
      "--repository",
      "Qilletni/Qilletni",
      "--artifact",
      "dev.qilletni.impl:qilletni:1.1.0=not-a-hash",
    ]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });
});

const VALID_CANDIDATES = `
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

describe("validate-platform-candidates", () => {
  it("reports OK for valid candidates", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "candidates.yml");
    writeFileSync(path, VALID_CANDIDATES);
    const { code, out } = await runCli(["validate-platform-candidates", "--candidates", path]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("OK");
  });

  it("reports an error for a missing component", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "candidates.yml");
    writeFileSync(path, "schema_version: 1\ncomponents: {}\n");
    const { code, err } = await runCli(["validate-platform-candidates", "--candidates", path]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });
});

describe("build-release-event", () => {
  it("builds a valid JSON event", async () => {
    const { code, out } = await runCli([
      "build-release-event",
      "--component",
      "toolchain",
      "--repository",
      "Qilletni/QilletniToolchain",
      "--version",
      "1.0.2",
      "--commit",
      "a".repeat(40),
      "--asset",
      "qilletni-1.0.2.tar.gz",
      "--sha256",
      "b".repeat(64),
      "--embed",
      "core=1.0.2",
      "--embed",
      "api=1.0.1",
      "--embed",
      "pkgutil=1.0.1",
      "--embed",
      "docgen=1.0.1",
    ]);
    expect(code).toBe(0);
    const event = JSON.parse(out);
    expect(event.component).toBe("toolchain");
    expect(event.tag).toBe("v1.0.2");
    expect(event.embeds.core).toBe("1.0.2");
  });

  it("rejects a repository/component mismatch", async () => {
    const { code, err } = await runCli([
      "build-release-event",
      "--component",
      "toolchain",
      "--repository",
      "Qilletni/QPMCLI",
      "--version",
      "1.0.2",
      "--commit",
      "a".repeat(40),
      "--asset",
      "qilletni-1.0.2.tar.gz",
      "--sha256",
      "b".repeat(64),
      "--embed",
      "core=1.0.2",
      "--embed",
      "api=1.0.1",
      "--embed",
      "pkgutil=1.0.1",
      "--embed",
      "docgen=1.0.1",
    ]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });

  it("rejects a path-traversal asset", async () => {
    const { code, err } = await runCli([
      "build-release-event",
      "--component",
      "toolchain",
      "--repository",
      "Qilletni/QilletniToolchain",
      "--version",
      "1.0.2",
      "--commit",
      "a".repeat(40),
      "--asset",
      "../../etc/passwd",
      "--sha256",
      "b".repeat(64),
      "--embed",
      "core=1.0.2",
      "--embed",
      "api=1.0.1",
      "--embed",
      "pkgutil=1.0.1",
      "--embed",
      "docgen=1.0.1",
    ]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });
});

describe("update-platform-candidates", () => {
  function eventJson(): string {
    return JSON.stringify({
      schema_version: 1,
      component: "toolchain",
      repository: "Qilletni/QilletniToolchain",
      version: "1.0.2",
      tag: "v1.0.2",
      commit: "a".repeat(40),
      asset: "qilletni-1.0.2.tar.gz",
      sha256: "b".repeat(64),
      embeds: { core: "1.0.2", api: "1.0.1", pkgutil: "1.0.1", docgen: "1.0.1" },
    });
  }

  it("updates the candidates file in place", async () => {
    const tmp = tmpDir();
    const candidatesPath = join(tmp, "candidates.yml");
    const eventPath = join(tmp, "event.json");
    writeFileSync(candidatesPath, VALID_CANDIDATES);
    writeFileSync(eventPath, eventJson());

    const { code } = await runCli(["update-platform-candidates", "--candidates", candidatesPath, "--event", eventPath]);
    expect(code).toBe(0);

    const updated = platformCandidates.loadCandidates(candidatesPath);
    expect(updated.components.toolchain.version).toBe("1.0.2");
    expect(updated.components.qpm.version).toBe("1.0.0");
  });

  it("writes to a separate output path when given", async () => {
    const tmp = tmpDir();
    const candidatesPath = join(tmp, "candidates.yml");
    const eventPath = join(tmp, "event.json");
    const outputPath = join(tmp, "out.yml");
    writeFileSync(candidatesPath, VALID_CANDIDATES);
    writeFileSync(eventPath, eventJson());

    const { code } = await runCli(["update-platform-candidates", "--candidates", candidatesPath, "--event", eventPath, "--output", outputPath]);
    expect(code).toBe(0);

    const original = platformCandidates.loadCandidates(candidatesPath);
    expect(original.components.toolchain.version).toBe("1.0.1");

    const updated = platformCandidates.loadCandidates(outputPath);
    expect(updated.components.toolchain.version).toBe("1.0.2");
  });

  it("rejects an invalid event", async () => {
    const tmp = tmpDir();
    const candidatesPath = join(tmp, "candidates.yml");
    const eventPath = join(tmp, "event.json");
    writeFileSync(candidatesPath, VALID_CANDIDATES);
    writeFileSync(eventPath, JSON.stringify({ schema_version: 1, component: "toolchain" }));

    const { code, err } = await runCli(["update-platform-candidates", "--candidates", candidatesPath, "--event", eventPath]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });
});

describe("latest-platform-version", () => {
  it("prints the highest version from stdin", async () => {
    __setStdinForTests("1.0.0.yml\ncandidates.yml\n1.2.0.yml\n");
    const { code, out } = await runCli(["latest-platform-version"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("1.2.0");
  });

  it("prints an empty line when no manifest is found", async () => {
    __setStdinForTests("candidates.yml\n");
    const { code, out } = await runCli(["latest-platform-version"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("");
  });
});

describe("promote-candidates-to-platform-manifest", () => {
  it("promotes and writes the manifest", async () => {
    const tmp = tmpDir();
    const candidatesPath = join(tmp, "candidates.yml");
    const outputPath = join(tmp, "1.1.0.yml");
    writeFileSync(candidatesPath, VALID_CANDIDATES);

    const { code } = await runCli([
      "promote-candidates-to-platform-manifest",
      "--candidates",
      candidatesPath,
      "--platform-version",
      "1.1.0",
      "--output",
      outputPath,
    ]);
    expect(code).toBe(0);

    const manifest = platformManifest.loadPlatformManifest(outputPath);
    expect(manifest.platform_version).toBe("1.1.0");
    expect(platformManifest.validatePlatformManifest(manifest)).toEqual([]);
  });

  it("refuses to overwrite an existing manifest", async () => {
    const tmp = tmpDir();
    const candidatesPath = join(tmp, "candidates.yml");
    const outputPath = join(tmp, "1.1.0.yml");
    writeFileSync(candidatesPath, VALID_CANDIDATES);
    writeFileSync(outputPath, "already: here\n");

    const { code, err } = await runCli([
      "promote-candidates-to-platform-manifest",
      "--candidates",
      candidatesPath,
      "--platform-version",
      "1.1.0",
      "--output",
      outputPath,
    ]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
    expect(readFileSync(outputPath, "utf-8")).toBe("already: here\n");
  });
});

describe("verify-live-asset-provenance", () => {
  it("reports OK when hashes match the live release", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "candidates.yml");
    writeFileSync(path, VALID_CANDIDATES);

    vi.mocked(artifactVerify.fetchGithubRelease).mockImplementation(async (repository: string) => {
      const isToolchain = repository.endsWith("QilletniToolchain");
      const sha256 = isToolchain
        ? "5bf7df3e8804e039b966e5f133324d849e242eac470a33574f54cb931b0c67a2"
        : "2613973691eb55be95254773621246771b82244454f43c7e8f2741440a7ca0ee";
      const asset = isToolchain ? "qilletni-1.0.1.tar.gz" : "qpm-1.0.0.tar.gz";
      return { assets: [{ name: asset, digest: `sha256:${sha256}` }] };
    });

    const { code, out } = await runCli(["verify-live-asset-provenance", "--manifest", path]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("OK");
  });

  it("reports an error on mismatch", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "candidates.yml");
    writeFileSync(path, VALID_CANDIDATES);

    vi.mocked(artifactVerify.fetchGithubRelease).mockImplementation(async () => ({
      assets: [{ name: "qilletni-1.0.1.tar.gz", digest: "sha256:" + "f".repeat(64) }],
    }));

    const { code, err } = await runCli(["verify-live-asset-provenance", "--manifest", path]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });
});

describe("verify-release-event-provenance", () => {
  function event() {
    return {
      schema_version: 1,
      component: "toolchain",
      repository: "Qilletni/QilletniToolchain",
      version: "1.0.2",
      tag: "v1.0.2",
      commit: "a".repeat(40),
      asset: "qilletni-1.0.2.tar.gz",
      sha256: "b".repeat(64),
      embeds: { core: "1.0.2", api: "1.0.1", pkgutil: "1.0.1", docgen: "1.0.1" },
    };
  }

  it("reports OK when live data matches", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "event.json");
    writeFileSync(path, JSON.stringify(event()));

    vi.mocked(artifactVerify.fetchTagRef).mockImplementation(async () => ({ object: { type: "commit", sha: "a".repeat(40) } }));
    vi.mocked(artifactVerify.fetchGithubRelease).mockImplementation(async () => ({
      assets: [{ name: "qilletni-1.0.2.tar.gz", digest: "sha256:" + "b".repeat(64) }],
    }));

    const { code, out } = await runCli(["verify-release-event-provenance", "--event", path]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("OK");
  });

  it("reports an error on commit mismatch", async () => {
    const tmp = tmpDir();
    const path = join(tmp, "event.json");
    writeFileSync(path, JSON.stringify(event()));

    vi.mocked(artifactVerify.fetchTagRef).mockImplementation(async () => ({ object: { type: "commit", sha: "f".repeat(40) } }));
    vi.mocked(artifactVerify.fetchGithubRelease).mockImplementation(async () => ({
      assets: [{ name: "qilletni-1.0.2.tar.gz", digest: "sha256:" + "b".repeat(64) }],
    }));

    const { code, err } = await runCli(["verify-release-event-provenance", "--event", path]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });
});

const DEPENDENCY_CONFIG_YAML = `
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

function dependencyPayload(overrides: Record<string, unknown> = {}) {
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
  };
}

describe("validate-dependency-payload", () => {
  it("reports OK for a valid payload against config", async () => {
    const tmp = tmpDir();
    const configPath = join(tmp, "release.yml");
    const payloadPath = join(tmp, "payload.json");
    writeFileSync(configPath, DEPENDENCY_CONFIG_YAML);
    writeFileSync(payloadPath, JSON.stringify(dependencyPayload()));

    const { code, out } = await runCli(["validate-dependency-payload", "--payload", payloadPath, "--config", configPath]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("OK");
  });

  it("reports an error for a spoofed repository", async () => {
    const tmp = tmpDir();
    const configPath = join(tmp, "release.yml");
    const payloadPath = join(tmp, "payload.json");
    writeFileSync(configPath, DEPENDENCY_CONFIG_YAML);
    writeFileSync(payloadPath, JSON.stringify(dependencyPayload({ repository: "Qilletni/SomeoneElse" })));

    const { code, err } = await runCli(["validate-dependency-payload", "--payload", payloadPath, "--config", configPath]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });
});

describe("apply-dependency-update", () => {
  it("applies the configured version file and key", async () => {
    const tmp = tmpDir();
    const configPath = join(tmp, "release.yml");
    const payloadPath = join(tmp, "payload.json");
    writeFileSync(configPath, DEPENDENCY_CONFIG_YAML);
    writeFileSync(payloadPath, JSON.stringify(dependencyPayload()));
    writeFileSync(join(tmp, "gradle.properties"), "qilletniCoreVersion=1.0.0\n");

    const { code } = await runCli(["apply-dependency-update", "--payload", payloadPath, "--config", configPath, "--base-dir", tmp]);
    expect(code).toBe(0);
    expect(readFileSync(join(tmp, "gradle.properties"), "utf-8")).toContain("qilletniCoreVersion=1.1.0");
  });

  it("rejects an invalid payload without writing", async () => {
    const tmp = tmpDir();
    const configPath = join(tmp, "release.yml");
    const payloadPath = join(tmp, "payload.json");
    writeFileSync(configPath, DEPENDENCY_CONFIG_YAML);
    writeFileSync(payloadPath, JSON.stringify(dependencyPayload({ repository: "Qilletni/SomeoneElse" })));
    writeFileSync(join(tmp, "gradle.properties"), "qilletniCoreVersion=1.0.0\n");

    const { code, err } = await runCli(["apply-dependency-update", "--payload", payloadPath, "--config", configPath, "--base-dir", tmp]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
    expect(readFileSync(join(tmp, "gradle.properties"), "utf-8")).toContain("qilletniCoreVersion=1.0.0");
  });
});

describe("verify-dependency-artifacts", () => {
  function fakeFetchResponse(data: Buffer): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }

  it("reports OK when all hashes match", async () => {
    const { createHash } = await import("node:crypto");
    const payload = dependencyPayload({
      artifacts: [{ coordinates: "dev.qilletni.impl:qilletni:1.1.0", sha256: createHash("sha256").update("core jar bytes").digest("hex") }],
    });
    const tmp = tmpDir();
    const path = join(tmp, "payload.json");
    writeFileSync(path, JSON.stringify(payload));

    vi.stubGlobal("fetch", vi.fn(async () => fakeFetchResponse(Buffer.from("core jar bytes"))));

    const { code, out } = await runCli(["verify-dependency-artifacts", "--payload", path]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("OK");
  });

  it("reports an error on hash mismatch", async () => {
    const payload = dependencyPayload({ artifacts: [{ coordinates: "dev.qilletni.impl:qilletni:1.1.0", sha256: "f".repeat(64) }] });
    const tmp = tmpDir();
    const path = join(tmp, "payload.json");
    writeFileSync(path, JSON.stringify(payload));

    vi.stubGlobal("fetch", vi.fn(async () => fakeFetchResponse(Buffer.from("core jar bytes"))));

    const { code, err } = await runCli(["verify-dependency-artifacts", "--payload", path]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });
});

describe("check-resolved-dependency-versions", () => {
  const REPORT = `
runtimeClasspath
+--- dev.qilletni.impl:qilletni:1.1.0
+--- dev.qilletni.api:qilletni-api:1.0.1 -> 1.1.0
`;

  it("reports OK when resolved versions match", async () => {
    const payload = dependencyPayload();
    const tmp = tmpDir();
    const path = join(tmp, "payload.json");
    writeFileSync(path, JSON.stringify(payload));

    __setStdinForTests(REPORT);
    const { code, out } = await runCli(["check-resolved-dependency-versions", "--payload", path]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("OK");
  });

  it("reports an error on a divergent resolved version", async () => {
    const payload = dependencyPayload({ artifacts: [{ coordinates: "dev.qilletni.impl:qilletni:9.9.9", sha256: "b".repeat(64) }] });
    const tmp = tmpDir();
    const path = join(tmp, "payload.json");
    writeFileSync(path, JSON.stringify(payload));

    __setStdinForTests(REPORT);
    const { code, err } = await runCli(["check-resolved-dependency-versions", "--payload", path]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });

  it("excludes an unresolved coordinate from the check via --config", async () => {
    // The report only resolves 'qilletni-api'; 'qilletni' is not on the
    // classpath at all, but the dependency config marks it
    // 'resolved: false' so its absence must not fail the check.
    const report = "runtimeClasspath\n+--- dev.qilletni.api:qilletni-api:1.1.0\n";
    const payload = dependencyPayload();
    const tmp = tmpDir();
    const configPath = join(tmp, "release.yml");
    const payloadPath = join(tmp, "payload.json");
    writeFileSync(
      configPath,
      `
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
`
    );
    writeFileSync(payloadPath, JSON.stringify(payload));

    __setStdinForTests(report);
    const { code, out } = await runCli(["check-resolved-dependency-versions", "--payload", payloadPath, "--config", configPath]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("OK");
  });

  it("still fails on a missing coordinate without --config", async () => {
    // Backward-compatible behaviour: omitting '--config' checks every
    // payload artifact, exactly as before this flag existed.
    const report = "runtimeClasspath\n+--- dev.qilletni.api:qilletni-api:1.1.0\n";
    const payload = dependencyPayload();
    const tmp = tmpDir();
    const path = join(tmp, "payload.json");
    writeFileSync(path, JSON.stringify(payload));

    __setStdinForTests(report);
    const { code, err } = await runCli(["check-resolved-dependency-versions", "--payload", path]);
    expect(code).toBe(1);
    expect(err).toContain("::error::");
  });
});
