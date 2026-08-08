/**
 * The mutable `release/platform/candidates.yml` staging file.
 *
 * Tracks the latest known-good Toolchain/QPM release composition. Unlike an
 * immutable `release/platform/X.Y.Z.yml` manifest, this file is expected to
 * change over time - but only through a reviewed PR opened by the
 * `platform-candidate-dispatch` workflow after a Toolchain/QPMCLI release,
 * or by a maintainer. It carries no `platform_version` of its own; a manual
 * "Prepare Platform Release" workflow later promotes a reviewed snapshot of
 * it into a new, immutable `release/platform/X.Y.Z.yml` (see
 * `promoteToManifest`).
 */

import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import * as platformManifest from "./platform_manifest.js";
import * as releaseEvent from "./release_event.js";
import type { Json } from "./release_config.js";

export const SCHEMA_VERSION = 1;

export function parseCandidates(text: string): Json {
  const data = yaml.load(text) as Json;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("candidates.yml must contain a top-level mapping");
  }
  for (const component of Object.values(data.components ?? {}) as Json[]) {
    if ("version" in component) component.version = String(component.version);
    const embeds = component.embeds;
    if (embeds && typeof embeds === "object") {
      for (const key of Object.keys(embeds)) embeds[key] = String(embeds[key]);
    }
  }
  return data;
}

export function loadCandidates(path: string): Json {
  return parseCandidates(readFileSync(path, "utf-8"));
}

export function toYaml(candidates: Json): string {
  return yaml.dump(candidates, { sortKeys: false });
}

export function validateCandidates(candidates: Json): string[] {
  const errors: string[] = [];

  const components = candidates.components ?? {};
  for (const required of platformManifest.REQUIRED_COMPONENTS) {
    if (!(required in components)) errors.push(`Missing required component '${required}'`);
  }

  errors.push(...platformManifest.validateComponents(components));
  return errors;
}

/**
 * Applies a validated release event to only the named component, returning a
 * new object.
 *
 * Guards against an event silently updating the wrong component: it must
 * name a component already present in `candidates`, and its `repository`
 * must match that component's already-recorded repository (in addition to
 * the component/repository pairing `release_event.validateEvent` already
 * enforces on its own).
 */
export function updateCandidateComponent(candidates: Json, event: Json): Json {
  const errors = releaseEvent.validateEvent(event);
  if (errors.length > 0) {
    throw new Error("Invalid release event: " + errors.join("; "));
  }

  const componentName = event.component;
  const components = candidates.components ?? {};
  if (!(componentName in components)) {
    throw new Error(`Component '${componentName}' is not present in candidates.yml`);
  }

  const existingRepository = components[componentName]?.repository;
  if (existingRepository && existingRepository !== event.repository) {
    throw new Error(
      `Event repository '${event.repository}' does not match candidate component '${componentName}' repository '${existingRepository}'`
    );
  }

  const updated = { ...candidates };
  const updatedComponents = { ...components };
  updatedComponents[componentName] = {
    repository: event.repository,
    version: event.version,
    tag: event.tag,
    commit: event.commit,
    asset: event.asset,
    sha256: event.sha256,
    embeds: { ...event.embeds },
  };
  updated.components = updatedComponents;
  return updated;
}

/** Builds a full `release/platform/X.Y.Z.yml` manifest from a reviewed candidates snapshot. */
export function promoteToManifest(candidates: Json, platformVersion: string): Json {
  return {
    schema_version: SCHEMA_VERSION,
    platform_version: platformVersion,
    components: { ...(candidates.components ?? {}) },
  };
}
