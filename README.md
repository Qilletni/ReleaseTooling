# Qilletni Release Tooling

Generic, dependency-light release automation for the Qilletni ecosystem. This
is a standalone repository (`Qilletni/ReleaseTooling`); it carries no release
workflows of its own - those live in `Qilletni/Qilletni` and the onboarded
release producers (`QilletniToolchain`, `QPMCLI`, `QilletniPackageUtility`,
`QilletniDocgen`).

It should be noted that unlike the rest of Qilletni, development of this release
process was assisted via AI models. This is because releasing is my least favorite
part of any project, so I wanted to dedicate my time to more meaningful parts of
Qilletni.

## How it is consumed

`Qilletni/Qilletni` embeds this repository as a **git submodule** at
`tools/release`. Every workflow that needs the tooling obtains it by checking
out `Qilletni/Qilletni` with `submodules: true` (the downstream repos additionally
`sparse-checkout: tools/release`), then runs the CLI from that submodule
directory. Because the submodule is pinned to a specific commit, a given
`Qilletni/Qilletni` commit always resolves to one exact tooling version across
all repos; updating the tooling is a change here plus a submodule-pointer bump
in `Qilletni/Qilletni`.

Written in TypeScript and run directly from source via
[`tsx`](https://github.com/privatenumber/tsx) - no build step, no compiled
output is ever committed. Runtime dependencies: `commander` (CLI parsing),
`js-yaml` (parsing `.qilletni/release.yml`, `release/components.yml` and
`release/platform/*.yml`), and `fast-xml-parser` (japicmp XML reports). Every
GitHub API/Maven Central call uses the native `fetch`.

## Running the tests

```bash
npm ci
npm test
```

## Running the CLI

```bash
npm ci
node --import tsx src/cli.ts <subcommand> ...
```

## CLI caller contract

All commands are invoked as `node --import tsx src/cli.ts <subcommand> ...`
from this repository's root - which is the `tools/release` directory when it is
mounted as a submodule of `Qilletni/Qilletni`. Every subcommand prints `OK` and exits
`0` on success; on failure it exits `1` and prints one `::error::<message>`
line per problem to stderr (consumable directly as a GitHub Actions error
annotation).

| Subcommand | Purpose |
| --- | --- |
| `validate-release-config --config .qilletni/release.yml` | Validates the repo's release configuration. |
| `validate-components-registry --registry release/components.yml [--allowed-repository REPO ...]` | Validates the release-producer registry, optionally rejecting any repository outside the onboarded set. |
| `validate-platform-manifest --manifest release/platform/X.Y.Z.yml` | Validates a platform manifest and that its filename matches its `platform_version`. |
| `read-platform-manifest --manifest release/platform/X.Y.Z.yml` | Prints each component's `repository`/`version`/`tag`/`asset`/`sha256`/`commit` as `<component>_<field>=<value>` lines, so a caller that cannot parse YAML can still read a manifest. Used by the Qilletni CLI installer's CI to cross-check its own POSIX-sh manifest parser. |
| `next-version --current-version X.Y.Z [--bump patch\|minor\|major] [--snapshot]` | Prints the computed SemVer version on stdout (simple bump, no tag lookup). |
| `latest-stable-tag` | Reads newline-separated git tags from stdin, prints the highest stable (non-prerelease) `vX.Y.Z` tag's version, or an empty line if none exist yet. |
| `next-release-version --current-file-version X.Y.Z-SNAPSHOT --bump patch\|minor\|major [--latest-stable-version X.Y.Z]` | Prints the next **release** version. Bumps from `--latest-stable-version` (the actual last published tag) when given, rather than the version-file's own value, to avoid double-incrementing an already pre-bumped `-SNAPSHOT` file. Omit `--latest-stable-version` only for the first-ever release, in which case the file's version (prerelease stripped) is used as-is. |
| `check-changelog-unreleased --changelog CHANGELOG.md` | Fails if the `## [Unreleased]` section is empty; used as an early gate before running any release-preparation steps. |
| `promote-changelog --changelog CHANGELOG.md --version X.Y.Z [--date YYYY-MM-DD] [--check]` | Promotes `## [Unreleased]` into `## [X.Y.Z] - date`, leaving a fresh empty Unreleased section. `--check` validates without writing. |
| `set-property --file gradle.properties --key qilletniVersion --value X.Y.Z` | Updates a single key in a `.properties`-style file in place. |
| `get-property --file gradle.properties --key qilletniVersion` | Prints the current value of a key. |
| `write-release-marker --marker release/pending-release.json --component NAME --from-version X.Y.Z --to-version X.Y.Z --bump patch\|minor\|major` | Writes the checked-in release marker committed by the release-preparation PR (see "Post-merge automation" below). |
| `check-release-marker --marker release/pending-release.json --expected-component NAME --expected-version X.Y.Z` | Validates a release marker matches the version actually being released. |
| `check-merge-provenance --component NAME --version X.Y.Z` | Reads a commit's associated pull requests (`GET /repos/{owner}/{repo}/commits/{sha}/pulls` JSON) from stdin and confirms one of them is a merged, `release`-labelled PR from the exact `release/<component>-<version>` branch. |
| `build-dependency-payload --component NAME --version X.Y.Z --commit SHA --repository OWNER/REPO --artifact "coords=sha256" [--artifact ... ]` | Builds and validates the JSON dependency-dispatch payload sent to consumer repositories, printed on stdout. |
| `check-japicmp-report --report path.xml --policy patch\|minor\|major [--has-migration-doc]` | Applies the public-API compatibility policy to a japicmp XML report. |
| `validate-platform-candidates --candidates release/platform/candidates.yml` | Validates the mutable platform-candidates staging file (same per-component schema as a platform manifest, minus `platform_version`). |
| `build-release-event --component toolchain\|qpm --repository OWNER/REPO --version X.Y.Z --commit SHA --asset NAME --sha256 HEX --embed "name=version" [--embed ...]` | Builds and validates a platform-component release event, printed on stdout (see "Platform candidate staging" below). |
| `update-platform-candidates --candidates release/platform/candidates.yml --event event.json [--output path]` | Applies a validated release event to only the named component in the candidates file, in place unless `--output` is given. |
| `latest-platform-version` | Reads newline-separated `release/platform/` filenames from stdin, prints the highest `X.Y.Z.yml` manifest version (or an empty line if none exist yet); ignores `candidates.yml`. |
| `promote-candidates-to-platform-manifest --candidates release/platform/candidates.yml --platform-version X.Y.Z --output release/platform/X.Y.Z.yml` | Copies a reviewed candidates snapshot into a new manifest; refuses to overwrite an existing output file. |
| `verify-live-asset-provenance --manifest path [--token GH_TOKEN]` | Re-verifies every component's `asset`/`sha256` against its live GitHub release (works against a full manifest or `candidates.yml`). |
| `verify-release-event-provenance --event event.json [--token GH_TOKEN]` | Re-verifies a release event's `tag`/`commit`/`asset`/`sha256` against the live GitHub API. |
| `validate-dependency-payload --payload payload.json --config .qilletni/release.yml` | Validates a dependency-dispatch payload against this repository's own `dependencies` mapping (component/repository/coordinate-set/version match; see "Dependency updates" below). |
| `verify-dependency-artifacts --payload payload.json` | Downloads (streamed) and hash-verifies every payload artifact against its exact Maven Central jar. |
| `apply-dependency-update --payload payload.json --config .qilletni/release.yml [--base-dir DIR]` | Validates the payload, then idempotently updates only its configured `version_file`/`version_key`; prints any changed file paths. |
| `check-resolved-dependency-versions --payload payload.json [--config .qilletni/release.yml]` | Reads a Gradle `dependencies` task text report from stdin, confirms every payload artifact resolved to exactly its declared version. With `--config`, any coordinate the matching `dependencies` entry marks `resolved: false` is excluded from the check. |

### Workflow-support subcommands

Every piece of logic a workflow needs is a first-class, independently tested
subcommand, so **no workflow ever embeds source inline** - each step is a
single `node --import tsx src/cli.ts <subcommand>` call. These commands cover
structured field reads, Maven Central polling, and manifest/baseline
resolution used by the workflow steps.

| Subcommand | Purpose |
| --- | --- |
| `read-component-metadata --config .qilletni/release.yml --component NAME` | Prints `version_file=`/`version_key=`/`changelog=`/`kind=` for a configured component. |
| `read-payload-fields --payload payload.json` | Prints a dependency-dispatch payload's `component=`/`version=`. |
| `consumers-for --registry release/components.yml --component NAME` | Prints `json=<array>`, the consumer repositories registered for a component. |
| `read-event-fields --event event.json` | Prints a release event's `component=`/`version=`/`repository=`. |
| `validate-release-event --event event.json` | Schema-validates a release event only (no live verification). |
| `read-marker-bump --marker release/pending-release.json` | Prints only the marker's `bump` field. |
| `poll-maven-central --group G --artifact A --version X.Y.Z [--max-attempts N] [--initial-delay SECONDS]` | Polls Maven Central until the coordinate's POM is mirrored. |
| `resolve-japicmp-baseline [--component NAME] [--version X.Y.Z]` | Reads release asset names from stdin, prints the exact comparable baseline jar name if (and only if) one unambiguously exists - never fabricated. |
| `resolve-platform-manifest --manifest release/platform/X.Y.Z.yml [--token GH_TOKEN]` | Resolves and live-verifies a platform manifest for the Docker workflow in one step, printing every downstream build input (`{component}_asset_url=`, `{component}_sha256=`, `{component}_version=`, `{component}_commit=`, `core_version=`, `manifest_sha256=`, `created=`). |

### Dependency-dispatch payload shape

```json
{
  "component": "qilletni-core",
  "version": "1.1.0",
  "commit": "<40-char sha>",
  "repository": "Qilletni/Qilletni",
  "artifacts": [
    {"coordinates": "dev.qilletni.impl:qilletni:1.1.0", "sha256": "<64-char hex>"},
    {"coordinates": "dev.qilletni.api:qilletni-api:1.1.0", "sha256": "<64-char hex>"}
  ]
}
```

This is the exact `client-payload` body dispatched (via a short-lived GitHub
App installation token, see the root `RELEASE.md`) to every repository listed
as a consumer of the released component in `release/components.yml`. Core and
API are a single release unit (one `qilletni-core` registry entry, released
together at the same version), so a release always dispatches **one** payload
listing both artifact coordinates - never two separate dispatches.

### Dependency updates

A repository that consumes another onboarded component (e.g. `QilletniToolchain`
consuming `qilletni-core`) declares this in its own `.qilletni/release.yml`,
alongside its own `components`:

```yaml
dependencies:
  - upstream_component: qilletni-core   # matches a dependency-dispatch payload's 'component'
    repository: Qilletni/Qilletni       # must match the payload's 'repository' - guards against a spoofed producer
    coordinates:                        # the exact 'group:artifact' set this payload must contain - no more, no less
      - dev.qilletni.impl:qilletni
      - dev.qilletni.api:qilletni-api
    version_file: gradle.properties     # the ONE local file/key both coordinates above map to
    version_key: qilletniCoreVersion
```

`dependencies` is entirely optional - a pure release producer with nothing of
its own to consume (like this repository) declares none, and
`validate-release-config` still passes.

Multiple coordinates may map to a single `version_file`/`version_key` (as
above, mirroring how core+API are released together as one unit), but a
coordinate may never be declared by more than one `dependencies` entry
(rejected as a "duplicate mapping"), and `version_file` is validated as a
safe relative path (no leading `/`, no `..` segment) - never resolvable
outside the checkout.

A coordinate entry may also be a mapping with an optional `resolved: false`
flag (default `true`), for a consumer that doesn't actually place every
notified artifact on its own classpath - e.g. `QPMCLI` only consumes the API
half of the atomic core+API unit:

```yaml
dependencies:
  - upstream_component: qilletni-core
    repository: Qilletni/Qilletni
    coordinates:
      - dev.qilletni.api:qilletni-api
      - coordinate: dev.qilletni.impl:qilletni
        resolved: false   # still mandatory + hash-verified, but never expected on QPM's classpath
    version_file: gradle.properties
    version_key: qilletniCoreVersion
```

A `resolved: false` coordinate is still required in the payload, still
hash-verified live against Maven Central, and still coupled to the same
`version_file`/`version_key` as every other coordinate in that entry - it is
only excluded from step 6 below (the resolved-dependency-graph presence
check). At least one coordinate per `dependencies` entry must remain
`resolved: true` (all-unresolved is rejected as invalid).

Right after a producer publishes, its `reusable-dependency-dispatch.yml`
sends a `repository_dispatch` event named `qilletni-dependency-release` to
every registered consumer, with the exact payload shape shown above
("Dependency-dispatch payload shape"). The receiving side
(`reusable-dependency-update.yml`, invoked by each consumer's own local
caller - see `examples/dependency-update.yml`):

1. Schema-validates the payload (`dependency_payload.validatePayload`).
2. Validates it against the consumer's own `dependencies` mapping
   (`validate-dependency-payload`): the payload's `component` must be
   configured, its `repository` must match exactly (never a spoofed
   producer), its `version` must be a stable release (never `-SNAPSHOT` or a
   dynamic version), and its artifact coordinate set must match the
   configured set exactly - no missing, no extra, and every artifact must
   agree with the payload's own declared `version` (guarding a divergent
   version silently reaching the same local key).
