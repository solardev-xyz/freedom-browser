# PPv2 SDK source and offline qualification

Date: 2026-09-25. This supersedes the source-access gate in the [earlier preflight](ppv2-integration-preflight-2026-09-25.md). The bounded experiment remains Freedom host → Kohaku adapter → PPv2 SDK. It does not enable wallet operations or establish mainnet readiness.

**September 26 continuation:** the pinned Kohaku compatibility patch now passes typechecking, and the real prover passes lifecycle/egress tests in source and packaged Electron through a new main-owned utility-process host. See [the current implementation and remaining gates](ppv2-adapter-process-2026-09-26.md). Findings below preserve the earlier unpatched-SDK experiment.

## Access and reproducibility

After Florian accepted the invitation, authenticated read access to `0xbow-io/v2-monorepo` succeeded. 0xbow identified `v2.0` as the latest SDK code and said there is no v1.0 release yet. The isolated checkout is `/private/tmp/freedom-ppv2-v2-sep25`, pinned at `fe0244e3f14110efd83db02c60c96517dea9cd5a`. The SDK manifest is `@privacy-pools-v2/sdk`, version `0.0.0`, private; root and SDK declare MIT. This is a supported source route, so the older package-registry token scope is no longer a prerequisite for this experiment. It is not confirmation that this revision is the final audited candidate.

Installed the existing lockfile using the upstream `pnpm@10.27.0`, filtered to the SDK and its two workspace dependencies, with lifecycle scripts disabled. Built only the SDK; no contract deployment, circuit compilation/setup or dependency upgrades. The build emits CJS, ESM and declarations, with upstream declaration-bundler circular-reexport warnings. The checkout remains clean. Freedom main is still `2983dc62`, already merged, so no new node installation was needed.

The SDK's license is not the entire dependency license inventory: its pinned `snarkjs@0.7.5` declares GPL-3.0. Include transitive dependencies in the eventual distribution review. No upstream source, binaries, circuit artifacts or SDK dependencies were added to Freedom's application package.

The [reproduction script](../scripts/spike-kohaku-ppv2-sdk.js) extracts exact Kohaku PR #258 blobs at `6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e` into a fresh scratch directory. Type resolution maps the older SDK package name onto the built source SDK; it does not modify upstream implementation. See the [machine-readable report](qualification/ppv2-sdk-2026-09-25.json) for source/build/lockfile digests, measurements and explicit qualification limits.

## Results and required changes

| Check | Result |
| --- | --- |
| SDK build | Passed; upstream declaration-bundler warnings remain |
| Upstream crypto, keystore, builder and proof-service tests | 96 passed |
| Kohaku canonical signature and independent SDK key calculation | Four account/rotation cases passed |
| Complete Kohaku v2 source typecheck against new SDK declarations | Failed: four diagnostics for two substantive interface changes |
| Real deposit proof in Freedom's existing Node worker | Failed: transitive worker runtime incompatibility |
| Same unchanged SDK/proof fixture in a separate Node process | Generated and verified; tampered public signals rejected |
| Freedom artifact-loader/worker regressions | 11 passed; lint passed |
| Live registration/shield/sync/unshield, recovery, packaged Electron | Not qualified |

### Derivation matches, but production identity is not finalized

The actual Kohaku derivation module signs the same payload as `apps/sample-web/src/secretDerivationPayload.ts`. Ethers independently signs it and matches Kohaku's viem signature. Node's HMAC/HKDF and X25519 implementations reproduce the SDK's nullifying, revocable and viewing keys. Accounts 0 and 1 differ; rotations 0 and 7 retain the identity/viewing keys and change the revocable key. These are synthetic deterministic inputs, not a vault or funded wallet, and no secret outputs are written into the report.

The dedicated signer path remains `m/28784'/2'/<accountIndex>'`. This is a Kohaku derivation convention; portability to a wallet deriving the signature from a different signer path is not established by the test. It does not change Freedom's public-account or Ant identity paths.

`packages/sdk/src/constant/KeyDerivation.ts` explicitly marks `APP_IDENTIFIER = "TODO-privacy-pools-v2"` for finalization before mainnet and warns that changing it invalidates derived keys. Preserve it exactly for this pinned experiment. Final identifier, canonical payload and signer-path/version metadata must be settled before creating durable production PPv2 accounts. Matching keys after re-derivation is not full note recovery or hardware-signer qualification.

### Kohaku needs two compatibility updates

1. **Finalized-block handling.** `IRPCInteractor` now requires `getFinalizedBlockNumber()`, returning `finalized`, `unsupported` or `unavailable`. The old Kohaku interactor has no implementation. The SDK defers irreversible exit updates when the read is unavailable; it uses a confirmation-depth fallback only for genuinely unsupported providers. A timeout, cancellation or permission refusal must not be relabeled as unsupported. A remote RPC's finalized tag is still unverified evidence under Freedom's trust model.
2. **Exit state.** `NoteStatus.EXIT_PENDING` is new. Kohaku's `statusToReport` and `labelStateFor` switches do not handle it and fail strict typechecking. Pending exits must remain visible and unspendable until settled; they can return to active after a reorg. Association-set label state cannot be guessed from exit state: ragequit may concern a rejected note. Resolve that mapping explicitly before connecting balances or recovery, rather than adding an arbitrary default to silence the compiler.

