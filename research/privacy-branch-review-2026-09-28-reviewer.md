# Independent review: `feat/wallet-privacy-foundation` (reviewer record)

**October 1 editorial correction:** this is a historical reviewer record. Its later “628/768 MiB” summary is not supported by the retained measurement report; the [exit-circuit qualification](../docs/ppv2-exit-circuits-2026-09-27.md) records approximately 539/599 MiB for the respective single-thread packaged proof cases. The original review text is preserved below.

**Date:** 2026-09-28
**Reviewer:** Claude (independent reviewer; the implementation is by Codex)
**Baseline:** committed `35e4a68b`, merge base `2983dc62` (17 commits, 153 files)
**Fixes:** committed as `6c8b35a821eed0c492bb95d7e2fcc73338fa1ada` ("fix(wallet): harden privacy recovery and host boundaries"). Re-reviews in §4 track the working tree before that commit; §4.8–§4.9 and §7 apply to the commit.
**Pinned upstream:** Privacy Pools v2 monorepo `fe0244e3` (SDK, circuits, contracts, relayer), local checkout `/private/tmp/freedom-ppv2-v2-sep25`

This document is owned by the reviewer. It records findings, the evidence behind them, what was accepted, and the residual risks. The implementer's docs remain the source for design intent. Throughout, production activation is gated off (unpackaged build plus `FREEDOM_WALLET_TOR_EXPERIMENT=1`, Sepolia only). Severities describe **production readiness** unless marked as reachable today.

## 1. Method and limits

- **Read in full:**
  - all added or changed `src/main/networks/*`: privacy contexts, SOCKS, Tor transport, private RPC, Kohaku provider/network/router, private balance router;
  - `privacy-session`, `ppv2-session`, `ppv2-public-operations`;
  - `ppv2-relay-{policy,handoff,journal,reconciliation}`;
  - `private-transaction-{network,intent}`, `private-submission-journal`;
  - `ppv2-note-recovery`, `ppv2-deposit-{policy,prover}`;
  - the balance service, router and cache changes; the renderer `balance-display` and settings changes;
  - the `vault`, `tor-manager`, `settings-store`, `provider-manager` and `transaction-service` diffs.
- **Sub-reviewers** (forked instances of the reviewer) covered:
  - the prover, process, worker, artifacts, storage and key modules; the job and policy files; the Kohaku compatibility patch;
  - the submission reconciler;
  - the e2e specs and fixtures, docs, qualification JSONs and scripts.

  The reviewer re-verified their top claims independently (P1, P2, M2, T1).
- **Cross-checked against pinned upstream:**
  - circuits: `Deposit.circom`, `Transact.circom`, `Ragequit.circom`;
  - contracts: `PoolVault.sol` (transact, ragequit, root and ASP checks), `Keystore.sol` (one-time auth policy), `IPoolVault.sol` (events);
  - SDK: `PoolSessionDeposit.ts`, `PoolSessionKeystore.ts`;
  - relayer: `evm.chain.service.ts` (EIP-712 domain/types, ms expiry), `evm.relay.dto.ts` (response), `common.schemas.ts` (quote lifetime), NestJS on Express 5 routing.
- **Runs:**
  - No heavy runs by the reviewer; E2E and packaged runs were left to the implementer.
  - Only targeted Jest suites, Node snippets, and the sub-reviewers' scratch probes outside the repo.
- **Not covered in depth:**
  - Linux and Windows behaviour;
  - the UI-playbook visual/theme checks;
  - a line-by-line audit of `scripts/fixtures/kohaku-ppv2-compat.patch` beyond the sub-review;
  - live-network behaviour.

## 2. Status summary

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| P2 | **High (reachable today, not gated)** | A password change while unlocked turned auto-lock off | Fixed in `6c8b35a8`; accepted |
| H1 | High | An unresolvable relay attempt froze the account, including ragequit | Fixed; accepted. Packaged E2E on `6c8b35a8` passed native and token withheld-relay → restart → reviewed exit → restart → resolve (§4.9). Public `nonce-consumed` recovery is in place. Residuals: reviewed migration of legacy relay records; a stuck-pending public transaction needs a replacement made outside the app (documented) |
| H2 | High | Registration mismatch: deposits unspendable and unexitable | Fixed; accepted. A nullifying-key mismatch refuses at open. A viewing-key-only mismatch opens, with `registrationStatus` and a reviewed `prepareRepairViewingKey`; deposits still refuse. The repair review carries `previousViewingKey`, and `replacesExistingViewingKey` is true only for a non-zero prior key (unit-tested) |
| P1 | High | Prover child received a shared 64 KiB Buffer-pool slab containing key material | Fixed, including raw-`ArrayBuffer` rejection; accepted |
| M1 | Medium | Quote deadline not rechecked before `journal.begin` | Fixed (15 s margin, bounded `beforeBegin`, deadline signal to the task); accepted |
| M2 | Medium | Transient RPC errors erased reviewed evidence | Fixed; accepted. The stale test has been updated |
| M3/P3 | Medium | Deposit `noteData` and owner not bound before signing | Fixed; accepted. Zero-change withdrawals are documented as unsupported scope (positive change enforced consistently) |
| M4 | Medium | Owner-identifying reads and settlement reads shared one isolation context | Fixed; accepted (compact revalidation, bounded concurrency, per-operation transport release). Timing-correlation residual documented |
| M5 | Medium | Tor restart left dead cached clients and a held PPv2 lease | Fixed; accepted |
| P4 | Medium | State bound to the absolute profile path; a move looks empty | Authenticated inventory guard implemented; accepted (§4.3). Rollback residual |
| T2 | Medium | E2E negative checks accept any rejection | Partly fixed. The invalid- and short-quote checks assert `PRIVATE_PPV2_RELAY_REFUSED` with no send and no reservation. `emptySetSpendBlocked`, `reorgBlocked` and `depositRefused` still accept any rejection |
| T3 | Medium | Only 300 s quotes are qualified; upstream default is 60 s (minimum 10 s) | Controlled qualification done: source and packaged E2E on `6c8b35a8` use 60 s signed quotes, and a 10 s quote is refused by the host before journaling (§4.9). A unit stress test fits 63 resolved records inside a 60 s quote. Residual: real Tor latency and relayer delivery are not established |
| T1 | Test | Earlier intermittent refusal plus hang: harness readiness race | Harness fix (`whenReady` plus 30 s bounded close) in place. The serial source runs and the 10/10 packaged run pass. The historical failure's cause is still "consistent with", not proven, as the fixes report states |
| L1 | Low (design) | Journal deletion/rollback undetected | Narrow guard via P4; whole-profile rollback documented as a residual |
| L2 | Low | `noteDigest` canonicalization | Fixed |
| L3 | Low | Fixed 5000-block page, 2048-log cap, unverified `fromBlock` | Fixed. Explicit `maxBlocks` 1–5000 retry keeps the checkpoint. `fromBlock = max(deploymentBlock, min(latest, finalized) − 1000)`, with the unverified anchors documented (§4.5). A single block exceeding the cap remains a documented limit |
| L4 | Low | Capture-only relay guard was case-sensitive | Fixed |
| L5 | Low | Inconsistent pre-checks | Fixed for deposits; ragequit intentionally exempt |
| L6 | Low | Main accepted enabling the experiment in a packaged build | Fixed (main refuses). The renderer checkbox re-sync after a refused save was not verified by the reviewer |
| L7 | Low → Medium | Redundant whole-journal re-observation on every spend | Fixed (duplicates removed; compact checks) |
| P5 | Low | DNS tripwire could be bypassed with `dns.Resolver` | Fixed as a tripwire; `process.binding` residual |
| P6 | Low | Prover code not digest-pinned | Open (provenance gate) |
| P7 | Low (docs) | "Independent" proof verification in the session path is not independent | Fixed in docs: `docs/privacy-review-fixes-2026-09-28.md` states that session proving and verification share one owned process; the separate verifier is fixture-only |
| P8 | Low | `privacy-worker.js` resolves unvalidated messages | Fixed (mandatory validator, 1 MiB result cap) |
| T4 | Low | A rejected `eth_chainId` check was cached forever | Fixed |
| T5 | Low | Temp file left behind if revoked mid-write | Open |
| D* | Docs | Stale plan lines, send-blocking scope, unverifiable byte checks | Fixed. Plan lines, send scope, coverage wording, composite source evidence and historical-note wording are corrected (§4.4, §4.8). This review's durable evidence, including per-module digests, is in `docs/qualification/privacy-review-2026-09-28.json`. The older signed-quotes JSON stays historical with `matched: true` only. The Tor "exactly one circuit" suggestion is withdrawn |

