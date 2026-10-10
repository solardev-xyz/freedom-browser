# PPv2 deterministic development runtime

**October 2 single-thread continuation:** the [fresh-verifier update](ppv2-single-thread-verification-2026-10-02.md) supersedes the earlier pins below with `eacc32476b2fc3be0344e1c9b341a9964e405f59703604385b29307350bcca7a`, 47,806,955 bytes, recipe `e673d45abbe5e983d41a60bb9b6d4b039c75bea8`. Its checker permits only the exact reviewed Groth16 single-thread call adaptation plus the earlier plugin helper additions. The SDK bundle, dependency inputs and circuits are unchanged; the serial bundle is locally modified GPL-3.0 build output.

**Earlier October 2 helper pin:** the [selected-note binding and fresh-verification continuation](ppv2-full-value-verification-2026-10-02.md) adds the authenticated `inspectNullifier` helper. That continuation accepted archive `a7327fce6acde362b05e439c0db579c06fdc87272feaaa21046b0b34dd182f34`, 47,806,767 bytes, recipe `d8fe7b706a52e42cf4761cd9d16958f49603e35f`. The checker accepts only the exact reviewed plugin additions; dependency inputs and circuit artifacts are unchanged. The build results below remain historical evidence for `fa71e37d…`.

This continuation of [the review guide](privacy-review-guide-2026-10-01.md) replaces a locally assembled archive containing build-machine paths with an offline, pinned assembly recipe. It does not activate PPv2, change application dependencies, qualify a current upstream release, or authorize distributing the runtime.

## Inputs and reproduction

Use Node **24.18.1**, esbuild **0.28.2** and `@electron/asar` **3.4.1** from the installed Freedom development tree. The builder refuses different versions. The source and complete dependency inventory pins live in `scripts/fixtures/ppv2-build-inputs.json`. The expected inventory covers every bundled input, its package metadata and available licence files, plus every separately packed `web-worker` file. A changed inventory fails before an archive is produced. The deterministic builder does not execute the installed SDK to obtain its circuit manifest.

Prepare an authorized checkout of `0xbow-io/v2-monorepo` at `fe0244e3f14110efd83db02c60c96517dea9cd5a`. Keep tracked files clean. Using **pnpm 10.27.0**, restore only the SDK workspace closure with `pnpm --filter @privacy-pools-v2/sdk... install --frozen-lockfile --ignore-scripts`, then run `pnpm --filter @privacy-pools-v2/sdk build`. The built `packages/sdk/dist/index.cjs` must hash to `963c7c23b2e87b562acc3793c69c2c55dbb9fc0cb120afd131d2675b0fc2d632`; the builder checks this separately from the lockfile. Hydrate the pinned Git LFS wasm/zkey files for deposit, ragequit and transact_1x1; their verification keys and all nine artifact hashes are pinned too. No new trusted setup or circuit generation is involved.

Have Kohaku Git object `6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e` available locally. Run the offline compatibility probe:

```sh
node scripts/spike-kohaku-ppv2-sdk.js /absolute/kohaku /absolute/ppv2 --compat
```

It extracts immutable Kohaku source, applies the checked-in compatibility patch, typechecks it, compares independent derivation cases and verifies a real deposit proof in a separate process. Use the resulting fixture directory containing `report.json` as the second builder argument. Build promptly or copy that fixture with relative symlinks preserved into a durable ignored workspace directory: OS temporary-file cleanup already removed earlier qualification inputs. The continuation fixes the probe's missing result validator; this restores the intended isolated-process check rather than relaxing the worker boundary.

```sh
node scripts/spike-ppv2-process.js /absolute/ppv2 /absolute/qualified-adapter \
  --exit-circuits --deterministic --output-root=/absolute/new-build-directory
```

The output directory must not exist. Assembly creates a fixed staging layout, resolves Kohaku imports against the pinned SDK dependency tree, rejects inputs resolving outside staging, verifies the dependency inventory, copies available licence texts, sorts archive entries and normalizes modes. It rejects symlinks/native or special files in the packed archive and checks every packed file for build/home paths and the original source paths. All bundled source paths are staging-relative. The recipe is intentionally offline and never updates pins automatically.

The three packed Freedom qualification helpers come from immutable Git revision `8854fdb313a7470989c78bcaf940514f9ce87103`, with individual file hashes. They are still included in this **development-only** archive. The old archive held pre-formatting versions of those helpers from the earlier publication checkpoint; equivalent syntax does not mean identical bytes. The SDK empty-ASP-root rewrite is recorded separately as `empty-asp-root-v1`, with the actual builder and helper hashes included in `build-inventory.json`.

## Evidence and limits

Two complete builds, one inside the repository and one from a different working directory outside it, produced identical archives and every packed file matched. Their input roots have different depths and paths. Synthetic archive tests separately vary creation order and file modes. This establishes repeatability with the prepared pinned macOS arm64 inputs and toolchain, not independent Linux/Windows or fresh-install reproducibility.

