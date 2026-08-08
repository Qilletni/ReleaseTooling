/**
 * Decides whether a comparable, previously-published baseline jar asset
 * exists on a prior GitHub release, so the release workflow never
 * fabricates a japicmp baseline out of thin air.
 *
 * Historically, `toolchain-logging` was only ever embedded inside the
 * shadowed `QilletniToolchain.jar` - no release has ever published a
 * standalone `toolchain-logging-X.Y.Z.jar` asset of its own. Once one
 * exists on a prior release, this resolves it as the baseline for the next
 * comparison.
 */

/**
 * Returns the exact matching baseline asset filename, or `null` if no
 * single unambiguous, comparable artifact exists yet (never guessed).
 *
 * If `version` is given, only that exact `{component}-{version}.jar` is
 * accepted. Otherwise, a baseline is only returned if exactly one
 * `{component}-X.Y.Z.jar` asset is present (an ambiguous match is treated
 * the same as no match, rather than picking arbitrarily).
 */
export function findBaselineAsset(
  assets: string[],
  options: { component?: string; version?: string | null } = {}
): string | null {
  const { component = "toolchain-logging", version = null } = options;
  const escaped = component.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}-(\\d+\\.\\d+\\.\\d+)\\.jar$`);
  const matches = assets.filter((asset) => pattern.test(asset));

  if (version !== null) {
    const exact = `${component}-${version}.jar`;
    return matches.includes(exact) ? exact : null;
  }

  if (matches.length === 1) return matches[0];

  return null;
}
