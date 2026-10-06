# Five-factory Railgun–Kohaku Node prototype evidence

This archive records the restricted standalone Node prototype after adding the public Shield adapter and separate submitter to the snapshot/private factories. “Public” describes the Shield operation: this is an unpublished local prototype and an inspectable evidence archive, not an installable release or a fully self-contained reproduction kit.

All 29 final artifact files appear once under [artifact](artifact/), including runtime, wrappers, declarations, licenses and covered source. Payloads have `.txt` suffixes to preserve hash-bound bytes through documentation tooling. Machine-local paths in selected recipes/reports are normalized only by recorded literal substitutions; source, runtime and declarations otherwise retain exact original bytes. [ARCHIVE-MAP.json](ARCHIVE-MAP.json) maps each original input to its published file, original/published hashes and byte lengths, and explicit transformations. Original hashes embedded in derived reports still refer to original raw files. [PUBLICATION-HASHES.json](PUBLICATION-HASHES.json) hashes the archive files rather than pretending transformed reports retain their original hashes.

## What was checked

| Evidence | Actual scope | Records |
| --- | --- | --- |
| Runtime assembly | Two reproducible 21-file runtime-only artifacts, five exports, reviewed restricted dependency graph | [Build report](runtime-build/build-a/BUILD-REPORT.json.txt), [reproducibility](runtime-build/REPRODUCIBILITY.json.txt), [runtime-only inventory](runtime-build/ARTIFACT-INVENTORY.json.txt) |
| Runtime consumers | 137 matrix executions across CJS/ESM/mixed, plus snapshot/private baseline checks; three deliberate sticky-trap commands failed as intended | [Scope](runtime-consumers/README.md.txt), [verification](runtime-consumers/VERIFIED-RESULTS.json.txt), [original exits](runtime-consumers/OBSERVED-EXITS.json.txt), [matrix](runtime-consumers/matrix.cjs.txt) |
| Portable declarations | Strict TypeScript 6.0.3: three actual bare-package CJS/ESM/mixed positives, 11 intended negatives, no compiler emit | [Portable report](types/PORTABLE-REPORT.json.txt), [case spec](types/CASE-SPEC.json.txt), [three positive resolution traces](types/resolution-traces/) |
| Declaration controls | Four intentional mutations distinguished: duplicate brands, missing public submitter, broadened public outcome, misrouted ESM types | [Verification](types/VERIFICATION-REPORT.json.txt), [probe and traces](types/CONTROL-PROBE.json.txt), [preparation recipe](types/prepare-followups.py.txt) |
| Actual upstream types | One focused positive against pinned Kohaku snapshot/private/public PluginInstance specializations and explicit private-outcome Broadcaster | [Upstream report](types/UPSTREAM-REPORT.json.txt), [bridge](types/consumers/upstream/bridge.ts.txt) |
| Final artifact assembly | Independent reconstruction from original declarations, conditional manifest, licenses/source joins; all 29 files unchanged | [Assembly verification](final/ASSEMBLY-VERIFICATION.json.txt), [guarded verifier](final/verify_artifact.py.txt), [optimized-Python refusal](final/optimized-python-control.log.txt) |
| Actual final package | Three final CJS/ESM/mixed bare-package smoke commands exited 0; five exports, snapshot reads, private flows and public baseline/token/error identity; mixed registry identity | [Final scope](final/README.md.txt), [verification](final/FINAL-VERIFICATION.json.txt), [original exits](final/OBSERVED-EXITS.json.txt), [consumer](final/consumer.cjs.txt) |

The 137 runtime cases ran on the original **untyped 21-file manifest**. The final three smokes ran on the actual **typed 29-file manifest**. Runtime `364ab05b3344de30d3058804c9e71088d12f2a2ad4d7326e0f0a946e43f251fc` and both entry wrappers are byte-identical between these lanes. The later checks do not retroactively change what the earlier runs tested, and no unnecessary compiler or 137-case matrix rerun is claimed.

