# Real-graph strict snapshot declaration conformance harness — r2

Scratch only, prepared for independent review. No repository changes, dependency installation, network, profile access or native wallet execution. Existing declaration/consumer assignability is checked; **JavaScript implementation typechecking is not enabled (`allowJs:false`, `checkJs:false`)**. The runtime adapter/bridge tests and future genuine native probe are separate evidence.

## Actual compiler and graph

Uses Cursor's existing TypeScript 6.0.3 full compiler API. The bundled tsc CLI file is absent. Before compiling, the harness verifies the discovered compiler entry/package, Node executable and all 58 standard library hashes from the prior discovery report. That report's exact hash is embedded. No `npx`, global install or new repository dependency.

The input is the actual imported `scripts/fixtures/railgun-kohaku-snapshot-contract.d.ts`. Aliases point to actual source files in Kohaku commit `6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e`: `~/*` to plugin source, `@kohaku-eth/provider` to the provider's real index/tx/provider source. Host index pulls its actual memory-storage and mnemonic-keystore source into the graph too; these are typechecked, **never executed**. `ox`, scure, noble, abitype and other transitive types resolve through actual installed package exports. No ambient module/any stubs, casts, diagnostic suppression directives or third-party edits.

This is **not an upstream lockfile build**. In particular the pinned provider source requests ox `^0.12.0`, while this existing installation supplies ox **0.14.45**. Root scure/bip32 is 1.4.0 and scure/bip39 is 2.4.0; additional nested versions are bound through their loaded package metadata/source hashes. The result applies to the exact resolved type graph, not all versions in upstream ranges or an uninstalled upstream dependency set.

Options: strict, noEmit, noEmitOnError, skipLibCheck:false, skipDefaultLibCheck:false, noImplicitOverride, noPropertyAccessFromIndexSignature, noFallthroughCasesInSwitch, noUncheckedIndexedAccess, ES2022, ESNext/Bundler matching upstream resolution style, explicit ES2022+DOM libraries, and no automatic ambient types. The complete compiler options are in SOURCE-FREEZE.json. No deprecation ignore option or any substitute checker is used.

## Results awaiting independent harness review

- Positive fixture: zero diagnostics. The imported SnapshotReadPlugin is assignable to the **actual** PinnedReadTarget and consumer arrays are mutable. Factory/options/read fields/provenance are checked. Upstream notes remains optional; the adapter's notes method is required. No reverse assignability claim is made for every upstream instance.
- **24 unsuppressed negative programs**, each produces its exact expected code, exact file/line/character, and distinguishing message. Controls cover missing identity/notes, wrong balance/note shapes, all six forbidden preparation methods plus the upstream feature-empty target, number amount/string token ID, readonly result arrays, async capture/current, false current return, wrong provenance/spent marker/includeSpent, generic Host assignment and generic factory assignment.
- Every program resolves **220 source/declaration files** (219 shared graph files plus its own case). The graph map must be identical across cases after excluding that case root. SOURCE-FREEZE.json binds **274 files**, including all cases, scripts, metadata, configuration, repository package/lock and compiler inputs. The harness verifies hashes before and after its run and rejects an added case filename. Compiler reads must match the pinned map; new/mutated resolution inputs refuse.
- Compiler emission writes: zero. Compiler graph source is never executed; typed positive examples intentionally demonstrate type-level template/range limitations, not valid runtime wallet data.
- `prepare.log` and `run.log` record original compiler API process exits 0 as observed by the task tool. `REPORT.json` has zero unexpected cases and full negative diagnostics. Scoped `lint.log` covers harness.cjs with root ESLint configuration, warning limit zero. This is not full repository lint or tests.


## R2 review corrections and exact provenance

R1 remains immutable, PACKAGE SHA `2de4266ea76e7ced580c347c7a058f3d8aaf859ea844564cde94610319d0f8e1`. R2 adds a positive `PICapCfg<Caps> extends PICapabilities` assertion and binds the constructed value to actual `PluginInstance<string,Caps>`. Two new negatives fail the actual upstream generic capability constraint: ERC1155 is outside AssetId, and number is not bigint.

Negative categories are explicit in CASE-SPEC and REPORT: **9 upstream-binding controls and 15 Freedom-declaration controls**. The upstream-binding note control checks the supplied Freedom ReadNote specialization through PluginInstance; upstream PICapabilities.note itself is unknown, so it does not independently promise Freedom's concrete note fields. Requiring notes() and its concrete ReadNote output remains the adapter's own declaration guarantee.

Every `~/` module resolution asserts that its containing source is under the actual plugins/src directory. Provider and similarly-prefixed sibling origins are distinguishing rejected controls. Actual alias resolutions are recorded and compared across all programs; this prevents silently applying the plugin alias to a future provider import.

Observed root HEAD: `c03cbd384ed6b0968432f890530e1fe1fc5b0452`; snapshot declaration Git status was clean. Observed upstream HEAD: `6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e`. All eight actually loaded upstream graph source files are compared byte-for-byte by SHA256 with `git show 6fdc248b...:<path>` on prepare and verification; paths/hashes are included in SOURCE-FREEZE/REPORT. The declaration hash remains `e8d17a0c103be64ff2d9e44e6ce0324437cbd73e544da4e784a603b566492792`. No src/scripts files or declaration comments changed. Their earlier syntax-only comments are historical; this separate reviewed typechecking evidence must not be confused with runtime fixture flags or a checkJs claim.

All 25 programs completed with the expected diagnostics. The two compiler API processes exited 0. No third-party source was edited, no diagnostic was suppressed, and no negative merely relies on an unrelated dependency error. Runtime JS implementation typechecking remains false.

## Reproduction and preservation

`node harness.cjs run` verifies the existing SOURCE-FREEZE and repeats the checks; preserve this reviewed package before any edits. `prepare` is only for a new disposable revision: it refuses to overwrite SOURCE-FREEZE. It emits complete positive-graph diagnostics before refusing any graph failure, rather than patching dependencies or suppressing errors. The earlier graph-probe files and first package are preserved in <PRIOR_R1_PRIVATE_DIRECTORY>, not substituted for the full 25-program r2 run. Each r2 compiler result is also retained under case-diagnostics/ before graph/result assertions, preserving unexpected diagnostics if a future reviewed run refuses. The curated PACKAGE manifest includes the complete inputs and aggregate result; those redundant per-case graph dumps remain scratch diagnostics, not required archived payloads.

Paths are fixed to the current reviewed checkout and compiler installation. Copying the harness to another checkout requires a new reviewed resolution/freeze, not rewriting a source pin silently. Compiler/editor updates must be repinned; no version-string-only acceptance.

What this establishes after review: declaration/consumer assignability and meaningful restricted-interface exclusions for this exact installed graph. It does not establish runtime implementation type soundness, ownership, canonicality/finality, POI, spending, recipient authority, generic upstream Host implementation or browser/package portability. Snapshot callback currency and data authenticity remain runtime matters. Previously recorded parser-only tests retain their historical scope.