## 3. Findings

### P2: password change disabled auto-lock (High, reachable today)
- **Where:** baseline `vault.js:147-152` and `changePassword` at `:218-220`.
- **Cause:** `changePassword` called `unlockVault(dataDir, pw, 0)`. `unlockVault` newly called `lockVault()`, which clears the timer, then `resetAutoLockTimer(0)`, which arms nothing. The base commit preserved the timer.
- **Evidence:** a sub-reviewer probe (unlock with 300 ms, change password, wait 700 ms): HEAD stays unlocked; base auto-locks.
- **Fix (accepted):** `decryptVaultMnemonic` is split out, and `changePassword`/`deleteVault` verify without touching lock state, the timer or the session signal. Tests cover the preserved deadline and signal, and a locked vault staying locked.
- **Behaviour change:** `changePassword` on a locked vault no longer unlocks it. No caller relies on the old behaviour.

### H1: an unresolvable relay attempt froze the account and blocked the emergency exit (High)
- **Baseline code:**
  - `ppv2-relay-reconciliation.js:93` resolved only `included`.
  - `ppv2-relay-journal.js:77,83` blocked while any attempt was unresolved.
  - `ppv2-session.js:271` applied that block to all public operations.
  - `ppv2-session.js:276-277` refused ragequit of any commitment with a journal record.
- **Chain facts:**
  - Ragequit and transact spend the same nullifier `Poseidon(nk, commitment)` (`Ragequit.circom:120-123`, `Transact.circom:229-233`, `PoolVault.sol:170-173,219-220`), so at most one of the withheld relay proof and the ragequit can land.
  - Transact requires the latest ASP root (`PoolVault.sol:356`). That is not a definitive failure criterion, because roots can recur.
- **Scenario:** a relayer 4xx after `begin` (expired quote, simulation failure, rate limit) or a relayer withholding the payload made the account's withdrawals, deposits, approvals and ragequits permanently unavailable in-app.
- **Public-side analogue:** a crash between `begin` and send, or a dropped or replaced tx, left a record that could never resolve (`private-submission-journal.js:87-89`).
- **Agreed design, now implemented:**
  - A reviewed ragequit is allowed while an attempt is unresolved, for the attempted note and for other notes. The review is told that a competing relay may win.
  - A relay `exited` resolution requires all of:
    - a `Ragequit` event matching `IPoolVault.sol:89-96`, with `ragequitter == owner`, the same commitment, `value == inputValue` and a matching asset;
    - a receipt from the owner to the pool with no `Note` logs;
    - a non-zero `spentNullifiers`;
    - a canonical block.
  - Public side: `nonce-consumed` is taken at a finalized anchor and stated as not distinguishing the original from a replacement. It permits only a reviewed next nonce, never a retry.
  - Abandon-by-expiry or root-change was rejected (a recurring root or late relay stays unsafe). The reviewer agrees.
- **Residuals:**
  1. Legacy relay records without `owner`/`inputValue` can only become `conflict`; migration must be reviewed.
  2. A stuck-pending public tx still needs a replacement made outside the app; document it.
  3. ~~E2E must confirm the SDK does not mark the note `spent`/`exit_pending` after a capture-only or failed relay.~~ Confirmed: the withheld-relay ragequit prepares and exits in packaged E2E (§4.9).

### H2: registration mismatch made deposits unspendable and unexitable (High)
- **Chain facts:**
  - `Keystore._setAuthPolicy` is one-time (`nullifyingKeys[account] == 0`, `Keystore.sol:206`). `updateAuthPolicy` changes only `authDigest`.
  - Ragequit and transact prove the keystore leaf `(owner, privateNullifyingKey, authDigest)` (`Ragequit.circom:74-95`).
- **Baseline:** only non-zero slots were checked (`ppv2-public-operations.js:84-89`). The SDK's `isKeystoreRegistered` is also only non-zero (`PoolSessionKeystore.ts:88-100`).
- **Non-malicious triggers:**
  - the same owner with a different `accountIndex`;
  - an `APP_IDENTIFIER` or derivation change (a listed release gate);
  - an owner previously registered by another PPv2 app.
- **Fix (accepted for the nullifying key):**
  - `candidate.inspectRegistration` derives `nullifyingKeyHash`/`authDigest`/`viewingKey` from the session keystore.
  - On-chain values are compared at session open, at deposit prepare, before deposit review and after approval.
  - Registration calldata is bound to the same values, and the review shows `accountIndex`.
  - Computing via the pinned candidate is an explicit trusted-pinned-SDK assumption.
- **Open concern:** a viewing-key-only mismatch (updatable via `setViewingKey`, `Keystore.sol:122-127`) currently fails session open, which also blocks exits of otherwise spendable notes. Recommended: keep the nullifying-key mismatch as a hard refusal. For a viewing-key-only mismatch, open with a flag, refuse deposits and registration, and offer a reviewed `setViewingKey`.
- **Residual:** `authDigest` is not compared on-chain. It is recoverable via `updateAuthPolicy` and fails closed when proving; document it.

### P1: key material crossed into the prover process through the Buffer pool (High; not a sandbox claim)
- **Where:** `privacy-artifacts.js:47` (`Buffer.allocUnsafe`), `privacy-storage.js:20` (`Buffer.from(key)`), `isolated-socks.js:59` (`Buffer.from(token)`) and `privacy-process.js:87` (`postMessage`).
- **Mechanism, verified:**
  - Node v24.18.1 has `Buffer.poolSize === 65536`.
  - A 3744-byte verification key and a 32-byte key copy share one backing store.
  - `structuredClone` copies the whole 64 KiB, with the key bytes visible. The sub-reviewer's Electron `utilityProcess` probe shows the same.
