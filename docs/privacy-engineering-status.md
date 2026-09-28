# Wallet privacy engineering status

September 14 baseline. **Latest update:** [September 28 independent review and fixes](privacy-review-fixes-2026-09-28.md) records the current implementation and release gates. The [September 25 follow-up](privacy-engineering-followup-2026-09-25.md) updates the Railgun assumptions below. This page preserves the September 14 baseline and its original measurements.

Local implementation and qualification work; no production activation or shielded-wallet release. The [implementation plan](wallet-privacy-implementation-plan.md) remains the acceptance checklist. UI/UX is provisional and will be discussed separately.

## What works now

| Area | Implemented and exercised | Scope still missing |
| --- | --- | --- |
| Contexts and transport | Profile/account/session ownership, vault-lock cancellation, strict authenticated SOCKS, context-specific HTTP/TLS pools, remote destination DNS, no automatic fallback | Complete SDK traffic coverage and every supported platform |
| Balance flow | Sepolia native/ERC-20 reads through existing wallet IPC; account separation; preserved observation timestamps during outage; restart and both lock paths | Production activation, comprehensive OS egress tracing, additional chains |
| Transactions | Main-only context-bound nonce, gas, simulation, raw submission and receipt hooks; exact signed-intent checks; bounded review lifetime; uncertain submission handling | Durable submission journal, restart recovery, real approval/transaction-recorder integration and end-to-end qualification |
| Kohaku host primitives | Restricted Railgun key derivation and authenticated encrypted atomic storage | Product key/backup lifecycle, actual SDK persistence/restore, worker/proving cancellation |
| Kohaku runtime | Pinned isolated SDK bundle initializes WASM and reconstructs a synthetic address in Node and packaged Electron from ASAR | Sync, proving, shielding, unshielding, sponsored submission, network mediation |

The development balance gate remains closed in packaged builds. Sending through the ordinary wallet is unchanged. The new transaction APIs have no renderer/IPC entry point and do not make normal sends private. No application dependency was added or upgraded. No real wallet keys or funds were used.

## Live Arti evidence

`scripts/qualify-wallet-tor.js` starts the shipped Arti with disposable state and opens six fresh SOCKS/TLS connections to `example.com:443`. A and B are synthetic labels with separate random authentication tokens. Arti debug logs supply complete circuit identifiers; exit-IP differences are not used as evidence.

Observed on macOS arm64, Arti 2.6.0, at 2026-09-14T20:34:18Z:

| Request | Context | Circuit | HTTP status | Connection/request time |
| --- | --- | --- | --- | --- |
| 1 | A | Circ 3.0 | 200 | 1,321 ms |
| 2 | A | Circ 4.0 | 200 | 404 ms |
| 3 | B | Circ 4.1 | 200 | 3,425 ms |
| 4 | B | Circ 4.1 | 200 | 2,012 ms |
| 5 | A | Circ 4.0 | 200 | 592 ms |
| 6 | B | Circ 4.1 | 200 | 1,682 ms |

No circuit was shared across A/B in this run; both contexts reused a circuit across fresh connections. A context is allowed to use more than one circuit. Bootstrap took 4,028 ms in this run; six sequential requests are not a representative latency/load benchmark. The checked-in [machine-readable report](qualification/wallet-tor-macos-arm64-2026-09-14.json) includes the Arti binary hash. Its `qualified: true` means this probe's assertions passed, not that the wallet feature is release-qualified.

Reproduce with `node scripts/qualify-wallet-tor.js`. This explicitly uses the live Tor network and writes reports/raw logs to a fresh temporary directory. The successful run's raw log is local at `/var/folders/yk/vgp12b9s3hz7l4vh92hr5r8w0000gn/T/freedom-tor-qualification-BMnZOU/arti.log`; temporary evidence is not a durable repository artifact. Routine tests use loopback fixtures.

## Packaged macOS evidence

An unsigned local arm64 app was built with Electron 44.3.0. Four packaged Playwright checks passed: executable preflight, Kohaku runtime loading, the wallet balance flow, and the experimental setting in both themes.

