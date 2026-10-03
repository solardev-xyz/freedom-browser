# Runtime integrity and journal retention: independent follow-up review

**Reviewer:** Claude (independent reviewer; the implementation is by Codex)
**Date:** 2026-09-28
**Baseline:** `5a090983` ("docs(wallet): record independent privacy branch review"), plus the uncommitted working tree described below
**Predecessor:** [privacy-branch-review-2026-09-28-reviewer.md](privacy-branch-review-2026-09-28-reviewer.md). Its P6 (provenance) item and its capacity/retention residual are the subject of this slice.

## 1. Scope, reviewed state and limits

**Scope:**
- **Runtime integrity:**
  - `src/main/wallet/ppv2-runtime.js` and `ppv2-runtime-manifest.js`.
  - Session and prover constructor checks, plus the three utility-process jobs.
  - `scripts/inspect-ppv2-runtime.js`.
  - The E2E loader migration and runtime tamper scenario.
- **Journal retention:**
  - `privacy-journal-retention.js` and `privacy-journal-archiver.js`.
  - Both journals and reconcilers, `private-transaction-network.js`, and the session's archive and exit-guard changes.
- **Docs:**
  - `docs/privacy-runtime-retention-2026-09-28.md` and `docs/ppv2-live-qualification-prerequisites.md`.
  - The continuation pointers added to the status, fixes, plan and roadmap docs.

**Reviewed working-tree state (final, 16:04 CEST, after the late-RPC hardening in §2):**
- `git diff HEAD --binary` SHA-256 is `9d8b3ab405df5469d50b7f40b804a5d123f417c9a175405c4339cb576b28bf36`.
- The SHA-256 over the sorted per-file digests of the untracked files is `239879870a69c0ca46872e61f5bacecf76dca2168b8a7d26a3e48488b427ba45`.
- These digests identify what was reviewed.

**Committed as `bfa75b22ec0c68646ecf7ee5ad3f46178545ec79`** ("feat(wallet): pin PPv2 runtime and retain reviewed history"): 30 files, code and tests only.
- `git diff HEAD --quiet -- src scripts test-e2e` is clean, so the committed code matches the working tree.
- Both digests above recompute identically against `5a090983`. For the 26 pre-existing files, `git diff 5a090983 --binary` gives `9d8b3ab4…`; for the ten new paths, the combined digest gives `23987987…`.
- So the committed code and tests are **byte-identical to the reviewed state**.
- The retention/runtime doc, live prerequisites and continuation pointers are still uncommitted, for the separate evidence commit.

**Method:**
- I read every changed source file and the design messages in the conversation.
- I checked each safety claim against the call sites.
- I inspected the pinned archive directly.
- I ran targeted unit tests and lint myself. I did not run E2E or packaged tests, to avoid races with the implementer's runs.

**Limits:**
- This is a code and design review, not a protocol audit.
- Local OS and main-process code are trusted. That matches the stated threat model.
- It is not approval for production activation.

## 2. Outcome summary

