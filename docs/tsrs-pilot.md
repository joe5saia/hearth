# Main typechecker migration and tsrs pilot evidence

`npx task typecheck` now runs **tsrs** against the existing root `tsconfig.json`.
The accepted developer-platform scope is Linux x64/arm64 GNU/musl and Apple Silicon.
tsrs remains experimental and never silently falls back to tsc. TypeScript **7.0.2**
is retained for explicit comparison and tooling, including Alchemy's nested TS6.

## Exact gate scope

- `npm run check` is `tsrs --noEmit --project tsconfig.json`.
- `npx task typecheck` calls that script. The aggregate `npx task check` still
  runs typecheck, lint, formatting, then integration tests, stopping on failure.
- Ubuntu deployment CI still calls `npx task typecheck` before tests/deployment;
  its step label now names tsrs. No workflow execution or deployment is part of validation.
- `npx task typecheck:tsc` runs the retained incumbent command
  `tsc --noEmit --project tsconfig.json`; it is a comparison, not a second CI gate.
- The root config is unchanged: it includes `src`, tests, Alchemy/Vite config,
  matching evaluation, MCP Preview, production-data/recipe-import smoke, feedback secrets, and
  transitive imports. This changes the compiler, not the set of checked files.
- `npx task typecheck:tools` remains **tsc** against `tsconfig.tools.json`.
  It is not migrated, waived, or added to CI. Its earlier source/declaration bugs
  were repaired independently on main; this migration makes no tooling-source fixes.
- Vite builds, Effect/React/Workers integrations, Node-executed tooling, emit,
  runtime dependencies, and both tsconfigs remain unchanged.

### Cache safety

The root config has no `extends`; tools extends only that root. Neither enables
`incremental`, `composite`, or `tsBuildInfoFile`. No command adds `--incremental`,
`--composite`, `-b`, or `--build`. Both compilers/configs remain nonincremental;
there is no build-info cache to share. If caching is introduced, isolate paths
by **both compiler and config**, never just by compiler or by main/tools alone.

## Reproduce

Use Linux x64/arm64 (GNU or musl) or Apple Silicon, Node as pinned in
`.node-version`, and installed optional dependencies. Only Linux x64 GNU was
exercised here. Native Windows and Intel Mac binaries are unavailable.

```sh
npx task install
npx task typecheck
npx task typecheck:tsc
npx task ui:setup
npx task typecheck:tools
```

The last command remains a separate check, not a newly required gate.
`ui:setup` installs external
browser tools/declarations under `/tmp/hearth-ui`, not into the application.

In a disposable checkout, **serially with no editor, watcher, build, or test run**:

```sh
npx task typecheck:pilot -- /tmp/hearth-tsrs-report.json
npx task check
npx task build
git diff --check
git status --short
```

The pilot task invokes the installed compiler launchers with `--noEmit --pretty
false --project <config>`, collects `--listFilesOnly`, runs eight alternating-order
fresh processes per compiler under GNU `/usr/bin/time -f '%e %M'`, then exercises
intentional errors through the real CLIs. It writes a JSON report with complete
normalized path lists, multiline diagnostics, raw exit codes, samples, and restored
file hashes. It also injects a domain error through `npm run check`, the exact CI
command `npx task typecheck`, and aggregate `npx task check`, requiring nonzero exits
and the real tsrs diagnostic, with downstream lint/test tasks not run. Without an
output argument it prints a temporary report path.
GNU `time` must be installed at `/usr/bin/time`; macOS needs that harness adjustment.

The task **temporarily appends to six existing source files** and creates two
reserved probe paths (`src/__tsrs_pilot__.tsx`, `tools/__tsrs_pilot__.ts`). It refuses
to overwrite existing probes. `finally` restores original bytes and deletes probes
on ordinary failures; signals and power loss may bypass cleanup. Inspect the diff
after any interrupted run. It is a compiler integration experiment, not an added
application unit-test suite, and is not included in `check` or CI.

## Verified provenance (2026-10-20)