- **Why it matters:** the pinned SDK already runs in main, so this grants it no new capability. But the documented boundary ("only scalar witness strings and artifacts enter the process") was false: storage/journal keys and isolation tokens could be copied into another process's heap.
- **Fix (accepted):**
  - `Buffer.alloc` for artifacts;
  - `Buffer.alloc` + `copy` for the storage secret;
  - `Buffer.alloc` for the SOCKS auth frame, zeroed after the write;
  - an `ownsInputBuffers` check before fork and again at spawn.
- **Agreed follow-up:** reject raw `ArrayBuffer`s at process inputs, and pin each job's input shape in tests. Shape cannot prove provenance: a full view deliberately created over a slab would be misconduct by trusted main code.

### M1: quote deadline not rechecked before durable journaling (Medium)
- **Where:** baseline `ppv2-relay-handoff.js:43-49`. `beforeBegin` (`availableToSpend`, Tor I/O) ran after the review deadline check, and expiry was detected only after `journal.begin`. The result was a durable, unresolvable record of a payload that was never sent.
- **Evidence:** reproduced by the implementer (`/private/tmp/privacy-review-relay-deadline-before.log`).
- **Fix (accepted):**
  - `HANDOFF_MARGIN_MS = 15000`;
  - review and `beforeBegin` both bounded by `beforeDeadline`;
  - an explicit pre-`begin` check.
  - The reviewer ran the handoff suite: 46/46.
- **Follow-ups:**
  1. A positive boundary test: `beforeBegin` inside the margin still sends once.
  2. Apply the margin at `prepare` and `submit` entry, too.
  3. Pass an abort signal into `beforeBegin`, so the timed-out pass stops its journal writes (availability only).

### M2: transient RPC errors erased reviewed evidence (Medium)
- **Where:**
  - Baseline `ppv2-relay-reconciliation.js:85` turned errors into `unknown`, and `ppv2-relay-journal.js:96-97` then cleared the resolution and scan.
  - The public reconciler wrote a `null` receipt as `reorged` (pruned index, lagging node).
  - A sub-reviewer reproduced this in scratch.
- **Agreed policy:** keep revalidation before spends, and never treat unverified finality as permanent. On read failure, write nothing and block this spend. Clear a resolution only on positive contrary evidence.
- **Fix (accepted):**
  - Relay: throws on missing finalized/anchor/receipt/canonical data; a missing match at a known block is not evidence; a changed anchor hash gives `conflict`.
  - Public: a missing receipt is revalidated through the stored block's hash and its `transactions` list.
- **Test to update:** `private-transaction-network.test.js:181` still simulates a reorg with `receipt = null`, and now correctly gets `PRIVATE_RECONCILIATION_UNAVAILABLE`. Split it into two cases:
  1. unchanged block → `UNAVAILABLE`, no write;
  2. changed hash → `reorged` → `UNRESOLVED`.

### M3/P3: deposit `noteData` and owner not bound (Medium)
- **Background:**
  - The self-deposit path (`PoolSessionDeposit.ts:105-130`) uses random `noteSecret`/`depositSecret` and encrypts to the local viewing key. The on-chain lookup at `:384` is deposit-for only.
  - `noteData` is therefore the only independent restore artifact for the secrets ragequit needs.
  - The proof binds commitment/token/value/`keccak(noteData)`, but `noteAddressHash(owner, noteSecret)` is private (`Deposit.circom:23`).
- **Fix (accepted):** the prover requires `inspectNote`, which is the candidate's `inspectChange`. It recomputes the commitment from `computeNoteAddressHash(owner, decrypted noteSecret)`, token, value and label, and compares with `publicSignals[0]`, the amount and the token. It fails closed without the inspector.
- **Residuals (documented by the implementer):**
  - Zero-change withdrawals are now refused (`amountSent >= inputValue`; `validSettlement` requires `inputValue > amountOut`), whereas upstream allows them (`Transact.circom:239-251`, `selectNotesForFullWithdraw.ts`). Documented as unsupported scope in `docs/privacy-review-fixes-2026-09-28.md`; the positive-change rule predates this review (baseline `ppv2-transact-policy.js:22`).
  - `_aspCiphertext` remains SDK-trusted (length check only).

### M4: owner-identifying and settlement reads shared one isolation context (Medium, privacy)
- **Baseline:**
  - Owner reads (`nullifyingKeys`/`viewingKeys(owner)`, `allowance`/`balanceOf(owner)`) and withdrawal-settlement reads (relay receipt, `spentNullifiers`) all used `protocol-rpc`: one token, one circuit, one endpoint.
- **Fix (partial, accepted):**
  - Keystore and configured ERC-20 reads are routed by target to the owner's `transaction-rpc` context.
  - Settlement reads use per-attempt `operation` contexts.
- **Residuals:**
  - (a) The SDK's account-agnostic keystore reads made while proving now appear on the owner's circuit, so timing correlation with a withdrawal remains. Document it.
  - (b) **Liveness, being addressed:** `availableToSpend` ran three times per withdrawal (including inside the M1 deadline). Each run re-observed every resolved relay record, each on a fresh circuit, plus every public record. As history grows, a 60 s upstream quote cannot survive `beforeBegin`. The transport caps groups at 32 with a 30 s idle period.
- **Implementer's plan:**
  - remove duplicate public reconciliations and the redundant submit-entry full check;
  - keep fresh checks after review;
  - bounded concurrency for historical records;
  - compact canonical-block revalidation of already-reviewed relay records;
  - explicitly release per-operation transport groups.
- The reviewer's assessment of the compact check is in §5.6.

### M5: Tor restart left dead cached clients and a held session lease (Medium, liveness)
- **Fix (accepted):**
  - The PPv2 scope's lifetime includes the endpoint signal, and `isCurrent` checks endpoint identity.
  - `getPrivateTransactionNetwork` evicts aborted clients.
  - `chainCheck` resets on failure (T4).

### P4 and L1: state bound to the absolute profile path; deletion or rollback undetected (Medium / design)
- **Where:**
  - `profileId = sha256([profile.id, userDataDir])` (`privacy-session.js:14`, `ppv2-keys.js:22-23`) feeds the storage AAD, file names and KDF.
  - A missing file reads as `{}` (`privacy-storage.js:30`).
  - A moved profile, or a deleted journal, silently drops the unresolved-attempt gates.