3. Re-verifies every artifact live against Maven Central
   (`verify-dependency-artifacts`) - downloads the exact jar (streamed, never
   buffered whole in memory) and confirms its SHA-256 matches the
   payload-declared digest - **before any file is touched**.
4. Applies the update (`apply-dependency-update`): writes the payload's
   version into *only* the one configured `version_file`/`version_key` -
   never a payload-supplied path or command - and is idempotent (a no-op,
   not an error, if that key is already at the target value).
5. Refreshes the consumer's Gradle dependency locks (sibling composite
   builds explicitly disabled) and runs its full test suite plus its
   `checkNoSnapshotDependencies` stable-dependency guard (see `build.gradle`
   in this repository for the convention a consumer is expected to adopt).
6. Confirms the resolved dependency graph really contains the requested
   version(s) (`check-resolved-dependency-versions --config .qilletni/release.yml`,
   fed the text output of Gradle's own `dependencies` task) - guarding
   against a transitive conflict silently overriding the version just
   requested. Any coordinate the consumer's own config marks
   `resolved: false` is skipped here (it was still validated/hash-verified
   in steps 2-3, and its version still updated in step 4).
7. Opens a signed PR (GitHub App token, `peter-evans/create-pull-request@v8`).
   **This PR never auto-merges.**

### Platform candidate staging and the release-event payload

`release/platform/candidates.yml` tracks the latest known-good Toolchain/QPM
release composition, in the exact same per-component shape as a platform
manifest (minus `platform_version`), but it is mutable - **only through a
reviewed PR**, never a direct push.

Right after QilletniToolchain or QPMCLI publishes a release, its own workflow
sends a `repository_dispatch` event named `qilletni-platform-component-release`
to this repository, with this exact `client_payload` shape (`release_event.ts`):

```json
{
  "schema_version": 1,
  "component": "toolchain",
  "repository": "Qilletni/QilletniToolchain",
  "version": "1.0.2",
  "tag": "v1.0.2",
  "commit": "<40-char sha>",
  "asset": "qilletni-1.0.2.tar.gz",
  "sha256": "<64-char hex>",
  "embeds": {"core": "1.0.2", "api": "1.0.1", "pkgutil": "1.0.1", "docgen": "1.0.1"}
}
```

(`component` is `"toolchain"` or `"qpm"`; `repository` must be exactly the
repository that owns that component - `Qilletni/QilletniToolchain` or
`Qilletni/QPMCLI` respectively - guarding against a mismatched or spoofed
component/repository pairing. `asset` is validated as a plain filename: no
path separators, no `..`, and no shell metacharacters, so it is never treated
as - or able to resolve to - a filesystem path, nor carries any executable
content of its own.)

The receiving workflow (`.github/workflows/platform-candidate-dispatch.yml`):

1. Schema-validates the event (`validate-release-event`).
2. Re-verifies its `tag`/`commit`/`asset`/`sha256` claims live against the
   GitHub API (`verify-release-event-provenance`) - the event is never
   trusted at face value.
3. Updates *only* the named component's entry in `candidates.yml`
   (`update-platform-candidates`), also refusing an event whose `repository`
   disagrees with that component's already-recorded repository.
4. Opens a signed PR (GitHub App token, `peter-evans/create-pull-request@v8`).
   **This PR never auto-merges.**

A maintainer later runs the manual `Platform - Prepare Release` workflow
(`platform-prepare.yml`, `workflow_dispatch` with a required `patch`/`minor`/
`major` `bump` choice) to promote a reviewed `candidates.yml` snapshot into a
new, immutable `release/platform/X.Y.Z.yml`:

- The next platform version is computed from the **latest existing
  `release/platform/X.Y.Z.yml` file** (`latest-platform-version`), never from
  an individual component's own version - a platform bump is a distinct,
  user-visible distribution decision.
- It refuses to run if the target `X.Y.Z.yml` already exists.
- It re-verifies `candidates.yml`'s commits/assets live one more time
  immediately before promoting it, then opens its own signed,
  never-auto-merging PR.

### Post-merge automation and the release marker

Merging a `release/<component>-<version>` PR to `master` does **not** require
a maintainer to push the `vX.Y.Z` tag by hand. The release-preparation PR
also commits `release/pending-release.json` (via `write-release-marker`)
alongside its version/changelog changes. On every push to `master`, the
publish workflow:

1. Reads the component's version file. If it is still a `-SNAPSHOT`, this is
   an ordinary commit (or the post-release follow-up already resumed
   snapshot development) and nothing further happens here.
2. Otherwise, it requires `release/pending-release.json` to be present and
   validates it (`check-release-marker`) against the version that just
   landed, then confirms provenance (`check-merge-provenance`) - the commit's
   associated pull request must be the genuine, merged, `release`-labelled PR
   from the exact `release/<component>-<version>` branch, so an unrelated PR
   cannot spoof a release merge.
3. It then idempotently creates (or verifies) the immutable `vX.Y.Z` tag at
   that exact commit, which triggers the actual publish job (see the root
   `RELEASE.md`). A direct `git push` of a `vX.Y.Z` tag is preserved only as a
   manual recovery path if this automation ever fails.

The release marker also makes the `patch`/`minor`/`major` bump kind
recoverable at publish time without depending solely on a Maven Central
lookup of the previous version (see `read-marker-bump`).

### Published-artifact verification (`artifact_verify.ts`)

Not exposed as its own CLI subcommand for most callers (`poll-maven-central`
wraps the common case), but available as a library:

- `pollUntilAvailable(check, {url, maxAttempts, initialDelay, backoffFactor})`
  retries `check(url)` with exponential backoff until it stops throwing
  `PollTransientError`, used to wait for Maven Central to mirror a release
  before notifying downstream consumers.
- `verifySha256(path, expectedSha256)` verifies a downloaded file's hash.
- `findAssetSha256(releaseJson, assetName)` extracts a GitHub release
  asset's SHA-256 digest, used by the Docker workflow to confirm the exact
  asset pinned in `release/platform/X.Y.Z.yml` before downloading it.
- `verifyTagDereferencesToCommit(refJson, expectedCommit, {tagObjectJson})`
  confirms a platform manifest's pinned `tag` really points at its pinned
  `commit` (handling both lightweight and annotated GitHub tags).
- `fetchGithubRelease` / `fetchTagRef` / `fetchGitTagObject` /
  `fetchCommitPullRequests` are thin `fetch`-based GitHub API wrappers used
  by the workflows above.

## Module map

- `semver.ts` - SemVer 2.0.0 parsing/compare/bump, `latestStableTag()` and
  `nextReleaseVersion()` for release-preparation, `nextSnapshot()` for the
  post-release `X.Y.(Z+1)-SNAPSHOT` follow-up PR.
- `changelog.ts` - Keep a Changelog `Unreleased` section promotion.
- `release_config.ts` - `.qilletni/release.yml` schema validation. A `maven`
  component declares an `artifacts` list (each with its own `maven.group`/
  `artifact` and `japicmp` block), so a component that publishes more than one
  artifact together (e.g. `qilletni-core`, covering both `qilletni` and
  `qilletni-api`) is modelled as a single release unit.
- `release_marker.ts` - the checked-in `release/pending-release.json` marker:
  build/validate it, and confirm a merge's provenance against a genuine
  release-preparation PR.
- `version_files.ts` - in-place `.properties` file editing.
- `dependency_payload.ts` - dependency-dispatch payload schema/build.
- `dependency_update.ts` - the consumer side of a dependency update: matches a
  payload's `component` against a repository's own `dependencies` mapping,
  validates it (spoofed repository, missing/extra/malformed coordinate,
  divergent per-artifact version, SNAPSHOT/dynamic version), plans/applies
  the single idempotent metadata update, and re-verifies every artifact live
  against Maven Central (`verifyPayloadArtifactsAvailable`).
- `resolved_graph.ts` - parses a Gradle `dependencies` task text report and
  asserts specific coordinates resolved to exactly the expected version,
  guarding against a transitive conflict silently overriding a requested one.
- `platform_manifest.ts` - `release/platform/X.Y.Z.yml` schema validation,
  including each pinned component's exact `commit` and the dependency
  versions it `embeds`; also `latestPlatformVersion()` (scans
  `release/platform/` filenames for the highest existing manifest) and
  `verifyLiveAssetProvenance()` (re-checks `asset`/`sha256` against a live
  GitHub release).
- `release_event.ts` - the immutable platform-component release-event
  payload schema (schema/component/repository-pairing/asset-path-safety
  validation) sent by Toolchain/QPM, plus `verifyLiveProvenance()`.
- `platform_candidates.ts` - the mutable `release/platform/candidates.yml`
  staging file: parse/validate it, apply a validated release event to only
  the named component (`updateCandidateComponent`), and promote a reviewed
  snapshot into a new platform manifest (`promoteToManifest`).
- `components_registry.ts` - `release/components.yml` schema validation.
- `artifact_verify.ts` - hash verification (including streamed remote
  SHA-256 verification via `verifyRemoteSha256`), Maven Central URL
  building (POM and jar), tag/commit verification and published-artifact
  polling.
- `resolve_japicmp_baseline.ts` - decides whether a comparable,
  previously-published baseline jar exists for a japicmp comparison (never
  fabricated); used by `QilletniToolchain`'s `toolchain-logging` release gate.
- `cli.ts` - the command-line entry point described above, built with
  `commander`. Exports `main(argv)` (used directly by the test suite) as well
  as the script entry point.
