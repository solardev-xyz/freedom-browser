# PPv2 Sepolia: ready for test ETH

The complete public history and real unfunded Kohaku session checks now pass. A persistent disposable wallet is prepared. The next live step requires Sepolia ETH. No live transaction has been signed or submitted, and production remains disabled.

## Funding handoff

- Network: **Ethereum Sepolia**, chain ID **11155111**.
- Address: **`0x6d7d00e435919ead9845f25e2c2f85b969d2c331`**.
- Requested amount: **0.05 Sepolia ETH**. This is a test budget with headroom for two small deposits, registration, withdrawal fees and an emergency exit, not an exact gas estimate or authorization to spend the whole balance.
- Persistent profile: `<checkout>/identity-data/ppv2-sepolia-live/`. The vault is encrypted with a random 256-bit password; the password is encrypted by Electron safeStorage on this Mac. The authenticated runtime and proof artifacts are copied into this profile. `funding.json` binds the public address, profile identity and runtime digest.
- This is a **harness-only profile**, with a provisional experimental PPv2 derivation identity. Keep its vault, encrypted credential and privacy stores together. It is not a portable recovery backup: moving it to another machine or deleting the OS credential can prevent unlocking. Nothing secret is committed; `identity-data/` is gitignored. Preserve this directory: do not run `git clean -fdx`, remove the checkout, move the profile, or reset its OS credential while it holds funds. The current path is part of its authenticated identity binding.

Do not open this harness profile as an ordinary browser profile: its persisted Sepolia RPC policy selects a direct source. The qualification harness routes those RPC reads through the wallet's Tor transport, but ordinary public browser reads could use that source over direct HTTPS. The relayer route is explicitly direct; it exposes the test connection IP and operation to the relayer and uses system DNS. RPC/ASP Tor traffic does not make the complete test unlinkable.

## Evidence

[Machine-readable results](qualification/ppv2-funding-readiness-2026-10-01.json) contain the public observations and the final unfunded session report.

- **Complete recovery history through Sentio over Tor:** 179 bounded windows per contract, from block 10932354 to finalized block 11822403. All 7,353 pool leaves and 661 keystore leaves reconstructed the respective contract roots, including the keystore update event. The first events were at blocks 10994884 and 10994877. Missing or discontinuous history is still refused.
- **Second-provider cross-check:** Tenderly direct public reads matched that finalized block hash and both reconstructed roots. These are agreeing RPC observations, not independently verified chain state.
- **ASP:** 15,325 leaves reconstructed the latest registry root. The service was ahead of the finalized root during this run; it is not required to equal a lagging finalized observation. Its full event snapshot still exceeds the 4 MiB cap; the SDK uses the bounded log fallback.
- **Deployment preflight:** the real owner/protocol contexts, Sentio, managed Arti and direct relayer passed all current bytecode/implementation/verifier pins, contract relationships, asset, ASP and signed-quote checks. The relayer quote matched the pinned candidate signer/fee recipient and processor. Operator confirmation of their intended roles remains outstanding; the measured cryptographic and contract consistency checks passed.
- **Real SDK session:** authenticated archive loading, dedicated derivation, encrypted stores, unregistered-key checks, registration preparation, both registration `eth_call` simulations, empty note discovery and balance reads all passed. No registration was sent. The host was opened with all three pinned local proof services available; real live-funded proving remains pending.
- **Persistence:** closing/reopening the session and a separate fresh Electron process preserved the same owner and empty state. The final read returned zero Sepolia ETH. No private key, mnemonic, password, note data or raw prepared calldata is included in the report.

There were bounded refused runs before the successful checks: Tenderly returned 403 in a fresh Tor context, Sentio had a connection failure on one owner context, and the ASP had a Tor DNS failure on another run. These were explicitly rerun read-only qualifications. The product has no automatic circuit cycling, endpoint fallback or direct fallback. A failed funded handoff must retain its uncertain journal state.

## Implemented test route

`openPPv2Session({ …, relayerRoute: 'direct-sepolia-test' })` is an explicit main-only option. It requires the existing development experiment gate, Sepolia, the PPv2 relayer role, Tor readiness for the other roles, and a durable disposable-profile marker. Packaged builds refuse it. The SDK configuration cannot choose the route.

The direct transport uses validated HTTPS and a private non-pooling agent, with no cookies, redirects, compression, proxy-agent reuse, retries or fallback. Request/response caps, timeouts, cancellation and concurrency limits remain bounded. The role router keeps RPC, ASP and artifacts on their existing routes. The relayer's direct IP exposure is recorded in authenticated encrypted state before network access and appears on session/review summaries even if the enabling marker later disappears.