All five candidate bundles are byte-identical to the historical qualified runtime after normalizing only its old build-root prefixes. Supporting module counts are: 1,637 SDK dependency modules, 261 plugin dependency modules, and 38 serial-prover dependency modules. All 20 circuit, manifest, worker and candidate-metadata files match byte for byte. The dependency inventory additionally records exact source bytes, not just module names.

Licence evidence remains incomplete: 21 Kohaku source inputs have no package attribution in the extracted qualification fixture, and 11 of the 103 attributed packages declare licences without shipping their licence text. Eleven packages declare GPL-3.0. The full generated inventory records these gaps and available texts; root MIT declarations are not a clearance for the transitive closure, which includes GPL declarations. `productionDistributionApproved` remains false. A production archive must also separate test helpers and receive explicit distribution review.

Bundling does not prove every latent loading path safe. The SDK includes dormant worker/native-loader and logging-worker code; the default deposit prover exercises its separate web-worker bootstrap, while exit proofs use the serial prover. Existing runtime inspection and process policies plus exercised egress tests remain bounded evidence, not an exhaustive native/worker/browser-egress audit. Broader platforms, packaging and the supported upstream release remain gates.

The historical archive and funded profile are preserved. The funded profile still stores `ce18c67a…`, so current PPv2 operations, including legacy exit recovery, refuse until a separately reviewed and authorized archive replacement; this work does not overwrite that profile's archive or migrate its legacy exit state. No new on-chain transaction is needed for these checks.

## Accepted assembly and verification commands

The committed recipe is `58a6dd9a381b6f6285d1cc27ad3f8c5cd6897e10`. Both final builds produced **47,806,236 bytes**, SHA-256 **`fa71e37dab6f558a2a73c2903233667f30809201a6ef1af1f2ab17f8971fe19d`**. The second build used a different working directory and an unrelated parent TypeScript config. The empty staged root config prevents discovery escaping upward; the SDK, adapter and root configs are inventoried. Recipe files must equal committed Git blobs. Recording their last modifying commit keeps later documentation or runtime-pin commits from changing archive bytes.

Claude independently checked the committed recipe, input inventory, licence gaps, source-local compiler settings, immutable helpers and both final archive hashes. All five bundles match the historical archive after build-path normalization; all 20 other historical artifact, manifest, candidate and worker files are identical. The initial strict-mode finding was fixed before accepting this candidate.

To recheck two completed assemblies and a full SDK test report:

```sh
node scripts/check-ppv2-rebuild.js /absolute/historical-ce18.asar \
  /absolute/new/ppv2.asar /absolute/repeated/ppv2.asar /absolute/sdk-tests.json
```

The checker binds the candidate to the accepted runtime pin, checks its exact file set, input/recipe/helper/licence hashes, normalizes only the historical bundle paths, and binds the seven-spec, harness-only report (22 cases after the October 2 full-value withdrawal and single-thread verifier additions; the original qualification below had 19) to the candidate through its runtime-integrity attachment. It rejects the same file supplied twice (same path or inode), skips, failures and flakes. The independence claim rests on the recorded separate build runs: equal bytes alone cannot distinguish an independently assembled archive from a copy. Generate that JSON using the complete suite:

```sh
FREEDOM_PP_V2_PROCESS_ASAR=/absolute/new/ppv2.asar \
PLAYWRIGHT_JSON_OUTPUT_FILE=/absolute/sdk-tests.json \
npx --no-install playwright test --project=harness --reporter=list,json \
  test-e2e/ppv2-process.spec.js test-e2e/ppv2-exit-circuits.spec.js \
  test-e2e/ppv2-deposit.spec.js test-e2e/ppv2-token-deposit.spec.js \
  test-e2e/ppv2-withdrawal.spec.js test-e2e/ppv2-relay.spec.js \
  test-e2e/ppv2-lifecycle.spec.js
```

The superseded pre-fix candidate run is not qualification: 15 cases passed, one Electron application closed during a native withdrawal case, and three cases were interrupted/unrun when the corrected build became available. The final full run must independently pass; repeating a changed artifact is necessary here, not evidence that the earlier failure did not happen.

Final validation: **19 SDK Electron tests passed, zero skips/failures/flakes** (7.9 minutes); full unit regression **6,741 passed / 33 skipped**, plus **six OpenLV tests passed** separately; lint passed. The ten new builder tests cover archive ordering/modes, source and worker tampering, containment, committed recipe provenance and host-path refusal. [Sanitized machine evidence](qualification/ppv2-reproducible-runtime-2026-10-01.json) records both-build identity, historical equivalence, inventory gaps and exact test statistics. No additional live funds were spent.

Claude also independently verified the completed 19/0/0/0 SDK report, seven spec files, harness-only execution and the integrity attachment naming `fa71e37d…`.
