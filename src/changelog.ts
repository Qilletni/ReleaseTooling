/**
 * Keep a Changelog (https://keepachangelog.com) helpers.
 *
 * Every onboarded repository keeps an `## [Unreleased]` section at the top of
 * its `CHANGELOG.md`. Release preparation "promotes" that section to a dated
 * release heading and leaves a fresh, empty `Unreleased` section behind.
 */

const UNRELEASED_HEADING_RE = /^## \[Unreleased\][ \t]*\n/m;
const NEXT_HEADING_RE = /^## \[/m;
const VERSION_HEADING_RE = /^## \[([^\]]+)\]/gm;

export class ChangelogError extends Error {}

interface UnreleasedSection {
  headingStart: number;
  bodyStart: number;
  bodyEnd: number;
}

function findUnreleasedSection(text: string): UnreleasedSection {
  const headingMatch = UNRELEASED_HEADING_RE.exec(text);
  if (!headingMatch) {
    throw new ChangelogError("Changelog is missing a '## [Unreleased]' section");
  }

  const bodyStart = headingMatch.index + headingMatch[0].length;
  NEXT_HEADING_RE.lastIndex = 0;
  const rest = text.slice(bodyStart);
  const nextHeading = NEXT_HEADING_RE.exec(rest);
  const bodyEnd = nextHeading ? bodyStart + nextHeading.index : text.length;

  return { headingStart: headingMatch.index, bodyStart, bodyEnd };
}

/** Returns true if the Unreleased section has any entries in it. */
export function hasUnreleasedContent(text: string): boolean {
  const { bodyStart, bodyEnd } = findUnreleasedSection(text);
  return text.slice(bodyStart, bodyEnd).trim() !== "";
}

export function existingVersions(text: string): string[] {
  return Array.from(text.matchAll(VERSION_HEADING_RE), (m) => m[1]);
}

/**
 * Promotes the Unreleased section content into a new `## [version] - date`
 * section.
 *
 * Throws ChangelogError if the Unreleased section is missing, empty, or if
 * `version` has already been released.
 */
export function promoteUnreleased(text: string, version: string, date: string): string {
  if (existingVersions(text).includes(version)) {
    throw new ChangelogError(`Version '${version}' already exists in the changelog`);
  }

  const { headingStart, bodyStart, bodyEnd } = findUnreleasedSection(text);
  const body = text.slice(bodyStart, bodyEnd);

  if (body.trim() === "") {
    throw new ChangelogError("Unreleased section is empty; nothing to release");
  }

  const newSection = `## [Unreleased]\n\n## [${version}] - ${date}\n${body}`;

  return text.slice(0, headingStart) + newSection + text.slice(bodyEnd);
}

/** Adds an empty `## [Unreleased]` section right after the title if missing. */
export function ensureUnreleasedSection(text: string): string {
  if (UNRELEASED_HEADING_RE.test(text)) {
    return text;
  }

  const firstHeading = NEXT_HEADING_RE.exec(text);
  if (!firstHeading) {
    return text.replace(/\n+$/, "") + "\n\n## [Unreleased]\n";
  }

  const insertAt = firstHeading.index;
  return text.slice(0, insertAt) + "## [Unreleased]\n\n" + text.slice(insertAt);
}
