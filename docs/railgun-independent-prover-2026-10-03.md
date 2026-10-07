# Independent Railgun serial prover — October 3, 2026

The guarded Railgun proof job now loads its own authenticated prover archive.
It no longer imports the PPv2 runtime. Five transaction shapes and POI3×3 produce
valid proofs and reject modified public inputs with this archive. This is still
offline public/synthetic qualification, not a spendable-balance, POI-service or
funded-operation result. The engine itself still uses the pinned development
fixture; production engine/account-session packaging remains separate work.

## Build and provenance

`build-railgun-prover.js` reads the already installed snarkjs 0.7.5 dependency
tree. Its current input root is the ignored pinned PPv2 build-input checkout,
but it imports no PPv2 protocol source or SDK, installs nothing and changes no
application dependency or lockfile. Ordinary builds require the committed
[73-file inventory](../scripts/fixtures/railgun-prover-inputs.json), including
16 package metadata sets and available license files. `--capture-inputs` creates
an unapproved candidate inventory for review; it cannot change runtime pins.
The builder rereads captured files after assembly and refuses a differing input
inventory. This protects reproducibility under the trusted-local-build model;
it is not a sandbox against a malicious local writer or compromised build tool.

The inventory records esbuild 0.28.2 and @electron/asar 3.4.1. The latter is an
existing transitive development dependency in the root lockfile. The archive
includes its build inventory and builder digest. Two independent strict builds
produced identical **1,613,882-byte** containers:

`dd50a29f297867b3bf91cb425066e1d257ea02230a94b02e4cf34c5c70a0c7ab`

[The reproducibility report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-prover-build-2026-10-03.json)
records both digests. Its checker also authenticates the previous PPv2 archive
and compares the generated `groth16Verify` function body byte for byte: identical,
SHA-256 `3bc48b0cbfc4b85b4ed0c881da8c52ada20f49489c7162ae8fd3a3843036da9d`.
This comparison is build evidence only; the new proof runtime never opens that
historical archive.

Proving uses snarkjs's supported single-thread option. Verification preserves the
previous narrowly reviewed adaptation: the one `getCurveFromName` call inside
`groth16Verify` also requests single-thread mode. The source hash and exactly-one
replacement are checked. Worker code is still present, including web-worker
1.2.0 and both resolved ffjavascript copies (0.3.0 and 0.3.1). It is not invoked
by these proof paths; attempts to construct workers would hit the utility guard
and fail. The archive contains the complete worker package and needs no unpacked
sibling. Other bundle externals are allowlisted Node builtins.

The main-selected loader hashes the real container before import, checks its
pinned size, and refuses symbolic-link archives, unpacked siblings, changed file
identity or bytes. It uses original-fs under Electron. As with the PPv2 loader,
the local OS and application are trusted: module caches and the interval between
verification and require are not defended against a privileged local writer.
Immutable authenticated application resources remain a production requirement.

## Actual proof results

[Six guarded Electron jobs](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-independent-prover-2026-10-03.json)
verify with the new archive and report its actual archive, input-inventory and
builder digests. Every job rejects a changed root; transaction jobs additionally
reject changed bound parameters. All jobs report zero egress attempts, zero POI
service calls and zero submissions. Transaction times were 1,768–2,344 ms; POI3×3
took 3,670 ms. Maximum sampled utility RSS was 423,165,952 bytes under the 768 MiB
soft ceiling and 256 MiB V8 heap limit. These are local measurements, not hard
memory guarantees or performance promises. The earlier PPv2-bundle fixture run
had similar transaction times (1,789–2,335 ms) and POI time (3,585 ms).

Ten focused runtime/artifact checks and lint pass. The preceding read-layer
commit passed the full native regression: 7,775 tests / 33 skipped. Its first
sandboxed attempt finished with 13 failed suites because Electron probes or
loopback sockets were unavailable; the native rerun passed. Artifact commit
`10ef82aab4a2c160e1d3ecc9072af0239f8e921e` also completed CI successfully. These
results do not assert CI success for this packaging slice.

Claude reviewed the build, loader, provenance and proof evidence; a stale report
field initially naming the PPv2 archive was corrected, then all six jobs reran.
Only the corrected report is committed. Engineering review is not a security audit.

## Remaining limits

`productionDistributionApproved` stays false. snarkjs and several dependencies
are GPL-3.0; other resolved licenses include Apache-2.0, MIT and ISC. Two packages,
@iden3/bigarray 0.0.2 and @iden3/binfileutils 0.0.12, declare GPL-3.0 but ship no
license-text file. The inventory records that absence. License compatibility,
complete corresponding-source/notice obligations and distribution approval are
still unresolved; 73 direct build inputs are not a complete legal clearance of
code already bundled inside upstream packages. The bundle also includes ejs
through snarkjs's verifier-export functionality; a narrower future entry could
remove unused tooling, subject to requalification.

Account enrollment, live source/history advancement, TXID/POI and relay services,
checked operation-bound signing, transaction journals and funded lifecycle tests
remain required for parity with PPv2. No Railgun funds have moved.

```sh
node scripts/build-railgun-prover.js /absolute/pinned-input-root /absolute/new-build
node scripts/check-railgun-prover-build.js /absolute/first/railgun-prover.asar \
  /absolute/second/railgun-prover.asar /absolute/historical/ppv2.asar \
  /absolute/new-reproducibility-report.json
node_modules/.bin/electron scripts/qualify-railgun-proof-artifacts.js \
  /absolute/artifacts /absolute/railgun-prover.asar /absolute/public-poi-vector.json \
  /absolute/new-proof-output
```
