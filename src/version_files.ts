/**
 * Helpers for reading/writing `key=value` Java `.properties`-style files.
 *
 * Used to update the single `qilletniVersion` key in the root
 * `gradle.properties` (and any other property-file based version markers
 * declared in `.qilletni/release.yml`) without disturbing comments,
 * ordering, or unrelated keys.
 */

import { readFileSync, writeFileSync } from "node:fs";

const PROPERTY_RE = /^([^#=\s][^=]*?)=(.*)$/;

/** Splits text into lines, keeping each line's original ending (\n, \r\n or \r). */
function splitKeepingLineEndings(text: string): string[] {
  const result: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      result.push(text.slice(start, i + 1));
      start = i + 1;
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") {
        result.push(text.slice(start, i + 2));
        start = i + 2;
        i++;
      } else {
        result.push(text.slice(start, i + 1));
        start = i + 1;
      }
    }
  }
  if (start < text.length) {
    result.push(text.slice(start));
  }
  return result;
}

export function getProperty(text: string, key: string): string {
  for (const line of text.split(/\r\n|\r|\n/)) {
    const match = PROPERTY_RE.exec(line);
    if (match && match[1].trim() === key) {
      return match[2].trim();
    }
  }
  throw new Error(`Property '${key}' not found`);
}

/**
 * Returns `text` with `key` set to `value`, preserving everything else.
 *
 * If `key` is not already present, it is appended as a new line.
 */
export function setProperty(text: string, key: string, value: string): string {
  const lines = splitKeepingLineEndings(text);
  let updated = false;
  const result: string[] = [];

  for (const line of lines) {
    const eolMatch = /\r\n$|\r$|\n$/.exec(line);
    const eol = eolMatch ? eolMatch[0] : "";
    const withoutNewline = eol ? line.slice(0, -eol.length) : line;
    const match = PROPERTY_RE.exec(withoutNewline);
    if (match && match[1].trim() === key && !updated) {
      result.push(`${key}=${value}${eol}`);
      updated = true;
    } else {
      result.push(line);
    }
  }

  if (!updated) {
    if (result.length > 0 && !result[result.length - 1].endsWith("\n")) {
      result.push("\n");
    }
    result.push(`${key}=${value}\n`);
  }

  return result.join("");
}

export function updatePropertyFile(path: string, key: string, value: string): void {
  const content = readFileSync(path, "utf-8");
  const updated = setProperty(content, key, value);
  writeFileSync(path, updated, "utf-8");
}