| ID | Severity | Issue | Status |
|---|---|---|---|
| I1 | Medium (P6 core) | Candidate identity was self-declared (`{...PPV2_CANDIDATE}`), and SDK or prover paths were required without verification | **Fixed.** Loader-issued brand plus rechecks in main and in each job |
| I2 | Low-Medium | The loader cannot detect archive code that ran before verification (`require.cache` is trusted) | **Mitigated.** Static ownership test (`ppv2-runtime.test.js:64`) and a documented caller rule. A runtime cache check was not adopted because it conflicts with the pass-through E2E instrumentation. Accepted. |
| I3 | Low | The integrity check could be disabled by assigning to the module's exports | **Fixed.** Exports frozen (`ppv2-runtime.js:77`) |
| I4 | Low | Pin updates could drift from `PPV2_CANDIDATE` | **Fixed.** `candidate.json` is checked against the session's revisions and the pinned patch digest (`ppv2-runtime.js:56-58`, manifest) |
| I5 | Low (tests) | No proof that the session refuses early, and no job-level refusal tests | **Fixed.** `ppv2-session.test.js` "runtime rejection precedes…" and `ppv2-job-integrity.test.js` |
| I6 | Nit | Inode and device compared as lossy numbers | **Fixed.** Stats use `bigint: true` |
| I7 | Qualification | There was no repeatable check of the static archive properties when the pin changes | **Fixed.** `scripts/inspect-ppv2-runtime.js`, with its limitation stated |
| I8 | Doc | Electron caches archive handles and modules; a same-user writer can race the check; the archive lives in a temp directory | **Documented.** Loader comment and retention doc. Production needs immutable signed resources. |
| R1 | **Medium** | After archival, the ragequit guard (`ppv2-session.js:306` at review time) looked only at live relay records. A stale SDK note state would then let an exit simulation send the spent nullifier and commitment to the owner RPC (`ppv2-public-operations.js:119`), linking the owner to the earlier private withdrawal. | **Fixed.** `assertCanExit` covers resolved live records and archived commitments. It runs before the note lookup and proof (`ppv2-session.js:248`), and before the simulation and again after approval (`:313`). A session test proves the refusal happens before the SDK note lookup, exit proving and any `eth_call`. |
| R2 | Medium-Low (liveness) | Two evidence passes plus the human review share one 120-second deadline, and per-record finality anchors must match exactly. This likely fails or times out over real Tor. | **Documented, not restructured.** Retention doc and live prerequisite step 7. A failure writes nothing, so safety is unaffected. |
| R3 | Low (tests) | Refusal tests accepted any error | **Fixed.** Exact codes asserted (`privacy-journal-retention.test.js:55-181`) |
| R4 | Low | Every journal write emits version 2 even with an empty archive, so older builds refuse these journals | **Documented** as a deliberate one-way experimental migration |
| R5 | Low (doc) | Retention trust disclosure was missing | **Fixed.** `docs/privacy-runtime-retention-2026-09-28.md` |
| R6 | Low (hardening) | The public archiver shares the owner's RPC client, which ignores the archival signal. An RPC answering after the deadline could let the next anchor request start. | **Fixed.** The archiver's `read()` checks lifetime and deadline before and after every RPC (`privacy-journal-archiver.js:18-23`). The test "a late RPC cannot continue an expired archive inspection or write state" (`privacy-journal-retention.test.js:177`, both journals) asserts `PRIVATE_HISTORY_ARCHIVE_REFUSED`, exactly one RPC call, and no write. |
| R7 | Low (tests) | Closing the session after archival was untested | **Fixed.** `ppv2-session.test.js:255`: a refused archival leaves the session usable; a successful one returns `sessionClosed: true`, revokes the session (`PRIVACY_CONTEXT_REVOKED`), and frees the account lease for reopening. |
| N1 | Nit | `loadPPv2Runtime` reads `candidate.json` and requires `plugin.cjs` outside the `fail()` wrapper (`ppv2-runtime.js:56,59`), so a missing or malformed file surfaces a raw fs or JSON error instead of `PRIVATE_PPV2_RUNTIME_INVALID` | Open. It fails closed; the fix is cosmetic. |

## 3. Runtime integrity: design and verification

**Accepted design:**
- `verifyPPv2Runtime`:
  - It uses `original-fs` on the actual container file.
  - It uses `lstat`, `O_NOFOLLOW`, and bigint `dev`/`ino`/`size`/`mtimeNs`/`ctimeNs` both before and after reading.
  - It streams the SHA-256 against the source-pinned size and digest.
  - It checks `realpath` is stable and refuses an `.unpacked` sidecar.
- `loadPPv2Runtime` verifies, cross-checks `candidate.json`, then requires `plugin.cjs`. It issues a frozen candidate whose identity is held in a module-private WeakMap.
- `assertPPv2Candidate` re-verifies the archive at every session open and binds every proving entry to that same archive.
- Each job calls `assertPPv2RuntimeEntries(input)` after its artifact digest checks and before `require(input.sdkEntry)`. Each job runs in a fresh utility process, so no stale archive cache applies there.