The exact signed quote, processor, fee, proof, fresh-root, review, journal-before-send, single-send and uncertain-delivery rules remain intact. No new IPC or product UI was introduced. Protocol interpretation/configuration stays in `src/main/wallet`; transport policy stays in `src/main/networks`; opt-in qualification orchestration stays in `scripts`.

## Reproduce the unfunded check

From this checkout, with the existing persistent profile:

```sh
FREEDOM_WALLET_TOR_EXPERIMENT=1 node_modules/.bin/electron \
  scripts/qualify-ppv2-session.js \
  "$PWD/identity-data/ppv2-sepolia-live/ppv2.asar" \
  "$PWD/identity-data/ppv2-sepolia-live" \
  /absolute/new-report-directory
```

With no step option, the script never invokes signing, public submission or relay submission. `--check-step=register-auth` additionally exercises the controller funding gate and cannot prepare, sign or submit even if funds have already arrived. Its live run passed and returned `needsFunding: true` for the same wallet. It refuses an ordinary existing vault without the disposable marker, unavailable OS encryption, Linux basic_text, identity-directory overrides, changed runtime bytes or changed funding identity. It does not fetch an SDK or artifact at runtime. A separate initial schema-diagnostic profile, `identity-data/ppv2-sepolia-qualification`, is retained unfunded and is not the funding target.

Full public tree diagnostics now accept explicit `sentio` and `tenderly` choices in `qualify-ppv2-live.js` and `qualify-ppv2-recovery.js`; neither is an automatic fallback.

## First funded sequence

1. Confirm the funds on Sepolia and repeat deployment/quote/root checks. Keep the total experiment within 0.05 ETH; use approximately 0.005 ETH per deposit, subject to current measured fees. A current live gas quote and explicit per-operation fee bounds still precede signing.
2. Prepare/register the actual auth policy and viewing key, submitting each reviewed public transaction separately. Reconcile and accept the first transaction's evidence before preparing/submitting its dependent successor.
3. Deposit a small native amount, discover the encrypted note and observe its ASP approval. Never interpret an unavailable service or empty log window as approval or an empty wallet.
4. Prepare a small native withdrawal, review the exact signed fee/recipient/proof and direct-exposure label, then send the single journaled relay request. Reconcile on-chain outcome through the operation's Tor RPC context. Do not retry an uncertain submission.
5. Restart, verify recovery and change-note state, and exercise an emergency exit using a separate small note so the recovery path is demonstrated without depending on a successful relay. Competing/uncertain relay cancellation needs the existing explicit review.

The bounded controller in `src/main/wallet/ppv2-sepolia-test-step.js` uses the existing session APIs. Append exactly one explicit option to the command above, choosing a fresh private report directory for each invocation:

- `--step=register-auth`, then `--step=resolve-public <transaction-hash>`, then `--step=register-viewing` and its separate resolution.
- `--step=deposit` fixes the native deposit at 0.005 ETH and the protocol fee cap at 0.0001 ETH; at most two deposits.
- `--step=status` reads journals and notes. These **local** reports can contain note identifiers; keep them private and do not commit them.
- `--step=withdraw <note-commitment>` sends 0.002 ETH to the same public test owner, caps the relay fee at 0.002 ETH and requires positive change; at most two withdrawals. This intentionally makes no unlinkability claim.
- `--step=resolve-public-failed <transaction-hash>` separately reconciles reverted or finalized nonce-consumed evidence, with twelve confirmations; it never automatically retries the operation. Failed attempts still count against the total send budget.
- `--step=resolve-relay <attempt-id>` accepts only a finalized included/exited observation through the existing reconciliation service.
- `--step=ragequit <note-commitment>` exits a separate native note. Pending public or relay attempts block the ordinary exit action. `--step=ragequit-cancel <note-commitment>` is the explicit competing-exit action: it requires exactly one unresolved relay for that note and acknowledges that the relay can win the race.

Public transactions have a maximum gas cost of 0.003 ETH each and use owner-context `eth_estimateGas` plus 25% headroom, rounded up. Estimation must succeed within gas ceilings of 400,000 / 150,000 / 800,000 / 1,200,000 for auth / viewing / deposit / ragequit. At most six public sends are allowed by retained journals. Successful public reconciliation requires twelve confirmations and explicitly accepts unverified RPC evidence; it never automatically starts another transaction. Deployment pins are checked before an operation and again immediately before a public signature. The existing proof, root, quote-expiry and one-send gates remain active. A refusal, timeout or uncertain result stops that invocation; inspect its durable journals before any subsequent action. The controller exposes no automatic retry or history-archive action. Public signing uses the existing legacy gas-price policy; an underpriced pending transaction blocks further sends and replacement is outside this controller. Full preflight in the signing window can exhaust the prepared-plan deadline and refuse; no expired plan is reused. A refusal inside the signer precedes journal insertion; once journal insertion occurs, treat failures as potentially submitted and inspect the journal. The fixed withdrawal amount/fee headroom does not qualify a second relay spend from the smaller change note; change recovery and a separate-note emergency exit remain the initial live targets. Exit preparation also refuses if current gas exceeds its fee cap. Product UI decisions, transferable backup/recovery, mainnet activation, audit/source distribution, signed packaged qualification and Tor-relayer compatibility remain separate roadmap work.

