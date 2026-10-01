# Wallet privacy foundation: independent review guide

This guide indexes the research and implementation on `feat/wallet-privacy-foundation` as of October 1, 2026. It accompanies [research issue #475](https://github.com/solardev-xyz/freedom-browser/issues/475) and the companion draft PR linked there. This is a development milestone, not production activation or an external security audit.

Implementation checkpoint: `9700540aa556aa226d4f8641d0c08ed0c44207b3`. Main was fetched and an explicit merge reported already up to date at `39ad0247eea30745758f02ccd61fe39955dbd83c`. The pre-publication diff contains 36 commits and 209 files, including extensive evidence, tests and scratch-build descriptions. Publication additions are this guide, visual evidence, the experimental-settings changelog fragment and corrections/annotations in the supporting documentation.

## Reading order and ownership

1. [Roadmap](../research/privacy-roadmap.md): six-adversary threat model, broader browser work, current status and remaining decisions. Historical sections retain superseded “next” statements; the October 1 follow-ups take precedence.
2. [Implementation plan](wallet-privacy-implementation-plan.md), [Kohaku/CLI study](../research/kohaku-wallet-integration-research.md), [Tor isolation study](../research/tor-circuit-isolation-research.md), [Reads/anon-rpc/PIR study](../research/ethereum-reads-anon-rpc-research.md).
3. Main-owned context/transport under `src/main/networks/`: privacy context, SOCKS/HTTP/private RPC, Kohaku provider/network/router. Review lifecycle, mixed-subject refusal, route grants, response bounds, remote DNS, connection reuse and fallback behavior.
4. Identity and storage: `src/main/identity/ppv2-keys.js`, Kohaku keystore, wallet privacy session/storage/profile guard, PPv2 storage/runtime. Check derivation identity, owner/profile/deployment binding, lock cancellation, missing-store refusal and runtime authenticity.
5. Proving: wallet privacy artifacts/worker/process and PPv2 deposit/ragequit/transact policies/provers. Check pinned artifact manifests, nested workers, resource limits, exact witness/public-signal checks and proof verification.
6. Public submission: transaction intent/network/journal/reconciliation and PPv2 public operations/token policy. Check signed intent, registration, exact approvals and journal-before-send behavior.
   The October 1 [shared submission follow-up](ppv2-shared-submission-journal-2026-10-01.md) extends the durable gate to ordinary sends from enrolled Sepolia accounts, adds first-enrollment leases and nonce floors, and makes the qualification harness honor the profile lock.
7. Relayed operations: PPv2 session, signed quotes, relay handoff/journal/reconciliation and note recovery. Check SDK-selected inputs, deadlines, body equality, one-use review, durable uncertainty, finalized-event matching and checkpoint revalidation.
8. Post-live follow-ups: exit reservations/legacy recovery, task budget and Sepolia preflight. Read the [live finding](ppv2-live-lifecycle-2026-10-01.md), then [reservation](ppv2-exit-reservations-2026-10-01.md), [legacy recovery](ppv2-legacy-exit-recovery-2026-10-01.md), [bounded work](ppv2-bounded-recovery-2026-10-01.md) and [ASP outage](ppv2-asp-outage-2026-10-01.md) reports.
9. Existing renderer balance experiment and settings diff; no shielded-wallet product UI exists. New private-operation authority remains in main. The branch uses existing balance IPC for a gated public-balance experiment.

No top-level package/process ownership changed. No PPv2 SDK dependency was added to the application package. Its separately qualified ASAR is not a production asset.

## Reproduce ordinary regression

Use the repository's Node 24 setup and lockfile. Install application dependencies and the pinned node binaries through [development instructions](development.md) and the [bundled-binary playbook](agent-playbooks/bundled-binaries.md). Merging main does not refresh ignored native binaries. Do not substitute newer upstream versions for repository pins.

```sh
npm ci
npm run ant:download
npm run ipfs:download
npm run radicle:download
npm run myotis:download
npm run tor:download
npm run check-binaries
npm run lint
npm test -- -- --runInBand --testPathIgnorePatterns openlv-protocol.test.js
npm test -- -- --runInBand src/main/wallet/remote/__tests__/integration/openlv-protocol.test.js
git diff --check
```

Arti is built locally and needs the documented Rust/native prerequisites. Myotis includes its supervisor build. These commands are setup guidance, not a claim every platform was qualified. The latest local suite used loopback fixture permissions. OpenLV is separated because an earlier combined run emitted late websocket logs after teardown; both recorded final commands exited zero.

At the implementation checkpoint: 6,731 tests passed / 33 skipped excluding OpenLV; six OpenLV tests passed separately; 319 plus one passing suites; five suites skipped. Lint passed. Earlier dated documents retain older failures and lower counts; do not add historical runs together.

At publication, changed-file Prettier checking found 167 files with formatting differences. The October 1 continuation formats those branch-touched files only and fixes the two expected Linux experimental-settings screenshot baselines from CI run `36917879697`. All 140 changed JavaScript syntax trees retain the same semantics (ignoring source locations, comments, raw literal spelling and equivalent static property-key spelling); one lint suppression moved to the formatted `cause` property. Full unit regression again passed 6,737 tests with 33 skips, lint and changed-file formatting passed, and four real pinned-SDK process/lifecycle Electron checks passed. The historical runtime ASAR pin remains unchanged by this formatting commit. Cleanup CI on `8854fdb3` passed all required checks. Human review remains required.

## Reproduce the real SDK tests

The real-SDK tests require more than a clean Freedom clone:

- Authorized access to the exact upstream source/package/circuit inputs where required by the provider. The current private monorepo is `0xbow-io/v2-monorepo`; the qualified SDK revision is `fe0244e3f14110efd83db02c60c96517dea9cd5a` and Kohaku is `6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e`.
- `pnpm@10.27.0`, frozen upstream dependencies, SDK build outputs and actual Git LFS circuit files, not pointer text. Preserve license/provenance evidence for the complete transitive/artifact set.
- Review `scripts/spike-kohaku-ppv2-sdk.js` (`--compat`), `scripts/fixtures/kohaku-ppv2-compat.patch`, `scripts/spike-ppv2-process.js`, `scripts/spike-ppv2-session.js` and `scripts/qualify-ppv2-circuits.js`, together with their dated reports. They consume exact prepared inputs and refuse changed pins; they are not a turnkey installer for current upstream HEAD.
- The October 1 [deterministic build recipe and qualification](ppv2-reproducible-runtime-2026-10-01.md) replace the historical `ce18c67a…` archive with a 47,806,236-byte development runtime: SHA-256 `fa71e37dab6f558a2a73c2903233667f30809201a6ef1af1f2ab17f8971fe19d`. Two independent builds match exactly; all 19 real-SDK Electron cases pass without skips. Archives are not committed or distributed here. The historical funded profile and old archive are preserved; current loader pins reject that old copy until a separate reviewed migration.

The pinned `snarkjs@0.7.5` declares GPL-3.0, and the inspected `@kohaku-eth/plugins` package lacked license metadata. Root/SDK MIT declarations do not resolve the full distribution inventory. Build/inspection scripts currently use `@electron/asar` as a transitive development dependency. No SDK archive handoff or redistribution is promised here.

Once that exact qualified artifact is available, set `FREEDOM_PP_V2_PROCESS_ASAR` to its absolute path:

```sh
export FREEDOM_PP_V2_PROCESS_ASAR=/absolute/path/to/qualified/ppv2.asar
npm run test:e2e -- test-e2e/ppv2-withdrawal.spec.js
npm run test:e2e -- test-e2e/ppv2-lifecycle.spec.js
npm run test:e2e -- test-e2e/ppv2-process.spec.js test-e2e/ppv2-deposit.spec.js test-e2e/ppv2-token-deposit.spec.js test-e2e/ppv2-exit-circuits.spec.js test-e2e/ppv2-relay.spec.js
```

CI explicitly excludes the dedicated PPv2 specs and the Kohaku runtime spike until artifact distribution is qualified; the two wallet-private balance/recovery specs are in CI. Some upstream-fixture unit suites are environment-gated and contribute to the 33 skips. A green ordinary CI run does not establish real-SDK PPv2 qualification.

The latest checkpoint reran all eight withdrawal cases and both lifecycle cases. Other commands identify additional relevant suites, not additional newly claimed runs. Missing artifact variables cause suites to skip; that is not successful SDK qualification. Earlier unsigned packaged macOS evidence is historical: current packaged tests use the repository's newer launch harness, and latest-head packaged/other-platform qualification remains open. Do not assume a source Electron run proves production fuse/packaging behavior.

Controlled tests create synthetic temporary profiles and do not need Sepolia ETH. Live scripts (`qualify-ppv2-live.js`, `qualify-ppv2-recovery.js`, `qualify-ppv2-session.js`) are separate qualification tools; configured session steps can sign/send. Read their operation-specific bounds, review policy and reports first. Do not use or reset another developer's funded profile. Never publish raw session output, credentials, note identifiers, witness data or derivation signatures.

## What the live test actually established

The [funded report](ppv2-live-lifecycle-2026-10-01.md) and [sanitized machine evidence](qualification/ppv2-live-lifecycle-2026-10-01.json) contain seven successful native Sepolia transactions and exact accounting. RPC/ASP used Tor; relaying deliberately used direct HTTPS after Tor-relayer 403. The withdrawal returned to the funding owner. It is protocol correctness/recovery evidence for that bounded experiment, not transaction unlinkability.

Live code was `17e65487` with the harness from `1d8cf97d` (SHA-256 `b20ec325930741f0d281d1e07141500ecdf6dbca72d3b0f876752b0776615e3b`); HEAD itself has not been run live.

Nine startup/read-failure invocations, expected pre-finality refusals and the corrected quote-address encoding refusal remain documented. Nothing uncertain was automatically resent. Later host-reservation/legacy-recovery changes were exercised with synthetic fixtures, not migrated into the funded profile. The funded profile has two legacy exit intents; HEAD notes/balances/controller status deliberately refuse with `PRIVATE_PPV2_EXIT_RECOVERY_REQUIRED` until reviewed binding recovery. Do not reset it. Pending/failed exits remain conservatively reserved; no safe-release feature is claimed.

## Visual evidence

Before: clean `origin/main` snapshot `39ad0247`. After: implementation checkpoint `9700540a`. Disposable source Electron profiles on macOS arm64, 1200×850 window; no live identity. Settings show the packaged-disabled/development-gated row. Balance screenshots use a synthetic main-process IPC result to exercise the actual renderer; they are UI fixtures, not proof of a live network route or a proposed shielded-wallet flow. Balance screenshots capture only the wallet sidebar.

| Surface               | Before dark                                                                     | After dark                                                                     | Before light                                                                     | After light                                                                     |
| --------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Experimental settings | [image](audits/evidence/privacy-foundation-2026-10-01/before-settings-dark.png) | [image](audits/evidence/privacy-foundation-2026-10-01/after-settings-dark.png) | [image](audits/evidence/privacy-foundation-2026-10-01/before-settings-light.png) | [image](audits/evidence/privacy-foundation-2026-10-01/after-settings-light.png) |
| Balance status        | [image](audits/evidence/privacy-foundation-2026-10-01/before-balance-dark.png)  | [image](audits/evidence/privacy-foundation-2026-10-01/after-balance-dark.png)  | [image](audits/evidence/privacy-foundation-2026-10-01/before-balance-light.png)  | [image](audits/evidence/privacy-foundation-2026-10-01/after-balance-light.png)  |

These images are PR review evidence, not replacements for Linux screenshot baselines. Production shielded-wallet UX has not been designed. The minimal changelog fragment covers the visible experimental row only. A development profile carrying an enabled experiment into a packaged build gets unavailable balances until it is explicitly switched off. The committed TLS fixture uses a public test-only PEM private key, not a live credential.

## Publication checks and review

The documentation publication pass reran `npm run lint` (passed), the changelog assembler suite (44 passed), new-guide/fragment Prettier checks and `git diff --check`. It did not rerun all SDK tests or submit live transactions. Both themes of the settings and synthetic balance surfaces were inspected; the experiment reuses existing row, toggle and balance-message styling. The balance information currently occupies the existing error-message surface; product design should revisit that presentation.

Claude independently audited the proposed issue and draft PR against the branch and research twice. The final verdict was ready to publish with no substantive blockers. Corrections cover live code/harness provenance, fixture and CI exclusions, legacy-profile refusal, archive/build/license limitations, historical document drift and proof-verification ownership. This is approval for a research issue and draft review, not approval to merge or release.

## Remaining release gates

Supported upstream/derivation identity and independently qualified cross-platform/distributable artifacts; audit/setup/deployment matching; full SDK/worker/native/browser egress and supported-platform qualification; live Tor relay/outage/performance; intermediate SDK scan checkpoints; portable recovery/whole-profile rollback/capacity and safe-release policy; broader operations/assets/circuits; product design and human approval. The wider roadmap includes services consent, provider hygiene, browser policy, Nym, anon-rpc/PIR and per-origin addresses. UI decisions are not prerequisites for the independent infrastructure work.

Codex materially implemented/researched the branch; Claude performed independent agent reviews including the publication drafts. Those reviews do not substitute for human accountability or an external cryptographic/security audit.

## Evidence index

The index below includes historical checkpoints as well as current follow-ups. Pair each Markdown narrative with its machine report where available; neither old “next” statements nor `qualified` fields imply production approval.

- [PPv2 adapter compatibility and process host](ppv2-adapter-process-2026-09-26.md) — [JSON](qualification/ppv2-adapter-process-2026-09-26.json)
- [PPv2 controlled ASP-outage recovery — October 1](ppv2-asp-outage-2026-10-01.md) — [JSON](qualification/ppv2-asp-outage-2026-10-01.json)
- [PPv2 bounded work and exit readiness — October 1](ppv2-bounded-recovery-2026-10-01.md)
- [PPv2 controlled native deposit](ppv2-controlled-deposit-2026-09-27.md) — [JSON](qualification/ppv2-controlled-deposit-2026-09-27.json)
- [Controlled Kohaku PPv2 session](ppv2-controlled-session-2026-09-26.md) — [JSON](qualification/ppv2-controlled-session-2026-09-26.json)
- [PPv2 exit circuit and resource qualification](ppv2-exit-circuits-2026-09-27.md) — [JSON](qualification/ppv2-exit-circuits-2026-09-27.json)
- [PPv2 durable exit reservations — October 1](ppv2-exit-reservations-2026-10-01.md)
- [PPv2 Sepolia: ready for test ETH](ppv2-funding-readiness-2026-10-01.md) — [JSON](qualification/ppv2-funding-readiness-2026-10-01.json)
- [PPv2 integration preflight](ppv2-integration-preflight-2026-09-25.md) — [JSON](qualification/ppv2-integration-preflight-2026-09-25.json)
- [PPv2 authenticated legacy exit recovery — October 1](ppv2-legacy-exit-recovery-2026-10-01.md)
- [PPv2 reviewed public transactions and note recovery](ppv2-lifecycle-2026-09-27.md) — [JSON](qualification/ppv2-lifecycle-2026-09-27.json)
- [PPv2 funded Sepolia lifecycle](ppv2-live-lifecycle-2026-10-01.md) — [JSON](qualification/ppv2-live-lifecycle-2026-10-01.json)
- [PPv2 Sepolia: checks before funding](ppv2-live-preflight-2026-09-29.md) — [JSON](qualification/ppv2-live-preflight-2026-09-29.json)
- [PPv2 live qualification prerequisites](ppv2-live-qualification-prerequisites.md)
- [PPv2 recovered-note emergency exit](ppv2-native-ragequit-2026-09-27.md) — [JSON](qualification/ppv2-native-ragequit-2026-09-27.json)
- [PPv2 controlled native withdrawal and change recovery](ppv2-native-withdrawal-2026-09-27.md) — [JSON](qualification/ppv2-native-withdrawal-2026-09-27.json)
- [PPv2 final relay handoff and durable uncertainty](ppv2-relay-handoff-2026-09-27.md) — [JSON](qualification/ppv2-relay-handoff-2026-09-27.json)
- [PPv2 empty ASP sets and resumable relay recovery](ppv2-resumable-recovery-2026-09-27.md) — [JSON](qualification/ppv2-resumable-recovery-2026-09-27.json)
- [PPv2 SDK source and offline qualification](ppv2-sdk-qualification-2026-09-25.md)
- [PPv2 withdrawal quote authentication](ppv2-signed-quotes-2026-09-28.md) — [JSON](qualification/ppv2-signed-quotes-2026-09-28.json)
- [PPv2 testnet route: continue without waiting for PP](ppv2-testnet-route-2026-10-01.md)
- [PPv2 controlled ERC-20 lifecycle](ppv2-token-lifecycle-2026-09-28.md) — [JSON](qualification/ppv2-token-lifecycle-2026-09-28.json)
- [Wallet privacy: recovery and current SDK transport](privacy-engineering-followup-2026-09-25.md)
- [Wallet privacy engineering status](privacy-engineering-status.md)
- [Wallet privacy: reconciliation and PPv2 integration boundaries](privacy-reconciliation-and-ppv2-2026-09-25.md)
- [Privacy branch review and fixes — 2026-09-28](privacy-review-fixes-2026-09-28.md)
- [PPv2 runtime integrity and reviewed history retention](privacy-runtime-retention-2026-09-28.md) — [JSON](qualification/privacy-runtime-retention-2026-09-28.json)

Additional primary records: [PP research](../research/privacy-pools-research.md), [September 28 reviewer findings](../research/privacy-branch-review-2026-09-28-reviewer.md), [runtime/retention reviewer findings](../research/privacy-runtime-retention-review-2026-09-28-reviewer.md), and the full [qualification directory](qualification/).
