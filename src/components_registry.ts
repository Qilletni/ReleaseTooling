/**
 * Validation for the `release/components.yml` release-producer registry.
 *
 * Lists every onboarded release-producing component and which repositories
 * must be notified (via a dependency-dispatch payload) after it publishes.
 */

import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import type { Json } from "./release_config.js";

const COORDINATES_RE = /^[^:\s]+:[^:\s]+$/;

export function parseRegistry(text: string): Json {
  const data = yaml.load(text);
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("components.yml must contain a top-level mapping");
  }
  return data;
}

export function loadRegistry(path: string): Json {
  return parseRegistry(readFileSync(path, "utf-8"));
}

export function consumersFor(registry: Json, componentName: string): string[] {
  for (const component of registry.components ?? []) {
    if (component.name === componentName) {
      return [...(component.consumers ?? [])];
    }
  }
  throw new Error(`Component '${componentName}' not found in registry`);
}

/**
 * Returns the `group:artifact` coordinates published by a component.
 *
 * A component (e.g. `qilletni-core`) may publish more than one artifact
 * that are always released together (core+API), one dependency-dispatch
 * notification per release, listing every coordinate.
 */
export function artifactsFor(registry: Json, componentName: string): string[] {
  for (const component of registry.components ?? []) {
    if (component.name === componentName) {
      return [...(component.artifacts ?? [])];
    }
  }
  throw new Error(`Component '${componentName}' not found in registry`);
}

export function validateRegistry(registry: Json, options: { allowedRepositories?: Iterable<string> } = {}): string[] {
  const errors: string[] = [];
  const allowed = options.allowedRepositories ? new Set(options.allowedRepositories) : null;

  let components: Json[] = registry.components ?? [];
  if (!components || components.length === 0) {
    errors.push("'components' must contain at least one entry");
    components = [];
  }

  const seenNames = new Set<string>();
  components.forEach((component: Json, index: number) => {
    const prefix = `components[${index}]`;

    const name = component.name;
    if (!name) {
      errors.push(`${prefix}: missing required field 'name'`);
    } else if (seenNames.has(name)) {
      errors.push(`${prefix}: duplicate component name '${name}'`);
    } else {
      seenNames.add(name);
    }

    const repository = component.repository;
    if (!repository) {
      errors.push(`${prefix}: missing required field 'repository'`);
    } else if (allowed !== null && !allowed.has(repository)) {
      errors.push(`${prefix}: repository '${repository}' is not an onboarded release producer`);
    }

    const consumers: string[] = component.consumers;
    if (!consumers || consumers.length === 0) {
      errors.push(`${prefix}: 'consumers' must contain at least one entry`);
    } else if (allowed !== null) {
      for (const consumer of consumers) {
        if (!allowed.has(consumer)) {
          errors.push(`${prefix}: consumer '${consumer}' is not an onboarded repository`);
        }
      }
    }

    const artifacts: Json[] = component.artifacts;
    if (artifacts !== undefined && artifacts !== null) {
      artifacts.forEach((artifact: Json, artifactIndex: number) => {
        if (typeof artifact !== "string" || !COORDINATES_RE.test(artifact)) {
          errors.push(`${prefix}.artifacts[${artifactIndex}]: '${artifact}' is not a valid 'group:artifact' Maven coordinate`);
        }
      });
    }
  });

  return errors;
}