## Validation and review

Main `39ad0247` was merged in `e68d120f`. The only manual merge conflict combined main's new chain-router options with the existing privacyContext option; Claude verified that the private path still returns before main's fallback/retry logic. Locked npm dependencies did not change.

Explicitly refreshed Ant 0.5.45, IPFS 0.4.3, Radicle 0.7.1, Myotis 0.1.12/ABI32 and its supervisor. Rebuilt Arti 2.6.0 with installed Rust 1.98.1 and main's static SQLite/liblzma policy. The macOS arm64 Arti binary SHA-256 is `69cc252f9062a1dd0f972e18b02e536f4f6587dc24d01845deab42aaee0c1c7e`; `arti --version` reports 2.6.0 and `static-sqlite`. Its macOS linkage lists only system libraries; bundled binary checks pass. No dependency version was added or upgraded independently of the authorized main sync.

- Full unit suite: **6,654 assertions passed, 33 skipped, zero failed**, across 316 passing suites. Two combined invocations exited 1 because the unchanged OpenLV integration test logged websocket errors after teardown. Isolating it produced two successful commands: the other 6,648 tests (315 suites) and all six OpenLV tests (one suite), both exit 0. This is not a claim that the combined runner exited cleanly. Main fixed the previous three assertion failures. Lint is clean.
- Final source Electron run: **all seven withdrawal-spec cases passed together** on the final file, including the controller case described below. Six controlled withdrawal/recovery lifecycles passed (four Tor-mode native/ERC-20 cases and two direct-mode native cases). The direct-mode cases use a fixture network and exercise the real SDK/session/handoff/journal/reconciliation paths, with explicit assertions that the relayer group selects direct and ASP selects Tor. They do not demonstrate a real live relay submission.
- The exact funded controller also passed a controlled Electron lifecycle through the real SDK/session/transaction service: separately reconciled registration, two fixed deposits, withdrawal, relay reconciliation and a separate-note ragequit. It produced five synthetic public sends and one synthetic relay, with all journals resolved, and refused a dependent send before reconciliation. Deployment checks, gas estimates and network responses are fixtures in this test; no live transactions were sent.
- Five additional wallet IPC/theme, restart-journal and artifact/worker checks passed across the initial run and targeted rerun. The older worker fixture was updated to supply the validator required by the previously hardened worker API. The new main CI coverage guard prompted wiring the self-contained wallet specs into PR CI; private runtime-dependent specs now have explicit documented CI exclusions.
- The real direct HTTPS path was exercised by the live signed-quote preflight. Unit tests additionally cover role/profile/development gates, no fallback, TLS validation despite environment overrides, caps, redirects, compression, cancellation, concurrency, unexpected-error sanitization and encrypted exposure retention.
- Current source/runtime checks are not a fresh signed or packaged-build qualification. Prior packaged evidence retains its earlier baseline.

Claude reviewed the route, encrypted exposure record, runtime boundary, harness and main merge; all code findings were addressed. The bounded controller was reviewed in a second pass; all blocking findings were fixed, including the actual withdrawal callback signature, gas estimation and explicit failed-public/competing-exit actions. Claude found no remaining controller blocker; its recommended real-session fixture run then passed. The final seven-case withdrawal spec was rerun after the last test-file edit, satisfying the final evidence-freshness request. Source-only development functionality does not add a binary-user changelog entry under the repository playbook.

Local validation logs: `/private/tmp/privacy-oct1-controller-full-final.log`, `/private/tmp/privacy-oct1-unit-without-openlv.log`, `/private/tmp/privacy-oct1-openlv-isolation.log`, `/private/tmp/privacy-oct1-controller-lint.log`, `/private/tmp/privacy-oct1-e2e.log`, `/private/tmp/privacy-oct1-e2e-final.log`, `/private/tmp/privacy-oct1-controller-e2e.log`, `/private/tmp/privacy-oct1-withdrawal-final.log`. A sandboxed full-suite attempt could not bind local fixture servers and was stopped; two authorized combined runs passed all assertions but exited 1 due to late third-party websocket logging; the split runs described above both exited 0. Live reports: `/private/tmp/ppv2-recovery-sentio-oct1/recovery.json`, `/private/tmp/ppv2-crosscheck-oct1.json`, `/private/tmp/ppv2-session-oct1-fifth/session.json`, `/private/tmp/ppv2-session-oct1-restart/session.json`, `/private/tmp/ppv2-controller-oct1-zero/session.json`.