- **In progress:** an authenticated profile inventory guard (`privacy-profile-guard.js`) wired into all three storage factories: a marker recording the path-derived identity, plus a manifest of initialized store files. It refuses legacy stores without a marker, and needs an explicitly reviewed migration.
- **Reviewer requirements for it to fail closed without false permanent lockout:**
  1. Authenticate the marker and manifest with a vault-derived key. Fail closed if they are unauthenticated or edited, or if store files exist without a marker. Only "no marker and no files" is fresh.
  2. Add a manifest entry only after the file's first durable write. Listed but missing → fail. Present but unlisted → accept if it authenticates for this binding, then record it.
  3. Cover the SDK store, the relay journal and the submission journal.
  4. Use a specific error code.
  5. Document the residual: deleting the whole privacy tree including the marker, or rolling back the full profile, still looks fresh. A legitimately moved profile stays blocked until a separate recovery design exists (a stable portable identity and an anti-rollback root).

### T1: earlier intermittent token refusal and teardown hang (test harness)
- **Root cause (high confidence, verified):**
  - `launchApp` (`test-e2e/fixtures.js:47-50`) returned before Electron readiness, and the specs evaluated immediately.
  - Playwright's loader reports `app.isReady()` false until its ready step (`playwright-core/lib/server/electron/loader.js:106-115`).
  - `runPrivacyProcess` refuses before `ready` (`privacy-process.js:21`), and `ppv2-session` masked that as `PRIVATE_PPV2_OPERATION_FAILED`.
  - Under concurrent CPU load, `ready` arrived late.
  - The surviving profile's logs show the relaunched app never ran `bootstrap()`, and the journals show failure within about 1 s, before proving could finish.
- **The hang:** closing a never-ready app. The Electron-level reason it never exits is not established.
- **Fix in working tree:** `launchApp` awaits `app.whenReady()` with a bounded timeout, and `close()` is bounded to 30 s, SIGKILLing only its own child. Confirmed by the serial source runs and the 10/10 packaged run (§4.9).
- Refusing to prove before `ready` is correct product behaviour.

### T2: negative checks accept any rejection (Medium, test quality)
- **Where:** `invalidQuoteBlocked`, `emptySetSpendBlocked`, `reorgBlocked` and `blocked` (`ppv2-withdrawal.spec.js`), and `depositRefused`/`blocked` (`ppv2-token-deposit.spec.js`).
- In the T1 run, the invalid-quote check would have "passed" without signature verification running.
- **Fix:** assert the specific code and that the expected proofs ran. Add a sanitized, test-mode-only internal cause record.

### T3: quote lifetime not qualified at upstream defaults (Medium)
- The upstream relayer's `quoteExpirationTimeMs` defaults to 60 000, with a minimum of 10 000 (`common.schemas.ts:14-18`).
- The SDK fetches the quote before two proofs. Review, `beforeBegin` and the 15 s margin then follow.
- Fixtures use 300 s.
- **Fix:** qualify end to end at 60 s and 10 s. Consider checking the quote signature before the final proof.

### Low items
- **L2 (fixed):** `noteDigest` is normalized to lowercase `{hint, data}` on both sides.
- **L3 (open):**
  - Fixed 5000-block pages and a 2048-log cap (`ppv2-relay-reconciliation.js`, `kohaku-provider.js:74,76`) stall discovery on busy pools or RPCs with range limits; use adaptive bisection.
  - `fromBlock` comes from the unverified latest block (`ppv2-session.js`); use `min(latest, finalized)` minus a margin.
- **L4 (fixed):** the capture guard decodes and normalizes the path and matches case-insensitively. The relayer's Express 5 routing is case-insensitive. A malformed `%` fails closed.
- **L5 (fixed for deposits):** native deposit preparation now calls `availableToSpend`. Ragequit preparation is intentionally exempt so exits are not blocked.
- **L6 (fixed):** `saveSettings` refuses to enable an unavailable experiment. Confirm the renderer re-syncs the checkbox.
- **L7 (in progress, with M4):** one send re-observed each public record about 3×, and resolved relay records 2×, before M4 made each relay observation a new circuit.
- **P5 (fixed as a tripwire):** `Resolver.prototype`, `reverse*` and dgram are patched. `process.binding('cares_wrap'/'tcp_wrap')` remains a bypass; the docs already state this is not a sandbox.
- **P6 (open):** `require(sdkEntry/proverEntry)` has no digest check. The scratch ASAR sits in a user-writable temp directory, and the clean-tree check ignores the gitignored `dist/`. This is a provenance gate before production.
- **P7 (open, docs):** the session's `verifyProof` compares the proof with the one the same child reported as verified. `ppv2-relay-verify-job.js` (separate process) is used only in `ppv2-relay.spec.js`. Either use it, or correct the "independent verification" wording.
- **P8 (open):** `privacy-worker.js:44` resolves any message with no validation or bound. There is no production caller.
- **T4 (fixed):** a rejected `chainCheck` is reset.
- **T5 (open):** revocation between the temp write and the rename leaves an encrypted temp file behind (`privacy-storage.js:75`).
- **Minor (open):**
  - a deadline timeout is reported as `PRIVACY_REQUEST_ABORTED`;
  - `O_NOFOLLOW` is a no-op on Windows;
  - a second `progress` message fails the job;
  - the relay journal hard-caps at 64 records;
  - storage caps become hard sync failures;
  - the relay `resolve` review has no deadline, unlike the public reconciler.

### Documentation items (as originally found; current status in §2, row D*, and §4.4)
- `docs/wallet-privacy-implementation-plan.md:175` still lists completed work as "Next". `:77` reads as if PPv2 SDK access were unresolved today.
- The "blocks public sends" claims cover only sends through the PPv2 session. Ordinary wallet sends from the same owner are not blocked, so a nonce collision is possible. State this.
- The package byte checks in `docs/qualification/ppv2-signed-quotes-2026-09-28.json` record only `matched: true`. Record the digests and HEAD.
- The signed-quotes doc's "cause not established" can cite T1 once E2E confirms it.
- `scripts/qualify-wallet-tor.js`: the same-context reuse check (`size < 3`) is weak; assert exactly one circuit.

## 4. Re-review log

### 4.1 M1 (handoff diff), accepted
46/46 handoff tests (reviewer run). The fix and follow-ups are as in §3.

### 4.2 Working tree: H2, M3, P1, P2, M4, M5, M2, H1 (early look)
- **Reviewer's run:** 12 targeted suites, 263 pass, 2 skipped, 3 fail.
  - Two failures are the known `settings-store` shortcut-remap baseline.
  - One is the stale M2 test at `private-transaction-network.test.js:181` (§3, M2).
- **Implementer-reported:**
  - H2/M3: 50 pass (`/private/tmp/privacy-review-deposit-tests.log`);
  - vault: 32 pass (`/private/tmp/privacy-review-vault-after.log`);
  - process/storage/Tor/session: 40 pass (`/private/tmp/privacy-review-process-tor.log`).
- Outcomes are recorded per finding in §3.

### 4.3 Working tree: profile guard, compact reconciliation, H2 repair, L3, P8, deadline signal
- **Evidence:**
  - Implementer logs, read by the reviewer: `/private/tmp/privacy-review-inventory-tests.log` (8 suites, 124/124, `--runInBand`) and `/private/tmp/privacy-review-compact-tests.log` (5 suites, 130/130).
  - The reviewer did not re-run tests, to avoid CPU contention with the implementer's final E2E (the T1 failure mode).