The final inventory is [types/ARTIFACT-INVENTORY.json.txt](types/ARTIFACT-INVENTORY.json.txt), shared exactly by the final artifact. Canonical declaration `3bb6a6f3fb8fd97335332e0bd54f1b8ed6de1aeeebc1e871cf62771393cf5147`, ESM forwarding declaration `ddfe6a1efb2ae9903a0007b41883e064e4f570316211b82363d299049f365eb1`, and final manifest `f23cf0596d880b8c2812fcd2f072e05c0f837734262068c168d164383883c540` are exact payloads. The original runtime build report hashes the earlier manifest. The type-source basis's “pending” wording is its assembly-time record; subsequent reports provide completed qualification without changing the artifact.

## Declaration boundaries

One canonical declaration owns each distinct public/private unique-symbol brand; the ESM entry forwards to it, preserving CJS/ESM identity. The mixed consumer checks both directions. Copying a typed token with object spread can still compile: runtime object identity and one-use authority remain essential. Hex templates and bigint types do not prove address checksum/length, positive amount or ownership.

Public submission is a separate extension with a fulfilled acknowledgement, including string-valued amount; rejection reasons remain separately handled as unknown. It is not widened into the private unknown/recovery outcome union. The private acknowledged amount remains literal `'0'`. Concrete private methods exclude tailCalls, but a widened actual upstream view admits them; that assignability limitation does not mean support. No blanket static guarantee for arbitrary widened asset views is claimed.

Portable checks use actual package resolution without repository aliases or a custom resolver. The separate actual upstream bridge uses bounded source aliases and the pinned Kohaku graph, with installed ox 0.14.45 versus the provider's requested ^0.12.0, plus the report-pinned scure packages. It is not an upstream lockfile build. Both compiler lanes use `checkJs:false`/`allowJs:false`: they check consumers and declarations, not JavaScript implementation conformance. They do not establish generic Kohaku Host/CreatePluginFn compatibility. The misrouted ESM control compiles successfully but violates the required forwarding-entry resolution graph; it is not labelled a compiler rejection.

## Runtime and reproduction boundaries

Hosts are executable trusted policy providers. No fixed Freedom wallet host, controller, key, durable journal, eligibility/POI authority, live receipt canonicality, crypto or self-recipient authority is certified by these fixtures. JavaScript instrumentation detects selected forbidden network/process/native-addon/repository-import seams; it is not OS isolation or certification of arbitrary host behavior. Distinct physical package copies require distinct hosts. The tracked `closed` barrier rejects unobservable Promise work and must not be called successful drainage. Scope remains restricted Node 24.18.1/Sepolia 11155111; this archive adds no browser/mainnet/live-funded qualification.

Physical node_modules duplicates, dependency/upstream/compiler bodies, routine stdout and repeated negative trace dumps are omitted. Exact consumers/specs/recipes and source/read hashes make the evidence auditable; omitted external inputs prevent a fully standalone replay claim. The archived historical TYPE-ASSEMBLY.py requires ordinary Python: its assertions disappear under optimization. The final independent verifier explicitly refuses optimized Python; [the recorded control](final/optimized-python-control.log.txt) exited 1. Preserve that distinction when reproducing.

The frozen final-lane README says “full source/input inventory remain included”; that wording is too broad for the artifact itself. The 29-file artifact contains selected covered source and provenance, while the complete 82-input runtime inventory is in the separately retained [build report](runtime-build/build-a/BUILD-REPORT.json.txt). This archive preserves the frozen README as historical evidence and makes that distinction explicit.

The included [Freedom license](artifact/licenses/freedom/LICENSE.txt), ethers/Noble license records, build-tool licenses and original covered sources are retained. No upstream Kohaku source body is distributed or redistribution permission inferred. The pinned upstream packages have no discovered package license field or root/package license file; this is a recorded boundary, not a legal conclusion.

## Immutable source lanes

- Runtime build freeze: `4f9419c9df1c5cd9d10829606389c3defce9e7d9405061a979d9e2990215480e`.
- Runtime consumer freeze: `8be88e2e8aab85cfedf87144ce57a3f1e7c65fe64e4fe62bae0d0affc1af1cb0`.
- Declaration lane freeze: `b312dc2864ef12b888c5388c3625aa241be2c539fb653ca2f10502c6156c218b`.
- Final actual-package freeze: `ae11efc1338d9182ff0277efde1963a7300005c00d608d9824964246320f8cde`.

Publication preparation only copied, normalized and verified evidence. It did not rerun compiler/native/runtime tests, edit the source repository, install dependencies, publish a package or access funded profiles.
