/**
 * Applies the Qilletni public-API compatibility policy to a japicmp XML
 * report.
 *
 * The Gradle `me.champeau.gradle.japicmp` plugin (configured with
 * `xmlOutputFile`) produces a report following japicmp's own XML schema:
 * every class/method/field/constructor element carries `changeStatus`
 * (`NEW`/`REMOVED`/`MODIFIED`/`UNCHANGED`), `binaryCompatible` and
 * `sourceCompatible` boolean attributes.
 *
 * Policy:
 *   - patch: reject ANY change (additive or breaking) to the public API.
 *   - minor: reject breaking changes; additive changes are allowed.
 *   - major: breaking changes are allowed only when a matching
 *     `docs/migrations/X.Y.Z.md` file is present.
 */

import { XMLParser } from "fast-xml-parser";

export const SUPPORTED_POLICIES = ["patch", "minor", "major"] as const;
export type JapicmpPolicy = (typeof SUPPORTED_POLICIES)[number];

const ELEMENT_TAGS = new Set(["class", "interface", "superclass", "method", "constructor", "field", "annotation"]);

export interface Findings {
  additive: string[];
  breaking: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type XmlElement = Record<string, any>;

function describe(tag: string, element: XmlElement): string {
  const name = element["@_fullyQualifiedName"] ?? element["@_name"] ?? tag;
  return `${tag} '${name}'`;
}

function attrBool(element: XmlElement, name: string, defaultValue: boolean): boolean {
  const value = element[`@_${name}`];
  if (value === undefined || value === null) return defaultValue;
  return String(value) === "true";
}

function attrString(element: XmlElement, name: string, defaultValue: string): string {
  const value = element[`@_${name}`];
  return value === undefined || value === null ? defaultValue : String(value);
}

/** Walks a japicmp XML report, classifying each changed member as additive or breaking. */
export function parseReport(xmlText: string): Findings {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const root = parser.parse(xmlText);

  const additive: string[] = [];
  const breaking: string[] = [];

  function walk(node: XmlElement): void {
    if (node === null || typeof node !== "object") return;

    for (const [tag, value] of Object.entries(node)) {
      if (tag.startsWith("@_") || tag === "#text") continue;

      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        if (item === null || typeof item !== "object") continue;

        if (ELEMENT_TAGS.has(tag)) {
          const changeStatus = attrString(item, "changeStatus", "UNCHANGED");
          const binaryCompatible = attrBool(item, "binaryCompatible", true);
          const sourceCompatible = attrBool(item, "sourceCompatible", true);

          if (!binaryCompatible || !sourceCompatible) {
            breaking.push(describe(tag, item));
          } else if (changeStatus === "NEW") {
            additive.push(describe(tag, item));
          }
        }

        walk(item);
      }
    }
  }

  walk(root);

  return { additive, breaking };
}

/** Returns `[isAllowed, violations]` for the given policy tier. */
export function evaluate(
  xmlText: string,
  options: { policy: string; hasMigrationDoc?: boolean }
): [boolean, string[]] {
  const { policy, hasMigrationDoc = false } = options;
  if (!(SUPPORTED_POLICIES as readonly string[]).includes(policy)) {
    throw new Error(`Unknown japicmp policy '${policy}', expected one of ${SUPPORTED_POLICIES.join(", ")}`);
  }

  const findings = parseReport(xmlText);
  const violations: string[] = [];

  if (policy === "patch") {
    violations.push(...findings.additive.map((item) => `Additive public API change not allowed for a patch release: ${item}`));
    violations.push(...findings.breaking.map((item) => `Breaking public API change not allowed for a patch release: ${item}`));
  } else if (policy === "minor") {
    violations.push(...findings.breaking.map((item) => `Breaking public API change not allowed for a minor release: ${item}`));
  } else {
    // major
    if (findings.breaking.length > 0 && !hasMigrationDoc) {
      violations.push(
        ...findings.breaking.map((item) => `Breaking public API change requires a docs/migrations/X.Y.Z.md guide: ${item}`)
      );
    }
  }

  return [violations.length === 0, violations];
}