#### Profile inventory guard (`privacy-profile-guard.js`): accepted
- **Authentication:**
  - The marker is HMAC'd with a key derived from the vault seed plus `profile.id`, deliberately excluding the path, so a moved marker still authenticates and is then recognised as `PRIVATE_PROFILE_MOVED`.
  - The MAC is compared in constant time, and the key is zeroed on context revocation.
- **Fail-closed cases:**
  - marker absent while any store directory is non-empty → `PRIVATE_PROFILE_INVENTORY_MISSING`; this also refuses legacy stores until a reviewed migration exists;
  - a listed file is missing → `PRIVATE_PROFILE_STORE_MISSING`;
  - a modified or foreign marker → `INVALID`.
- **Durability and ordering:**
  - The marker write uses a temp file, fsync, rename and directory fsync.
  - `privacy-storage` calls `assert` before reading (a listed-but-missing file cannot read as empty). It calls `remember` only after a file authenticates or after a durable write, so a crash between a store write and the inventory update is adopted, not locked out.
  - All marker updates are synchronous read-modify-write, so the three guard instances sharing one marker cannot lose updates.
- **Wiring:** the SDK store, relay journal and submission journal are all wired.
- **Tests cover:** each store's missing file, a moved profile, a missing, modified or foreign marker, crash adoption, and authentication before adoption.
- **Minor:**
  - `profileGuard` is optional in `createPrivacyStorage`. All production factories pass it; consider requiring it for the three production directories.
  - Leftover temp files (T5) in a marker-less store directory also fail closed. That is acceptable.
- **Residual (documented):** deleting the whole privacy tree including the marker, or rolling back the full profile, still looks fresh. A legitimately moved profile stays blocked until the separate recovery design exists.

#### Compact revalidation
- **Relay** (`ppv2-relay-reconciliation.js`) — accepted as meeting the §5.6 conditions:
  - it checks the stored height and hash exactly;
  - a missing block throws without writing, and a changed hash gives `conflict`;
  - four records at a time, each on its own operation context, with the transport group released in `finally`;
  - no write after abort; the batch is drained before an error is surfaced.
  - The 63-record / 250 ms / 60 s quote unit test passes (implementer).
- **Public** (`private-submission-reconciler.refreshResolved`) — accepted:
  - resolved records only, with the shared head and two concurrent queries;
  - it keeps `nonce-consumed` anchors and their `finalizedNonce`;
  - a changed hash gives `reorged`.
  - `assertCanSubmit` refreshes only resolved records, which is equivalent because the journal already refuses while anything is unresolved.
- **Optional refinements:**
  1. A matching compact check still rewrites the record (fsync plus revision bump) although nothing changed; skipping the write would cut I/O.
  2. A response whose block `number` differs from the queried height is RPC misbehaviour rather than reorg evidence. Both paths currently revoke on it (tested as intended). This is safe, but costs a fresh review; `unavailable` would match the M2 policy more closely.
  3. The privacy caveat in §5.6 about historical-height bursts still applies; keep it documented.

#### `beforeBegin` deadline signal: accepted
`beforeDeadline` passes `AbortSignal.any([context, controller])` to the task and aborts it in `finally`. `availableToSpend(signal)` checks the signal, so a timed-out pass cannot write late.

#### H2 viewing-key repair: accepted
- `checkRegistration()` at open refuses only a nullifying-key mismatch, and returns `{ nullifyingKeyHash, viewingKey }` match flags.
- Deposits require both keys to match.
- `prepareRepairViewingKey` is allowed only when the nullifying key matches and the viewing key does not. It issues a single `setViewingKey(expected)` through the existing reviewed registration path.
- **Suggestion:** add a review field such as `replacesExistingViewingKey` (with the prior on-chain value), so the reviewer knows that incoming discovery bound to the old key will change.

#### P8: accepted
`runPrivacyWorker` requires `validateResult` and caps results at 1 MiB (V8-serialized size).

#### L3: partly accepted, with one new liveness concern
- The explicit `maxBlocks` (1–5000) retry keeps the checkpoint. Accepted.
- `fromBlock = config.deploymentBlock` for every new attempt means discovery scans from the pool's deployment, one page per `observeRelayAttempt` call.
  - For a deployment around a million blocks old, that is hundreds of calls, each with about 6 RPCs on a fresh circuit, before a lost-response withdrawal can be reconciled.
  - Under the single-RPC model this does not add trust: an RPC that lies about heads can equally hide logs.
- **Suggestion:** `fromBlock = max(deploymentBlock, min(latest, finalized) at prepare time − margin)`. The relay transaction cannot land before the payload exists. Alternatively, allow several pages per call within a time budget.

### 4.4 Refinements and docs (`docs/privacy-review-fixes-2026-09-28.md`, plan, roadmap, status)
- **Evidence:**
  - Implementer's `/private/tmp/privacy-review-final-focused.log`: 3 suites, 103/103, including the 63-record signed 60 s quote stress test.
  - The final E2E and full regression were still running at the time of this entry; not re-run by the reviewer.
- **Wrong-height responses: accepted.** They now throw and preserve history on both compact paths (`ppv2-relay-reconciliation.js:32`, `private-submission-reconciler.js:105`); only a hash mismatch at the correct height revokes.
  - Minor consistency point: the full inspection path still treats `canonical.number !== receipt.blockNumber` as `conflict` (`ppv2-relay-reconciliation.js:113`).
- **Session open: accepted.** It now passes the fixed `PRIVATE_PROFILE_*` codes through (`ppv2-session.js:325-326`).
  - Mid-session guard errors inside `call()` are still masked as `PRIVATE_PPV2_OPERATION_FAILED`. That is acceptable, but less diagnosable.
- **Fixes report accuracy, checked against code:**
  - The margin at prepare and submit entry (`ppv2-relay-handoff.js:95,103`) is correct.
  - The Electron backing-size assertion (`scripts/fixtures/ppv2-process-job.js:56`) is correct.
  - "Positive change predates this review" is correct: baseline `ppv2-transact-policy.js:22` requires `outputValue[0] > 0n`.
  - The proof-verification scope and the ordinary-send nonce scope are now stated accurately.
- **Withdrawn suggestion:** "assert exactly one circuit" in `scripts/qualify-wallet-tor.js`. Arti may legitimately use several circuits for one isolation group (for example rotation), so same-context reuse is a performance expectation, not a security property. The script already fails hard on any cross-context circuit overlap (`:94`), which is the isolation property.
- **Remaining doc suggestions:**
  1. The fixes report and the roadmap link to `research/privacy-branch-review-2026-09-28-reviewer.md`, but `research/` is gitignored (`.gitignore:33`). Track this file explicitly, as the five research files are, or the links dangle in the committed tree.
  2. Wording: "reviewed … including the pinned upstream SDK, circuits, contracts and relayer" and "cover the complete branch" should say the relevant upstream sources were cross-checked, and point to §1 of this record for exclusions (platforms, UI visual checks, a line-by-line compat-patch audit).
  3. The limitations list should also carry the T2 residual (non-quote negative checks), and the L3 liveness cost of starting settlement discovery at `deploymentBlock` on long-lived pools.

