# PPv2 final relay handoff and durable uncertainty

Date: 2026-09-27. Continues [native emergency exit](ppv2-native-ragequit-2026-09-27.md). Main was fetched and remains fully merged at `2983dc62`. No dependencies or node pins changed. SDK `fe0244e3` and Kohaku `6fdc248b` with the existing compatibility patch remain the qualified sources.

## Implemented

A main-owned relay handoff accepts the final JSON request for a narrow native, one-input/one-output withdrawal. It checks the selected HTTPS endpoint and chain, recipient, exact payout routing, fee recipient, maximum fee, withdrawal amount, no extra gas, proof shape, all eight expected public signals, and the proof context over processor/routing/encrypted note announcements. It refuses additional fields, other circuit dimensions, ambiguous JSON, yield/swap/batch operations and modified request bytes. The expected signals and input commitment must come from a main-owned witness/preparation boundary; the SDK or renderer cannot supply that authority.

Preparation calls a main-owned proof verifier before issuing a one-use object. The qualification uses a separate utility-process job that verifies the real Groth16 proof against the pinned `transact_1x1` verification key. No witness or private key is required by this verification job. The final review includes destination, amount, fee, selected endpoint and payload digest. The exact body and endpoint must still match when Kohaku's HTTP adapter calls `fetch`. Headers and request options are restricted.

After explicit approval, an encrypted, profile/account-bound journal is synchronously committed and fsynced **before** transport handoff. It stores only operation/intent/endpoint/payload digests, input commitment, nullifier, attempt time and optional acknowledged transaction hash. It stores no proof, request body, note secrets or signed fee commitment. The derivation namespace is stable across endpoint and SDK changes, so changing configuration cannot hide an unresolved attempt. Existing SDK cache and public transaction journals keep their separate responsibilities.

Failed persistence prevents a send. Once the attempt is durable, errors, cancellation, malformed responses, oversized acknowledgements and lost responses remain uncertain. A successful HTTP response records the reported hash but does not establish inclusion, correct execution or finality. No retry, deletion, release or “mark failed” API is supplied. This initial ledger deliberately permits only one recorded attempt per account until settlement/reconciliation is implemented.

The PPv2 session reads the journal on open, exposes a main-only attempt listing, and refuses public submissions while a relay attempt remains recorded. Recovery reads remain available. Public session submissions now share its operation-busy guard. This is a restart guard, not yet complete cross-path note reservation: the standalone relay handoff is not exposed by the session, and a future session integration must serialize both public and private attempts under the same account authority before it enables relay sends.

This code belongs in `src/main/wallet/` because main owns transaction approval, capabilities, cancellation and durable wallet state. Renderer or SDK-owned persistence would put that authority outside the existing boundary. No new IPC or renderer API is introduced.

## Upstream findings

The Kohaku candidate's private preparation is a quote/argument set. Its shared broadcaster invokes the SDK path that re-proves, submits and then persists note changes. A relay failure can leave inputs active. Reviewing that earlier quote, or writing a journal after `broadcast()` returns, is insufficient.

The handoff therefore operates on final proved bytes. The test captures the pinned SDK `RelayerInteractor`'s final serialization using a transport with no network authority, then passes the same request through the actual Kohaku `KohakuHttpClient` and the reviewed gate. It does not patch or claim to have integrated the candidate's full shared broadcaster lifecycle.

The SDK's `assertFeeCommitmentLive` uses **Unix milliseconds** despite the looser “Unix timestamp” type comment. The boundary follows its implementation, caps local preparation lifetime at two minutes, and checks expiry after proof verification, review and journal persistence. Expiry relies on the local clock. A regression test rejects seconds-based or expired quotes.

The proof cryptographically binds the selected routing and announcement data. It does not establish canonical root state, correct relayer deployment, availability or the relayer's fee-signature authenticity. `chainStateVerified` and `quoteSignatureVerified` remain false. Main must independently bind the input commitment to its witness-derived nullifier/signals; matching a caller-provided array alone cannot establish that relationship.

## Qualification

The new fixture constructs a real synthetic 1×1 proof: 10,000 units in, 5,900 to the recipient plus a 100-unit fee, and 4,000 private change. It independently verifies the final public proof in another utility process, rejects a changed curve point, uses the pinned SDK relayer serializer and Kohaku HTTP adapter, and injects a lost response after the journal has been observed on disk. A new Electron process opens the same encrypted journal and refuses another submission. The fixture's note announcement and fee signature are synthetic; it does not qualify recipient discovery or a real relayer signature.

- Focused handoff/session tests: 39 passed. Coverage includes altered routing/signals/bytes, expiry, review rejection, vault lock, failed writes, ambiguous outcomes, concurrent reservations, late callbacks, encryption/authentication and process restart.
- Full regression: 5,652 passed, 33 skipped, the same 3 baseline failures (two macOS shortcut-remap cases and the Safe fork integration case).
- Source Electron: relay qualification and existing full registration/deposit/recovery/ragequit lifecycle pass.
- Packaged macOS arm64: 3 passed (executable preflight, existing full lifecycle and relay qualification). Five affected packaged wallet modules match source byte-for-byte. Lint and whitespace checks pass. See [the qualification report](qualification/ppv2-relay-handoff-2026-09-27.json).

Reproduce by building the scratch ASAR with `scripts/spike-ppv2-process.js /absolute/pinned-ppv2 /absolute/generated-compat-directory --exit-circuits`. Supply its path as `FREEDOM_PP_V2_PROCESS_ASAR` for `test-e2e/ppv2-relay.spec.js`. Logs are `/private/tmp/ppv2-relay-{unit,regression,lint,source,build,packaged}.log`. The report contains no witness, proof, note secret or full payload.

## Remaining gates

Connect the real session's main-owned transact witness/proof preparation to this final handoff, including input/change accounting, trusted deployment binding and shared public/private reservation. Then implement receipt/nullifier reconciliation with explicit provenance before releasing the conservative attempt gate. Do not expose the current quote-only broadcaster directly.

Private transfers, other transact dimensions, ERC-20 approvals, ASP approval/revocation, relayer signature/deployment qualification, live Sepolia recovery, broader platform/egress checks, final upstream identity/distribution and UI/recovery decisions remain pending. The production experiment gate stays closed; no live transaction, new dependency or node-version change occurred.