**Independent checks on the pinned archive** (`ce18c67a…`, 46,915,303 bytes, found at `$TMPDIR/ppv2-process-asar-Si3N85/ppv2.asar`):
- **Structure:** 28 files, 0 links, 0 unpacked entries, and no native `.node` addons. That was confirmed both with my own header walk and with `scripts/inspect-ppv2-runtime.js`.
- **Candidate:** Kohaku `6fdc248b…`, SDK `fe0244e3…`, patch `411957db…`. These match `PPV2_CANDIDATE` and the manifest.
- **Exposed graph is closed:**
  - `plugin.cjs` requires only `./sdk.cjs` and `node:crypto`.
  - `sdk.cjs` and `serial-prover.cjs` require built-ins and `./node_modules/web-worker-1.2.0/cjs/node.js`, which itself requires only built-ins.
  - The only non-built-in bare specifier in the whole archive is `electron`, in the fixture `job.cjs`, which is not exposed.
  - The dynamic loads are web-worker's `require(mod)`/`import(mod)` of worker scripts supplied by code inside the archive. The `import(` match in `sdk.cjs` is a static method named `import`.
- **Authority:** `sdk.cjs` imports `http`, `https`, `net`, `tls` and `module`. In main, the absence of ambient egress therefore rests on SDK behaviour plus the qualified egress probes, not on a boundary. The pin authenticates which code gets main-process authority; it does not reduce that authority, and the docs say so.
- **Cost:** about 18 ms per verification (warm cache, Apple silicon). There are up to five in main per session open (load, session, three provers). Acceptable for the experiment; production should verify once per open, or asynchronously.

**Electron evidence:** I inspected `/private/tmp/privacy-runtime-integrity.json`:
- Result: 1 expected, 0 unexpected, 0 skipped, 0 flaky, 2.6 s.
- `healthy: true`.
- Main refusal and stale-candidate refusal are both `PRIVATE_PPV2_RUNTIME_INVALID`.
- Child refusal is `PRIVATE_PROCESS_FAILED`, with `progressed: false`.

The flipped byte is in `serial-prover.cjs`, the last archive entry, which the deposit job never loads. So the child refusal can only come from the job's own check. **This was a source run (`packaged: false`).**

**Test instrumentation:** the withdrawal E2E replaces main `require.cache` exports with pass-through wrappers before the loader runs, to capture synthetic ASP labels. That is acceptable test instrumentation. The evidence should be labelled "authenticated archive plus main-only pass-through instrumentation", as the retention doc does. The raw-source spike substitutes the validator and reports `runtimeIntegrityTested: false`.

## 4. Journal retention: design and verification

**Invariants preserved exactly:**
- **Relay:** no new attempt for a recorded id, nullifier or commitment. Uniqueness is enforced across live and archived records in decode and in `begin`.
- **Public:** no recorded hash can be reused, and a new nonce must exceed every live and archived nonce. Decode also requires archived nonces to strictly increase and every live nonce to exceed the last archived one.
  - `has()` covers the archive, so the receipt-query allowlist and duplicate-broadcast refusal in `private-transaction-network.js` are unchanged.
- **Exit:** a commitment that is resolved or archived in the relay journal cannot reach ragequit proving or public simulation (R1).
- **No archived nullifier reaches a relayer:** the relay handoff calls `begin`, which checks the archive, before any relayer request.
- Unresolved, conflicting and legacy (no `settlement`) records are never archived.