### 4.5 Final refinements (source E2E still in progress at this entry)
- **Implementer-reported:** native and token withheld-relay recovery passed source E2E with 60 s quotes and a 10 s refusal; token normal and ERC-20 deposit flows passed too (`/private/tmp/privacy-review-source-recovery-final.json`). The native normal, lifecycle and deposit fixtures were being re-run after fixture and ordering fixes.
- **L3 `fromBlock`: accepted.**
  - `ppv2-session.js:161-165` sets `max(deploymentBlock, min(latest, finalized) − 1000)`, from provider-validated block numbers, read before proving. The relay transaction cannot land before its payload exists.
  - The fixes report documents that these anchors are unverified.
  - This removes the full-history scan cost from §4.3.
- **H2 repair review flag: accepted, one nit.** The review now carries `replacesExistingViewingKey`. But `repairViewingKey` sets it to `true` even when the on-chain viewing key is unset (a partial registration). The flag is only accurate when the prior on-chain value was non-zero; have `checkRegistration` expose whether it was set.
- **`call()` error codes: accepted.** The fixed host codes now pass through with fixed messages (`ppv2-session.js:258-261`). SDK exceptions are still collapsed; a spoofed `code` on an SDK error could only mislabel an error, not leak data.
- **Docs: accepted.**
  - The coverage wording now says the relevant upstream sources were cross-checked and points to §1 for exclusions.
  - The limitations list the T2 residual (older non-quote negative fixtures), the unverified L3 anchors, P6 (candidate strings are not code authentication; the scratch ASAR is not a distribution chain), P7's scope and zero-change withdrawals.
  - The implementer will force-add this record at commit, which resolves the dangling-link point in §4.4.
- **Status:** all High and Medium findings are fixed or accepted with documented residuals. Closing the review still needs the final native source re-runs, the packaged runs and the full regression (the baseline had 3 known failures).

### 4.6 Final E2E triage (test fixtures; no product defect)
- **`ppv2-deposit.spec.js` reopen failure (`post-setup, registered=true`).**
  - Since the compat patch, `createPPv2Plugin` re-checks the owner's auth history on *every* open once `isKeystoreRegistered()` is true (`scripts/fixtures/kohaku-ppv2-compat.patch:569-573`).
  - `discoverOwnerRevocableKeyIndex` then calls `KeystoreInteractor.getCurrentAuthorizerDigest(owner)`, which paginates `KEYSTORE_AUTH_EVENTS_ABI` logs from `deploymentBlock`. With no matching `AuthPolicySet`/`AuthPolicyUpdated` log it throws "Registered owner has no auth policy history" (`patch:165`), which the session masks as `PRIVATE_PPV2_UNAVAILABLE`.
  - The spec began returning real `nullifyingKeys`/`viewingKeys` once `registered` was set, but its `eth_getLogs` still returns `[]`.
  - **Fix (test only):** serve one `AuthPolicySet(owner, nullifyingKeyHash, authDigest)` log from the keystore once registered, as `scripts/spike-ppv2-session.js:195-201` does.
  - Product behaviour (refusing a registered owner without auth history) is correct and fails closed.
- **Residual (performance and liveness, production):** every session open for a registered owner scans the keystore's entire auth-event history from `deploymentBlock`. Through the restricted provider's 5000-block pages, that is hundreds of RPCs on a long-lived deployment. Consider a verified, persisted high-water mark, rechecking only newer blocks.
- **`shortQuoteBlocked` intermittently false.**
  - A 10 s quote can make the refusal code depend on timing:
    - if proving outlasts the quote, the SDK or broadcaster refuses before capture, which `call()` masks as `PRIVATE_PPV2_OPERATION_FAILED`;
    - otherwise the host's `gate.prepare` margin check refuses with `PRIVATE_PPV2_RELAY_REFUSED`.
  - Both outcomes are safe, and the no-send and no-reservation assertions must stay strict.
  - For a deterministic host code, check `op.relayParams.selectedQuote.expiration` against `now + HANDOFF_MARGIN_MS` right after `prepareUnshield` returns and before `broadcast`, refusing with the host code. This is also T3's "check before broadcast" point.
  - **Implementer's diagnostic** accepts host `RELAY_REFUSED`, or `OPERATION_FAILED` only when the elapsed time since the call started is at least 10 s. In both cases it requires zero journal records and zero relay HTTP, followed by a passing valid 60 s flow. The reviewer agrees with the structure. Refinement:
    - The pinned SDK's `assertFeeCommitmentLive` refuses exactly when `expiration <= Date.now()`, with no buffer (`packages/sdk/src/utils/RelayerQuotes.ts:119-123`), once before proving and again before the relay POST.
    - The quote is fetched *after* the call starts, so "elapsed from the call ≥ 10 s" can also accept an unrelated SDK failure in the window between 10 s after the call started and 10 s after the quote was issued.
    - Tighter condition: record the fixture relayer's signed `expiration` for the short quote, and accept `OPERATION_FAILED` only if the rejection time is at or after that `expiration`. It is the same process clock, so it matches the SDK's own rule.
- **Applied and accepted.**
  - `ppv2-withdrawal.spec.js:149,230-237` records the fixture relayer's signed short-quote `expiration`. It accepts `OPERATION_FAILED` only when `rejectedAt >= expiration` and reports the elapsed time for information only. The zero-journal and zero-HTTP checks are unchanged.
  - The deposit mock's `AuthPolicySet` log is at `deploymentBlock + 1`, filtered consistently (`ppv2-deposit.spec.js:50-51`).
- **H2 flag follow-up: accepted.** `repairViewingKey` passes the on-chain value (`checkRegistration` exposes `registeredViewingKey`). `replacesExistingViewingKey` is `BigInt(previous) !== 0n`, and the review receives `previousViewingKey`. There is a unit test for a missing key (flag false, previous zero). Minor: the rotated-key test could also assert that `previousViewingKey` equals the on-chain value.

### 4.7 Final source evidence: freshness check (reviewer, read-only)
The nine target source scenarios all have a passing run, but on **four different working trees**. Compared against production-module modification times (local time, 2026-09-28):

| Run (start) | Passing scenarios | Production modules changed *after* the run started |
| --- | --- | --- |
| `privacy-review-source-final.json` (13:26:21) | process, relay | `vault.js`, `ppv2-relay-reconciliation.js`, `private-submission-reconciler.js` (13:29:42); `ppv2-session.js` (13:33:57); `ppv2-public-operations.js` (13:37:27) |
| `privacy-review-source-recovery-final.json` (13:30:05) | token reset/approval/deposit | `ppv2-session.js` (13:33:57); `ppv2-public-operations.js` (13:37:27) |
| `privacy-review-source-confirmed.json` (13:34:41) | lifecycle; native normal; native withheld-exit; token normal | `ppv2-public-operations.js` (13:37:27) |
| `privacy-review-source-final-two.json` (13:43:42) | native deposit; token withheld-exit | none (final tree) |

