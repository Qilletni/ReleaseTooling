import { describe, it, expect } from "vitest";
import * as changelog from "../src/changelog.js";

const SAMPLE = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- New shiny thing

## [1.0.1] - 2025-12-01

### Fixed

- Track population bug on single tracks in weights
`;

const EMPTY_UNRELEASED = `# Changelog

## [Unreleased]

## [1.0.1] - 2025-12-01

### Fixed

- Track population bug
`;

const NO_UNRELEASED = `# Changelog

## [1.0.1] - 2025-12-01

### Fixed

- Track population bug
`;

describe("hasUnreleasedContent", () => {
  it("is true when entries are present", () => {
    expect(changelog.hasUnreleasedContent(SAMPLE)).toBe(true);
  });

  it("is false when the section is empty", () => {
    expect(changelog.hasUnreleasedContent(EMPTY_UNRELEASED)).toBe(false);
  });

  it("throws when the section is missing", () => {
    expect(() => changelog.hasUnreleasedContent(NO_UNRELEASED)).toThrow(changelog.ChangelogError);
  });
});

describe("promoteUnreleased", () => {
  it("promotes the section with a heading and date", () => {
    const result = changelog.promoteUnreleased(SAMPLE, "1.1.0", "2026-01-01");
    expect(result).toContain("## [Unreleased]\n\n## [1.1.0] - 2026-01-01");
    expect(result).toContain("New shiny thing");
    // Old release section is preserved below the newly promoted one.
    expect(result).toContain("## [1.0.1] - 2025-12-01");
    const promotedIndex = result.indexOf("## [1.1.0]");
    const oldIndex = result.indexOf("## [1.0.1]");
    expect(promotedIndex).toBeLessThan(oldIndex);
  });

  it("leaves the new unreleased section empty", () => {
    const result = changelog.promoteUnreleased(SAMPLE, "1.1.0", "2026-01-01");
    const unreleasedBody = result.split("## [Unreleased]")[1].split("## [1.1.0]")[0];
    expect(unreleasedBody.trim()).toBe("");
  });

  it("throws on an empty unreleased section", () => {
    expect(() => changelog.promoteUnreleased(EMPTY_UNRELEASED, "1.1.0", "2026-01-01")).toThrow(changelog.ChangelogError);
  });

  it("throws when there is no unreleased section", () => {
    expect(() => changelog.promoteUnreleased(NO_UNRELEASED, "1.1.0", "2026-01-01")).toThrow(changelog.ChangelogError);
  });

  it("rejects a duplicate version", () => {
    expect(() => changelog.promoteUnreleased(SAMPLE, "1.0.1", "2026-01-01")).toThrow(changelog.ChangelogError);
  });
});

describe("ensureUnreleasedSection", () => {
  it("adds the section when missing", () => {
    const result = changelog.ensureUnreleasedSection(NO_UNRELEASED);
    expect(result).toContain("## [Unreleased]");
    expect(result.indexOf("## [Unreleased]")).toBeLessThan(result.indexOf("## [1.0.1]"));
  });

  it("is a no-op when already present", () => {
    expect(changelog.ensureUnreleasedSection(SAMPLE)).toBe(SAMPLE);
  });
});