**Evidence and commit discipline (verified in code):**
- Only a prefix is selected. Each record must be at least 24 hours past its resolution review, and the age is rechecked at commit, which also refuses a future `reviewedAt`.
- Each pass enforces `finalized ≤ latest` and `blockNumber ≤ finalized`, with bracketed re-reads of the canonical block and the finalized anchor.
- Any read error writes nothing. A confirmed hash mismatch takes the normal conflict (relay) or reorged (public) path, which clears the resolution; nothing is archived.
- The review payload includes `recordCount`, `blockRange` and the finalized anchors, and states that revalidation stops. Acceptance requires `archiveResolvedHistory`, `stopRevalidating` and `acceptedEvidence: 'unverified-rpc'`.
- The second pass must equal the first. The commit compares each selected id and revision and the live-prefix position in one synchronous encrypted storage update. The deadline and lifetime signal are checked before every write.
- `refreshResolved` touches live records only.
- Both records and archive stay in one authenticated value: no new file, no crash window between two keys, and profile inventory coverage is unchanged.
- **Size:** relay tombstones are about 0.5 KB, so a full archive of 1024 is about 0.5 MB, plus about 0.1 MB of live records, within the 1 MiB value limit. A maximum-size test covers the bound.
- A successful session archive closes the session (`sessionClosed: true`). This is sound: `getContext` caches contexts by subject (`privacy-context.js:122-126`), so each newly archived relay id would otherwise permanently use one of the 256 contexts.

**Trust disclosure** (the retention doc matches the implementation):
- Archival retires revalidation. After that, an honest RPC can no longer contradict a resolution accepted from an earlier dishonest RPC.
- The limits are permanent: 64 live plus 1024 archived per journal. After that, sends are refused, including the public transaction used for in-app ragequit.
- The 24 hours is a local-clock policy delay.
- Archival reads historical block heights in a burst, which is a timing-correlation risk.
- The state-format migration is one-way.
- A long-lived session can hit the 256-context cap.
- There is no unarchive flow.

## 5. Evidence I ran (read-only or unit-level)

- **Unit tests:** 12 suites, **239 of 239 passed**:
  - `ppv2-runtime`, `ppv2-job-integrity`, `privacy-journal-retention`, `ppv2-session`, `ppv2-relay-reconciliation`;
  - `private-submission-journal`, `private-submission-reconciler`, `private-transaction-network`;
  - `ppv2-relay-handoff`, and the deposit, ragequit and transact provers.
  - Earlier, `privacy-journal-retention` alone passed 28 of 28.
  - After the final hardening, `privacy-journal-retention` and `ppv2-session` passed **53 of 53** (this includes the two final tests, R6 and R7), and ESLint on the archiver and both test files exited 0.
- **Token negative E2E rerun** (`/private/tmp/privacy-followup-token-final.json`, inspected): 1 expected, 0 unexpected, 0 skipped, 0 flaky, 13.1 s. It records `depositRefused: true` and `depositRefusalCode: 'PRIVATE_PPV2_ALLOWANCE_REQUIRED'`; the reset approval's outcome is `PRIVATE_BROADCAST_UNCERTAIN`. The restart phases stay blocked, and the exit ends in `exitStatus: 'exited'` with the guarded cache restored and the rescan recovered. `productionGate: false`, `packaged: false`.
- **Lint:** ESLint on all changed and untracked `.js` files exited 0.
- **Archive:** `node scripts/inspect-ppv2-runtime.js` on the pinned archive produced the results in §3.
- **Verification timing:** 5 × `verifyPPv2Runtime` took 17.5 to 19.6 ms each.

**Implementer runs on the committed code (logs inspected by me):**
- **Full regression** (`/private/tmp/privacy-followup-full-final.log`): 283 suites passed, 5 skipped and 2 failed; **5,834 tests passed, 33 skipped and 3 failed**.
  - The failures are the known baseline three: two shortcut-remap cases in `settings-store.test.js` and the Safe fork send-orchestrator case in `safe-fork.test.js`.
  - The log was written at 16:05, after the last code change (16:04) and before the commit (16:06). The code is unchanged in between, as §1 shows.
- **Full lint** (`/private/tmp/privacy-followup-lint.log`): `eslint .` with no findings.