- The later changes are small: the review-payload fields for viewing-key repair, error-code pass-through, `fromBlock` anchors, and wrong-height handling.
- But `ppv2-public-operations.js` sits on every public-operation path (registration, deposit, approval, ragequit), and `ppv2-session.js` sits on every flow.
- **Conclusion:** 7 of the 9 scenarios have no passing evidence on the final tree. Before recording the source qualification as final, run all nine serially **once on the committed tree**, recording HEAD, and then the packaged checks.

### 4.8 Fix commit `6c8b35a8` ("fix(wallet): harden privacy recovery and host boundaries")
- **Full regression** (`/private/tmp/privacy-review-full-final.log`): 5,783 passed, 33 skipped, 3 failed. The failures are exactly the baseline three: the two `settings-store` shortcut-remap cases and the Safe fork send orchestrator. Pre-existing "Cannot log after tests are done" warnings remain.
- **Lint:** the implementer reports `npm run lint` clean. The reviewer independently ran `npx eslint` on every JS file changed between `35e4a68b` and `6c8b35a8`: exit 0.
- **Source scenarios:** `/private/tmp/privacy-review-source-summary.json` (written 13:46) is a **consolidation of earlier runs** (for example, deposit 4 319 ms and token withheld-exit 44 248 ms are the `final-two` results). It is not a fresh run on `6c8b35a8`.
  - No production module changed after 13:37:27, so the two `final-two` scenarios (13:43) ran on the committed code.
  - The other seven ran on earlier trees (§4.7).
  - Final-tree evidence for all nine is supplied by the packaged run on the byte-identical archive (§4.9), and the source summary is labelled composite.
- **Offline real-SDK session/rotation spike** (`/private/tmp/privacy-review-session-spike.json`): passed, with real Kohaku factory and SDK and a synthetic mnemonic. Rotation indices were recovered and a stale cache was rechecked; 0 ambient network attempts (implementer-reported).
- **Package byte comparison (`/private/tmp/privacy-review-package-digests.json`): independently verified.**
  - Code commit `6c8b35a821eed0c492bb95d7e2fcc73338fa1ada`.
  - The `app.asar` SHA-256 `e004144e7e14d943be732f1b57ae92b173e93cab7b488eec0c8102459e1f4951` equals the reviewer's `shasum` of `dist/mac-arm64/Freedom.app/Contents/Resources/app.asar`.
  - The record covers all 50 production modules changed on the branch (`git diff --name-only 2983dc62 6c8b35a8 -- src/main`, tests excluded); none is missing.
  - Every `sourceSha256` equals the SHA-256 of the committed blob at `6c8b35a8`.
  - Every `packagedSha256`, recomputed by the reviewer from the archive with `@electron/asar`, is identical.
- **Docs:**
  - `docs/privacy-review-fixes-2026-09-28.md:41` now labels the source result a composite (closeout condition 3).
  - The historical checkpoint notes say "update the status of" rather than "supersede".
### 4.9 Packaged qualification on `6c8b35a8` (`/private/tmp/privacy-review-packaged-final.json`)
- **Run:** started 2026-09-28T11:48:54Z, duration 243 s. `expected=10, unexpected=0, skipped=0, flaky=0`, no errors, and every test passed on its first attempt (no retries).
- **Tests:** packaged preflight plus the nine scenarios:
  - process;
  - relay;
  - native deposit;
  - lifecycle;
  - token reset/approval/deposit;
  - native and token normal withdrawal;
  - native and token withheld-relay → restart → reviewed exit.
- **The archive is byte-identical to the committed source (§4.8).** This run therefore supplies final-code evidence for all nine scenarios, including the seven whose source runs predate the final edits.
- **Reviewer inspection of the attached reports:**
  - Every report has `packaged: true`, and every report that records the gate has `productionGate: false`. The deposit report shows `jobFromAsar: true` and `sdkFromAsar: true`, and no live transaction was submitted.
  - All four withdrawal variants:
    - invalid and short quotes refused, with the short quote refused deterministically by the host (`PRIVATE_PPV2_RELAY_REFUSED`);
    - the lost response becomes `PRIVATE_PPV2_RELAY_UNCERTAIN`, and the gate then blocks with `PRIVATE_PPV2_RELAY_UNRESOLVED`;
    - exactly one relay send; proof and quote signature verified.
  - Withheld variants:
    - the ragequit review carries `pendingRelayCancellation`/`competingRelayMayWin`;
    - after restart the exit persists, and it resolves only through a required review with observation `exited`;
    - zero further relay sends.
  - Token lifecycle: the zero-reset approval refuses the deposit until the exact approval exists; uncertain broadcasts are journaled; the token ragequit reaches `exited`.
  - Process and deposit: lock cancellation gives `PRIVACY_CONTEXT_REVOKED`, with no surviving prover processes.

## 5. Answers to implementer questions

### 5.1 Is the registration calldata / non-zero check acceptable as a trusted-SDK assumption?
No. The nullifying key is immutable per owner, and the non-malicious triggers are realistic, so the chain must be compared with the session's derived keys. Implemented (H2).

### 5.2 Should deposit `noteData` be decrypted and bound like the withdrawal change note?
Yes, as a recovery invariant rather than a sandbox claim. Implemented (M3).

### 5.3 M2: should finalized resolutions be terminal?
No; that suggestion was withdrawn. Keep revalidation, write nothing on errors, and clear only on contrary evidence. Implemented.

### 5.4 H1 boundaries
- Rejecting abandon-by-expiry/root-change: agreed.
- A reviewed ragequit (same note and others) plus exact `Ragequit` settlement evidence: agreed and consistent with upstream.
- Public `nonce-consumed` at a finalized anchor, allowing only a reviewed next nonce: agreed. Caveat: it cannot tell success from replacement, and must not rely on a missing receipt alone.

### 5.5 P4/L1 guard scope
A narrow marker-plus-manifest guard is a sound way to detect moved profiles and selective deletion, subject to the five requirements in §3 (P4/L1). An anti-rollback root and portable identity need a separate recovery design; no auto-migration.

### 5.6 Is compact canonical-hash revalidation of reviewed relay records a sound replacement for rescanning receipt and logs?
**Yes for reorg detection, under the existing unverified-RPC evidence model, provided that:**
1. The reviewed resolution is bound to the exact `(blockNumber, blockHash)` from the canonical check at review time. It is: `resolution.blockHash === observation.blockHash`, and the receipt block hash and canonical block were checked.
2. The compact check requires `eth_getBlockByNumber(N).number === N` **and** `hash === storedHash`. A mismatch is contrary evidence; a missing block or error is "cannot establish" (throw, no write).

**Why it is equivalent:**
- A block hash commits to the header's transaction and receipt roots. If the same RPC reports the same hash at the same height, the reviewed receipt and logs are still in that block. The nullifier cannot become unspent later on that chain.
- Rescanning receipts and logs from the same single unverified RPC adds no trust against a lying RPC, which could fabricate consistent receipts equally well. Against an honest but lagging or forked node, the height/hash check is exactly the reorg signal.