The balance test loads application modules from the built `app.asar` and uses the real wallet IPC/vault lifecycle with synthetic accounts and local SOCKS/TLS fixtures. It verifies distinct account credentials, ERC-20/native reads, outage/stale timestamps, Tor replacement, manual lock and automatic lock. Guards observed zero ambient `fetch` calls and zero non-loopback Node destination-DNS lookups during that flow.

The test first verifies the production gate is closed, then overrides that gate **only in the test process** to exercise the packaged code. These guards and controlled fixtures are not an OS-level trace of every Chromium, native, worker or SDK network path. The Kohaku test loads a separately generated scratch ASAR; the SDK is not shipped inside Freedom's production bundle.

Reproduction after preparing the SDK scratch fixture below:

```sh
npm run build -- --mac --arm64 --unsigned
FREEDOM_E2E_EXECUTABLE="$PWD/dist/mac-arm64/Freedom.app/Contents/MacOS/Freedom" FREEDOM_KOHAKU_SPIKE_ASAR=/private/tmp/freedom-kohaku-runtime-spike/kohaku-runtime.asar npx playwright test --project=packaged test-e2e/wallet-private-balances.spec.js test-e2e/kohaku-runtime.spec.js
```

The same balance and runtime checks also passed against the source Electron app. Linux/Windows qualification and Linux screenshot baselines remain outstanding.

## Transaction boundaries

`networks/private-rpc.js` centralizes the experimental gate, endpoint eligibility, chain validation and pinned Tor endpoint lifetime. `wallet/private-transaction-network.js` restricts transaction RPC to the context owner. Private provider requests bypass chain-only ethers caches; requesting an ordinary provider with a privacy context fails.

`transaction-service.js` accepts a main-owned context and review callback. Review sees the frozen, fully populated transaction and expiry; signer output must match its exact unsigned serialization. Lock, revocation, rejected review, expiry or changed signer intent prevents submission. Review/signing callbacks that ignore cancellation cannot revive an operation. Remote signers that own broadcast transport are refused. The initial fee experiment uses a coherent legacy quote, not the product's complete fee-selection policy.

Before handing signed bytes to transport, the network client records the deterministic hash in memory. A failed response becomes an unknown submission outcome with that hash; the same client refuses a repeated submission and permits status queries only for its attempted hashes. Tests use synthetic signatures and mocked RPC, not a live testnet submission.

**Do not activate this path until durable recovery exists.** The attempted-hash set is session-local. Lock/restart currently loses that tracking capability. Add an encrypted write-ahead submission journal, restore it before any new send, and distinguish prepared/attempted/unknown/submitted/confirmed without automatically resending. Receipt tracking while locked needs an explicit permitted lifecycle. Integrate the existing transaction recorder and approval service before exposing any new send intent.

## Kohaku compatibility findings

The SDK spike uses an isolated temporary npm project; the app's dependency files are unchanged. Exact inputs and the Node/address result are in [runtime report](qualification/kohaku-runtime-macos-arm64-2026-09-14.json), with its [scratch dependency manifest](qualification/kohaku-spike-package.json) and [lockfile](qualification/kohaku-spike-package-lock.json).

| Package | Exact tested version | Direct Node ESM import | Published license metadata |
| --- | --- | --- | --- |
| `@kohaku-eth/plugins` | `0.0.1-alpha.13` | Fails: extensionless module import | Missing |
| `@kohaku-eth/provider` | `0.1.0-alpha.9` | Loads | MIT |
| `@kohaku-eth/railgun` | `0.0.1-alpha.30` | Fails: directory import | MIT |

The Railgun bundle also imports `viem`, which the inspected package lists only as a development dependency. Supplying the already installed `viem@2.56.3` explicitly to the scratch bundler resolves it. Production adoption must declare and approve the actual dependency set rather than depend on a transitive installation. The plugins package's missing license metadata needs clarification; this observation does not establish redistribution rights.

`scripts/spike-kohaku-runtime.js /absolute/scratch/workspace` bundles the installed packages, supplies WASM bytes explicitly, creates an ASAR and emits a report. Two signers created from public fixture keys reconstruct the same address. This succeeds in Node 24.18.1 and in packaged Electron. Initialization triggered no ambient JavaScript fetch. This is address reconstruction, not restoration of shielded notes or spending state.