**Package digest coverage (independent, read-only).** I checked `dist/mac-arm64/Freedom.app/Contents/Resources/app.asar`, built at 16:06:35, after the 16:06:00 commit.
- **App archive SHA-256:** `280bd935348406e6a2e7023ef249d6d16459a8211918432e1deddd48044a6bd3`, matching the implementer's report.
- **Every packaged source file checked:** all **640** files under `src/` in the archive are byte-identical to their `bfa75b22` blobs. There are no mismatches and no packaged source files outside git.
- **Changed main modules:** the 54 non-test `src/main` JavaScript modules added or modified between merge base `2983dc62` and `bfa75b22` are all packaged. They match exactly the 54 entries in `/private/tmp/privacy-followup-package-digests.json`: none missing, none extra, all source and packaged digests correct.
- **New modules:** `ppv2-runtime.js`, `ppv2-runtime-manifest.js`, `privacy-journal-archiver.js` and `privacy-journal-retention.js` are packaged.
- **Changes outside main:** only two non-test source files outside `src/main` changed, `src/renderer/lib/wallet/balance-display.js` and `src/renderer/pages/settings.html`. Both are packaged identically.
- **No deletions** since the merge base.
- **`package.json`** differs only by electron-builder's standard stripping of `scripts`, `build` and `devDependencies`. `dependencies`, `main` and `version` (0.8.7-dev) are identical.

**Final packaged run on `bfa75b22`** (`/private/tmp/privacy-followup-packaged-final.json`; I inspected every attachment):
- **Result:** 11 expected, 0 unexpected, 0 skipped, 0 flaky, retry 0 on every case, 260.1 s in one run. The checks are preflight, the native deposit, lifecycle, process, runtime integrity, relay and token scenarios, and the four withdrawal scenarios (native and token, lost-withdrawal and withheld-relay/exit).
- **Common flags:** every report has `packaged: true`, and every report that carries the gate flags has `productionGate: false` and `liveTransactionSubmitted: false`.
- **Runtime integrity (packaged):** `healthy: true`; main and stale-candidate refusals are both `PRIVATE_PPV2_RUNTIME_INVALID`; the child refusal is `PRIVATE_PROCESS_FAILED` with `progressed: false`; the archive SHA is `ce18c67a…`.
  - The healthy proof passes through the deposit job's own `assertPPv2RuntimeEntries` in the packaged utility process. So the job does load `ppv2-runtime` and `original-fs` from inside `app.asar`.
  - The deposit report shows `jobFromAsar` and `sdkFromAsar` true, and the process report shows `hostFromAsar` true.
- **Exact negative codes:**
  - Inactive note: `emptySetSpendCode: PRIVATE_PPV2_NOTE_UNAVAILABLE` in all four withdrawal scenarios.
  - Reorged relay evidence: `reorgCode: PRIVATE_PPV2_RELAY_UNRESOLVED` in both lost-withdrawal scenarios.
  - Token allowance: `depositRefusalCode: PRIVATE_PPV2_ALLOWANCE_REQUIRED`.
  - Unresolved public and relay records: `PRIVATE_SUBMISSION_UNRESOLVED` and `PRIVATE_PPV2_RELAY_UNRESOLVED` after restart.
  - Emergency exits: `exitStatus`/`persistedExit` is `exited`.
  - The three generic negatives that T2 left open in the predecessor report (`emptySetSpendBlocked`, `reorgBlocked`, `depositRefused`) now carry exact codes.
- **Short quotes:** these still follow the accepted T3 rule.
  - In the token runs, the host refuses before expiry: `PRIVATE_PPV2_RELAY_REFUSED`, rejected about 0.13–0.16 s before the signed expiration.
  - In the native runs, proving took about 10.3–10.7 s, so the SDK refused after expiry: `PRIVATE_PPV2_OPERATION_FAILED`, with `rejectedAt` 0.25–0.64 s after the signed expiration.
  - Both fail closed before journaling.
- **Still generic (not claimed as tightened):** the deposit scenario's `excessiveFee` and `badArtifact` refusals (`PRIVATE_PPV2_OPERATION_FAILED`; `badArtifactStartedProver: false`).
- **Test-only integrity bypass:** the first process scenario runs the archive's fixture `job.cjs` directly. That test-only job does not run the runtime check; the three product jobs do.