**Privacy caveat (document or mitigate):** re-querying the specific historical heights of the user's own withdrawals before every spend reveals which blocks matter to this user. Doing so in a burst links those withdrawals to each other, and to the current spend, by timing, even across separate circuits to the same endpoint. The full rescan had the same property, so compact is no worse (and heights reveal slightly less than transaction hashes). Options:
- revalidate deep records less often (a per-session TTL) rather than on every spend;
- avoid bursting them together with the current spend's checks;
- or accept and document the correlation.

## 6. Verified correct (no finding)

- **Tor / SOCKS / transport:**
  - method-2-only SOCKS with format-0 isolation credentials and domain ATYP (no local DNS); bounded replies; abort handling;
  - per-context agent groups; TLS verification with no caller overrides; no redirects, cookies or compression; size and time bounds; redacted diagnostics;
  - the wallet endpoint is issued only for bootstrapped bundled Arti and revoked on every non-RUNNING transition, stop and start.
- **Lifecycles:**
  - the vault lock generation prevents revival by an older decrypt;
  - scopes close on lock, profile change, setting reset and shutdown;
  - `run`/`commit` recheck ownership.
- **Kohaku provider and network:**
  - grants are snapshotted before awaits; `latest` is resolved to a concrete range;
  - logs require `removed === false` plus address, topic and range;
  - restricted headers; `%2f`/`%5c`/`%25` refused; `%2e` normalized by the URL parser;
  - the role router refuses overlaps and requires one account identity.
- **Signed quotes:**
  - the EIP-712 domain/types and ms expiry match the pinned relayer;
  - `verifyingContract = processor`;
  - the signer comes from main config, separate from the fee recipient;
  - the `{txHash}` response matches `RelayResponseDto`.
- **Withdrawal binding:**
  - public-signal order matches the circuits: Transact 1×1 `[nullifier, outCommitment, stateRoot, keystoreRoot, aspRoot, amountOut, tokenIdOut, context]`; Deposit `[commitment, tokenId, value, context]`; Ragequit `[nullifier, commitment, keystoreRoot, owner, value, tokenId, label]`;
  - the context covers processor, routing (recipient, fee recipient, fee, `nativeGas = 0`) and `noteData`;
  - change is bound via `inspectChange`;
  - settlement is matched by nullifier plus output/value/asset/caller/target/note digest; the relayer's `txHash` is never trusted.
- **Public signing:**
  - the frozen tx is bound to the review, and signer output must equal the reviewed unsigned serialization;
  - the intent digest is rechecked at broadcast;
  - a durable journal write happens before transport;
  - remote-broadcast signers are refused.
- **Balances and renderer:**
  - Sepolia-only single-account reads with no fallback;
  - separate cache records keyed by hashed profile;
  - late writes are guarded;
  - generation/identity checks prevent cross-account repaint;
  - the packaged gate holds.
- **Production gate:** `isWalletTorExperimentAvailable()` (unpackaged plus env) is enforced in the session, private RPC, Kohaku network and balance paths.

## 7. Closeout verdict (final, 2026-09-28)

**Engineering review outcome for the gated experiment at `6c8b35a821eed0c492bb95d7e2fcc73338fa1ada`: approved.**
- Every High and Medium finding is fixed and accepted, or explicitly scoped with a documented residual:
  - High: P2, H1, H2, P1;
  - Medium: M1–M5, M3/P3, P4, T2 (partial, documented), T3 (controlled only).
- No finding weakens the production gate, and the production gate remains closed.
- **This is not** approval to activate the privacy features, a protocol audit, or a claim of live-network privacy.
- **Closeout conditions: all met.**
  1. The packaged run of all nine scenarios plus preflight passes on `6c8b35a8`: 10/10, no retries (§4.9).
  2. The source/package SHA-256 comparison of the 50 changed privacy modules matches: independently verified (§4.8).
  3. The source scenario summary is labelled composite in `docs/privacy-review-fixes-2026-09-28.md`.
- **Also verified at the commit:**
  - full regression of 5,783 passed, 33 skipped, and only the 3 baseline failures;
  - lint clean;
  - an offline real-SDK session/rotation spike with no ambient network attempts (implementer-reported).
- **Scope of this approval:**
  - It covers controlled, synthetic, macOS arm64 source and packaged qualification of a development-gated experiment.
  - Remote chain, ASP and relayer evidence remains unverified by design.
  - The residuals in §2, §3 and §8 remain open work: T2's non-quote negative assertions, the timing-correlation privacy caveat, whole-profile rollback and portable recovery, P6 provenance, zero-change and private-transfer coverage, capacity/retention, and live, platform and upstream release gates.
  - None of these weakens the closed production gate. Each must be resolved or explicitly accepted before any activation decision.

## 8. Remaining risk before any production activation

This is the current list, consistent with the §7 verdict. None of these items weakens the closed production gate. Each must be resolved or explicitly accepted before any activation decision.

- **Recovery and state:**
  - H1: reviewed migration of legacy relay records that lack `owner`/`inputValue`. A stuck-pending public transaction needs a replacement made outside the app (documented; no in-app resend).
  - P4/L1: a portable profile identity, an anti-rollback trust root, and reviewed migration of legacy stores without an inventory. A moved profile is blocked until then.
  - Capacity: journals cap at 64 attempts, with no retention or compaction policy.
  - T5: an encrypted temporary file can be left behind after an interrupted write.
- **Privacy:**
  - M4: the RPC operator can still correlate timing, including keystore reads during proving and bursts of historical-height revalidation.
  - Tor isolation is qualified in controlled tests and a scoped macOS live probe only.
- **Trust:**
  - Remote chain, ASP, relayer, finality and scan-anchor evidence stays unverified (no light-client proofs). This includes the L3 anchors.
  - L3: a single block exceeding the log cap cannot be processed.
- **Performance:** every session open for a registered owner scans the keystore's whole auth-event history from `deploymentBlock` (§4.6).
- **Tests:**
  - T2: the `emptySetSpendBlocked`, `reorgBlocked` and `depositRefused` negative checks still accept any rejection.
  - T3: real Tor latency and relayer delivery under upstream quote lifetimes are not established.
- **Provenance:**
  - P6: candidate strings are not code authentication, and the scratch ASAR is not a distribution chain.
  - P5: the tripwires are not a sandbox (`process.binding` bypass).
- **Coverage:** zero-change (full-value) withdrawals, private transfers, other circuit shapes and asset behaviours, and hardware or remote signers.
- **Platforms:** Linux/Windows egress and memory headroom. Measured only on macOS arm64, about 628/768 MiB; the multi-thread deposit prover was not re-measured elsewhere.
- **Release gates:** live deployment, audit and upstream gates as listed by the implementation plan:
  - final derivation identity;
  - audited source and setup;
  - matching deployed contracts and verifiers;
  - ASP and relayer configuration and signers;
  - maintained package distribution;
  - live Sepolia recovery;
  - supported-platform and OS egress qualification.