To reproduce, copy the scratch manifest and lockfile into a separate temporary directory, run `npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund` there, then run the spike script from this repository. The script also uses this repository's installed esbuild, viem and ASAR tools; the report records viem and the generated ASAR hash. The scratch lockfile is experimental evidence, not an approved application dependency addition.

The inspected Railgun runtime still has network paths outside the generic host interface: Subsquid/indexer synchronization, remote circuit artifacts, and POI clients/providers in Rust/WASM. Generated bindings contain fetch imports. Providing `host.network.fetch` alone therefore does not establish coverage. A global fetch patch in a loading test is only a tripwire. Each reachable path needs an injectable, context-bound transport or another enforced boundary before sync/proving tests can support a privacy claim. Source basis: [Kohaku repository](https://github.com/ethereum/kohaku) and the pinned source inspection in `research/kohaku-wallet-integration-research.md`.

`identity/privacy-keys.js` restricts derivation to Railgun's two hardened paths for a bounded account index. Known-answer vectors were checked against `derive-railgun-keys@0.1.0` using the public test mnemonic. Ordinary Ethereum and Ant derivation remain unchanged. Session revocation blocks further derivation; buffers owned by the helper are zeroed where possible, which is not a general JavaScript memory-erasure guarantee.

`wallet/privacy-storage.js` supplies Kohaku's string get/set shape using AES-256-GCM, profile/account/protocol-bound authenticated data, bounded snapshots, private file permissions and atomic rename. Tests cover restoration, tampering, wrong keys, cross-account swaps, overlapping writes, interrupted replacement and lock. Main supplies the 256-bit key; actual key custody, version migration, backup/restore, rollback resistance and SDK state-size requirements remain unresolved. This is not yet a complete recovery design.

PPv2 remains the target; PPv1 is not a required shipping phase. The public npm endpoint for `@privacy-pools-v2/sdk` still returned 404 during this session. That establishes only that the tested public distribution was unavailable, not that PPv2 does not exist. SDK/source/artifact access and compatible deployment pins remain prerequisites. No outreach was sent.

## Next engineering work, independent of UI design

1. Implement durable submission/recovery state and qualify crash points before/after transport handoff, response receipt, and record persistence. Never infer non-submission from a lost response.
2. Complete the SDK egress inventory and prototype mediation for each reachable Rust/WASM/indexer/artifact/POI path. Test cancellation and fail-closed behavior at those boundaries.
3. Establish an approved SDK dependency/license set, artifact digests, and a main-owned runtime with bounded proving resources and lock cancellation. Qualify actual protocol storage/independent restoration.
4. Expand controlled macOS qualification to full egress observation, concurrent/load scenarios and endpoint changes, then repeat on supported platforms.
5. Once those gates pass, run the first recoverable synthetic testnet shield/sync/unshield flow. PPv2 can take that role when its inputs are available; the common foundation does not depend on choosing Railgun first.

UI discussions can then use concrete operation states: how users select public/private accounts, see pending/spendable/stale balances, review shield/unshield operations, recover unknown submissions, and understand backup/recovery. Those interactions have not been finalized by this engineering work.

## Regression status

- `npm run lint`: passes.
- `npm test -- -- --runInBand`: **4,357 passed, 10 skipped, 3 pre-existing failures**; 231 passing suites, 3 skipped suites, 2 failing suites. The two shortcut-remap cases and one Safe fork case were previously reproduced on an unchanged HEAD archive. All new tests pass; the overall command remains nonzero because of that baseline.
- Packaged macOS Playwright qualification: **4 passed** including preflight. Source balance checks: **2 passed**; source Kohaku loading: **1 passed**.
- `git diff --check`: passes.

Build/test logs remain local under `/private/tmp/freedom-overnight-final-tests.log`, `/private/tmp/freedom-overnight-final-lint.log`, `/private/tmp/freedom-privacy-package-final.log` and `/private/tmp/freedom-overnight-packaged.log`. The implementation, tests, qualification reports and five supporting research documents are preserved on `feat/wallet-privacy-foundation`. No changes have been pushed or published.