The clean starting checkout and fetched `origin/main` both matched
[`218b2c2`](https://github.com/joe5saia/hearth/commit/218b2c25c70a7818aae1938b3eab861dfee2e006),
with 119 tracked TS-family files. The harness adds one tooling file. This checkout
used Node 26.10.0, npm 10.9.9, Linux x86_64, glibc 2.36, and four available CPUs
(Intel Xeon 2.60 GHz in an orb).

Before installation, live npm metadata and the following sources confirmed the
exact devDependency `tsrs@0.18.0-ts7.1.0-dev.20260929`:

- [Cloudflare announcement](https://blog.cloudflare.com/typescript-rust-port/)
- [Release v0.18.0](https://github.com/oxc-project/tsrs/releases/tag/v0.18.0)
- [Release-pinned compatibility](https://github.com/oxc-project/tsrs/blob/v0.18.0/docs/COMPATIBILITY.md)
- [Release-pinned package/API metadata](https://github.com/oxc-project/tsrs/blob/v0.18.0/npm/tsrs/package.json)
- [Published registry metadata](https://registry.npmjs.org/tsrs/0.18.0-ts7.1.0-dev.20260929)

The lockfile integrity is
`sha512-9T0b4Uam/yMFIK16GUx0fUrJqYZnJ/gvSmV9JB8NTyDePvwCI45WFWxyEV/UMV3KfdNRJG/PBsm3fSIB9WmWsA==`.
The installed binary reports TS **7.1.0-dev.20260930.4**, tsrs 0.18.0, upstream
[microsoft/TypeScript at b85298b6a81f](https://github.com/microsoft/TypeScript/commit/b85298b6a81f772d080b0455de0ca9d744cd6fd6).
The date difference from the npm version is
documented upstream. This is not the TS5/6 compiler API; no package alias, API
migration, runtime substitution, language-server change, or emit migration is made.

## Original-base coverage and diagnostics

Before rebasing onto the separately shipped tools fixes, both compilers enumerated
identical normalized paths:

| Config                    | First-party files | External files | Compiler libraries | Total |
| ------------------------- | ----------------: | -------------: | -----------------: | ----: |
| Main                      |                58 |          1,686 |                 65 | 1,809 |
| Tools (including harness) |                52 |            638 |                 65 |   755 |

Only the checkout prefix and compiler-library installation directories are
normalized. TS7 libraries live in `@typescript/typescript-<platform>/lib`; tsrs
libraries live in `@tsrs/<platform>`. Source/dependency paths and library filenames
remain significant. Matching library names do **not** establish matching contents;
`skipLibCheck` remains enabled. Coverage includes transitive imports, not just
the tsconfig's initial include set or the tracked-file inventory.

All ten control scenarios passed their diagnostic and accept/reject assertions:

- Independent string-to-number errors in domain, React entrypoint, Worker server,
  API integration tests, Vite config, and the included MCP Preview tool: each
  compiler reports the same single TS2322 at the same file/start position.
- Positive `.ts` Bundler import, Effect branded recipe ID decoding, JSX button,
  DOM Request, and Workers `ExecutionContext.waitUntil`: both accept.
- Strict null, unvalidated branded ID, wrong JSX prop, wrong Workers argument,
  and missing imported module: both report the same five full diagnostics
  (TS2322 ×3, TS2345, TS2307).
- An invalid tools-only file is ignored by main and adds exactly one matching
  TS2322 under the tools config, preserving each compiler's baseline failures.

Diagnostics are compared as sorted **whole multiline blocks**, preserving full
message text, TS code, file, and start line/column. Stderr must be empty. Both
clean main checks return zero. **Error exit codes differ: tsc returns 1, tsrs 2**
on the observed tools failures and intentional errors. Accept/reject agrees, but
this is not exact CLI exit-code parity. The report retains those raw codes.

The original tools baseline initially had 18 tsc diagnostics; installing the existing
`ui:setup` prerequisite reduced that to **12**. Both compilers then report the
same 12 locations/codes: plugin `project` option, Headers incompatibility, feedback
smoke implicit-any/optional-string errors, and navigation branded-ID errors.
Nine whole messages match. **Three differ** at `tools/navigation-smoke.ts`
498:33, 498:104, and 499:88: TS7.0.2 infers the branded-ID branch, whereas tsrs's
TS7.1-dev diagnostics infer the UUID template-literal branch. Neither accepts
the code. Do not suppress these differences or claim full tools parity. A
same-upstream-commit Go comparison is needed to distinguish a TypeScript version
change from a Rust-port discrepancy; this pilot does not establish that cause.

Original source bytes were restored, hashes recorded, temporary probes removed,
and both configs rechecked against their pre-probe results.

## Original-base performance: TS7, not CloudLatch's TS6 baseline

Main config, default adaptive worker counts, installed CLI launchers, seconds and
peak RSS in KiB. First means first **measured** process, after correctness and
coverage runs had already warmed filesystem caches. Subsequent is the median
of the next seven independent processes, not an in-process warm compiler.

| Compiler                      | First seconds | First RSS KiB | Subsequent median seconds | Subsequent median RSS KiB |
| ----------------------------- | ------------: | ------------: | ------------------------: | ------------------------: |
| TypeScript 7.0.2 (native Go)  |          2.15 |     1,038,964 |                      2.15 |                 1,054,596 |
| tsrs 0.18.0 (TS7.1-dev, Rust) |          0.32 |       313,888 |                      0.33 |                   312,572 |

Subsequent medians: about **6.5× faster and 70.4% less peak RSS** in this orb.
Raw elapsed samples, in per-compiler run order:

- tsc: `2.15, 2.10, 2.02, 2.15, 2.27, 2.16, 2.16, 2.04`
- tsrs: `0.32, 0.32, 0.32, 0.32, 0.33, 0.34, 0.35, 0.35`

No npm/npx/Task startup is timed; each compiler's Node CLI launcher is included.
These are fresh-process, nonincremental checks, not true OS-cache-cold runs.
No cache dropping, persistent compiler, watch, incremental build, equal-worker
benchmark, or CI speed guarantee is claimed. Different TS revisions, standard
libraries, and adaptive scheduling confound a pure Rust-versus-Go comparison.
CloudLatch's TS6 result is neither this baseline nor a forecast for other repos.

## Original optional-pilot validation

Before the pilot: required typecheck, all **108 integration tests in nine files**,
and production build passed. The separate tools failure was observed before
pilot source/config changes. No existing dependency versions changed in the lockfile.

After a clean `npx task install` (`npm ci`), `npx task check` passed typechecking,
lint, formatting, and the same **108/108 integration tests**. `npx task build`
and the then-optional tsrs main task passed; the tools checks retained the same 12
diagnostics and three message differences, with no diagnostics in the new harness.
Repeating the complete pilot after that clean install produced identical coverage,
baseline diagnostics, control results, and restored hashes. Its second timing
series is not substituted for the primary measurements above.
The main bundle's filename changed because the unchanged Vite configuration embeds
`git describe --always --dirty`; the initial clean build and later dirty build
have different version strings. A build control with the original version restored
the original JS asset name and size (`index-Cs4XQggO.js`, 479.48 kB):

```sh
TELEMETRY_VERSION="$(git rev-parse --short HEAD)" npx task build
```

No byte-identical bundle claim is made.

## Main-gate promotion and rollback

The accepted Linux/Apple-Silicon scope permits promoting only the existing main
check. The observed error exit-code difference (tsc 1, tsrs 2) is not hidden:
npm and Task must propagate failure rather than depend on an identical integer.
The original tools failures and message differences above are historical; the
independent repair shipped in
[`a10231e`](https://github.com/joe5saia/hearth/commit/a10231eced16dabb7e88c2f830514a966aafe7be).
Neither clean checks nor those original differences establish full compiler
equivalence. Repeat qualification on any upgrade.
LSP, content mappers, project-reference builds, TS5/6 APIs, other platforms, and
tools-check migration are outside this gate change.

Initial promotion validation on the original base, Linux x64 GNU:

- The full compiler harness again matched all 1,809 main paths, all ten controls,
  and original source hashes. Tools coverage remained 755 paths and its existing
  12 diagnostics/three message differences were unchanged.
- With the intentional domain error, `npm run check` exited 2; the exact CI
  `npx task typecheck` and aggregate `npx task check` exited 201 (Task's wrapper
  exit), both reporting the underlying tsrs exit 2. The aggregate stopped before
  lint, formatting, or tests. No deployment workflow was triggered.
- After restoration, `npx task check` passed the promoted tsrs gate, lint,
  formatting, and **108/108 integration tests in nine files**.
  `npx task typecheck:tsc` and `npx task build` also passed.
- `npx task typecheck:tools` still failed with the original 12 tsc diagnostics;
  no failure was hidden, ignored, or converted to success by its task.
- Both configs and their inheritance remained unchanged and nonincremental;
  no `.tsbuildinfo` appeared in the inspected first-party project tree.

### Rebased combined validation

The migration was rebased onto the shipped tools repair above, preserving both
`@ampcode/plugin@0.0.0-20261010103843-g390d027` and the tsrs manifest/lockfile
additions. No tools repair files were copied from another checkout. Newer recipe
import source, dependency, and root-config include changes already on main were
also preserved; this migration has no tsconfig diff against that base.

After a clean `npx task install`, the combined checkout passed:

- `npx task check`: the tsrs main gate, lint, formatting, and **110/110 integration
  tests in nine files**.
- `npx task typecheck:tsc`, `npx task typecheck:tools`, and `npx task build`.
- The complete compiler harness: **1,811 identical main paths** (59 first-party,
  1,687 external, 65 compiler libraries) and **757 identical tools paths**
  (53 first-party, 639 external, 65 compiler libraries). Both compilers returned
  zero diagnostics and exit 0 on both configs. The original tools failures and
  message differences no longer occur on the repaired source.
- All ten positive/intentional-error controls and the three public gate-failure
  checks, followed by source-byte restoration and probe removal. Error exits
  remained tsc 1, tsrs 2, with npm/Task propagating tsrs failure.
- The unchanged nonincremental cache configuration and inheritance for main/tools;
  no first-party build-info file was produced.

The tools gate still uses tsc; observing tsrs tools parity in the harness does not
promote that separate gate or broaden required CI checks.

To roll back the main gate, change `package.json`'s `check` to
`tsc --noEmit --project tsconfig.json`, and restore the Task/CI descriptions to
name TypeScript rather than tsrs. The existing task and CI command immediately
use tsc again. Keeping tsrs installed for comparison is harmless; no config,
cache, application source, or runtime state needs restoration. To remove the
experiment entirely, also remove its comparison/harness tasks, harness, notes,
and tsrs-only manifest/lockfile entries while retaining TypeScript dependencies.
Then run `npx task install`, `npx task check`, and `npx task build`. Do not revert
unrelated work, including the independently shipped tools repair and SDK pin.
No shipping, production deployment, or data migration is included.