The report records four diagnostics because the missing RPC method also appears at session assembly and the missing state appears in two switches. Typechecking covers the full v2 source with pinned Kohaku host/provider types and the installed SDK dependency tree; it is not a successful full Kohaku monorepo build or a working session.

### The proof works; the Node worker integration does not

Fetched only the deposit WASM and zkey through Git LFS, alongside the tracked verification key. All three match the SDK manifest SHA-256 values. Freedom's existing artifact loader accepts the exact pinned bytes, and the fixture also checks their digests inside the proving runtime.

In the existing worker, `web-worker@1.2.0` treats any non-main Node thread as its own bootstrap thread. It tries to load an absent `workerData.mod`; subsequently the actual SDK proof fails with `Worker is not a constructor`. Direct diagnostic reproduction and source inspection locate the fault in the transitive runtime. Freedom correctly refuses the failed worker result.

The same SDK `WitnessPreparationService → ProofService → Groth16Prover → snarkjs` succeeds in a separate Node process, using actual deposit artifacts and synthetic inputs. Final measured proving time was **266 ms**, excluding process startup and Poseidon initialization; four public signals verified, and altered signals failed verification. Process RSS at result time was approximately **418 MiB**, not peak memory or a per-proof allocation measurement. This small deposit circuit says nothing about larger transfer/withdrawal circuits.

Fetch/HTTP/socket tripwires observed no network attempts in the fixture's process/thread. They are diagnostic overrides, not an OS sandbox; nested workers do not inherit them. The process probe waits for child exit, but does not qualify an application process host, vault-lock cancellation, memory limits or ASAR packaging. Actual-prover cancellation in Freedom's existing worker is explicitly untested because proving fails before that test can run. Previous synthetic CPU-worker cancellation evidence remains valid within its original scope.

## Next implementation slice

1. Keep the Kohaku integration route and make a narrow, reviewable compatibility change for finalized-block results and `EXIT_PENDING`, with unavailable/reorg/status tests. Preserve unverified-RPC provenance and reversible local observations.
2. Qualify a main-owned process host for the unchanged SDK prover, starting with Electron utility-process/ASAR loading, cancellation after real proving starts, crash/timeout cleanup, memory measurements and egress mediation. Keep SDK material out of the renderer. The existing Node worker remains useful for compatible runtimes; this result does not justify loosening its checks or downgrading dependencies.
3. Assemble a controlled session with the restricted PPv2 signer, encrypted storage and separate RPC/ASP/relayer capabilities. Review the actual deployment, selectors/events, artifact set and ASP authentication before a live Sepolia operation. Do not copy the sample's head-minus-100 recovery shortcut or rotation-zero seed.
4. Then exercise registration → shield → sync/ASP approval → reviewed unshield, including restart, full-history and rotated-key recovery. Retain durable uncertainty for relayer submissions. Mainnet remains gated on final identity constants, audit/fixes and deployment qualification.

The SDK also includes direct-fetch LiFi quoting and default HTTP/RPC implementations. Injected core HTTP/RPC does not automatically mediate every new swap/cross-chain feature. Keep those paths outside the initial session capability set and inventory them before enabling them.

No additional UI/UX decision is required for this technical slice. Follow-up information for 0xbow: final `APP_IDENTIFIER`/payload, recommended Kohaku compatibility revision, and the SDK/deployment/artifact revision matching the completed audit. No maintainer message was sent.

## Reproduce

In a clean authorized checkout at the pinned PPv2 revision:

```sh
pnpm --filter @privacy-pools-v2/sdk... install --frozen-lockfile --ignore-scripts
pnpm --filter @privacy-pools-v2/sdk build
git lfs install --local --skip-smudge
git lfs pull --include='packages/circuits/build/deposit/deposit_js/deposit.wasm,packages/circuits/build/deposit/groth16_pkey.zkey' --exclude=''
git lfs checkout packages/circuits/build/deposit/deposit_js/deposit.wasm packages/circuits/build/deposit/groth16_pkey.zkey
```

From Freedom:

```sh
node scripts/spike-kohaku-ppv2-sdk.js /absolute/kohaku/checkout /absolute/ppv2/checkout
npm run lint
npm test -- -- --runInBand src/main/wallet/privacy-artifacts.test.js src/main/wallet/privacy-worker.test.js
```

The script intentionally reports adapter/worker incompatibility separately from successful independent probes; exit zero is not a production qualification result. Logs from this run: `/private/tmp/freedom-ppv2-sdk-build.log`, `/private/tmp/freedom-ppv2-sdk-unit.log`, `/private/tmp/freedom-ppv2-sdk-spike.log`, `/private/tmp/freedom-ppv2-sdk-host-tests.log` and `/private/tmp/freedom-ppv2-sdk-lint.log`. The earlier full Freedom suite result remains historical; it was not rerun for these isolated scripts and documentation.