**Durable evidence** (`docs/qualification/privacy-runtime-retention-2026-09-28.json`), checked programmatically against the raw files:
- The `packaged` section matches the raw packaged run exactly: the 11-case set, and every case's status, duration and full report.
- `source.finalToken` matches `/private/tmp/privacy-followup-token-final.json` exactly.
- `packageDigests` equals `/private/tmp/privacy-followup-package-digests.json`.
- `runtimeInspection` equals a fresh `scripts/inspect-ppv2-runtime.js` run on the pinned archive.
- The regression, lint and reviewer-test counts match §5, and its `qualificationLimits` match §7.

**Not run by me:** E2E and packaged runs, and the full regression suite. I inspected their outputs as recorded above.

## 6. Verdict

**Final (2026-09-28): approved.** This covers the engineering review of the runtime-integrity and journal-retention slice at `bfa75b22ec0c68646ecf7ee5ad3f46178545ec79`, which is byte-identical to the reviewed state. The scope is the gated, main-only, development-only Sepolia experiment on macOS arm64. All Medium and Low findings are either fixed or documented as deliberate, disclosed trade-offs.

**Closeout conditions (all met):**
1. **Met:** the strengthened negative scenarios carry exact refusal codes in the packaged run on the committed code (§5).
2. **Met:** the full lint and unit regression on `bfa75b22` shows no new failures beyond the known baseline three (§5).
3. **Met:**
   - Package identity: 640 of 640 packaged `src/` files and all 54 changed main modules match the commit.
   - Packaged run: 11 of 11 passed, 0 skipped, 0 flaky.
   - Runtime integrity is refused in main, for the stale candidate and in the packaged utility process before proving.
4. **Met:**
   - The commit is recorded in §1.
   - `docs/privacy-runtime-retention-2026-09-28.md` (lines 47–49) records the commit, regression, lint and package results. It links this report and `docs/qualification/privacy-runtime-retention-2026-09-28.json`, whose contents I verified against the raw outputs.
   - The doc's claims match the evidence: the 5,834/33/3 regression, clean lint, 11 of 11 packaged checks, the 54 matching modules, my 640-file comparison, and the overlapping 239 and 53 reviewer test counts.
   - Its trade-off section matches §4 and §7.
   - These docs and this report are still uncommitted; the implementer will add them together, with `git add -f` for this gitignored report.

**This approval does not cover:**
- Production activation.
- Live Sepolia or real Tor latency; R2 remains a live-qualification item.
- Protocol or SDK audit.
- Reproducible SDK builds.
- Protection against same-user or privileged filesystem writers, or compromised main code.
- Backup, migration or unarchive design.

## 7. Remaining risk (this slice)

- **R2:** archival liveness over real Tor, given the 120-second shared deadline and exact per-record finality anchors. Qualify with a small batch, or restructure: read `latest`/`finalized` once per pass, and give the review its own deadline.
- **Archival trust:** the retired-revalidation trade-off, and permanent capacity with no eviction. The public side could later fold hashes into a nonce watermark safely; the relay side cannot.
- **One-way migration:** version 2 journals are refused by builds up to `5a090983`.
- **Runtime integrity is tied to a temp-directory archive.** It does not defend against same-user writers or pre-verification loads; the static test guards only literal references. Production needs signed, immutable resources.
- **The SDK keeps main-process authority,** including `http`/`https`/`net`/`tls` imports. Main-process egress containment is behavioural and qualified by probes, not enforced.
- **Nit N1:** raw error shape from the loader.
- **Generic refusals that remain:** deposit `excessiveFee` and `badArtifact` refuse with the generic code. Native short quotes are refused by the SDK after expiry (the T3 acceptance rule) rather than by the host before journaling.
- **Evidence scope:** one platform (macOS arm64, unsigned local package, Electron 44.4.5), with synthetic services only.
- **Inherited from the predecessor report:** anti-rollback (L1), live, platform and upstream gates, full-value withdrawals and private transfers, and the timing-correlation caveat (M4).
