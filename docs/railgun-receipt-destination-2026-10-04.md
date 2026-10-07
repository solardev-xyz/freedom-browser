# Railgun retained receipt destination — October 4, 2026

Receipt checks can now retain their exact RPC client before making any request.
Preparation returns an opaque destination observation for explicit trusted-main
review; later observation uses that same client, handle and captured input.
Changing registry selection cannot substitute another endpoint under the old
observation. Same-host URLs with different paths and different clients with the
same URL remain distinct bindings.

Private RPC and transaction-network ownership live in private WeakMaps. Their
get/assert accessors make no requests, including no automatic chain-ID check.
They reject copied observations, foreign clients/handles, revoked contexts and a
changed Tor endpoint instance. The destination serializes as `{}`. Only the
explicit main-process details accessor reveals the full retained URL, chain and
role. URL paths can be sensitive even for endpoints labeled unkeyed; they do not
belong in generic logs, errors or qualification reports. A retained client may
continue using its original endpoint after registry selection changes.
This includes removal or disabling in settings: those changes do not currently
revoke a prepared reader during its at-most-120-second lifetime. Future UI wiring
must explicitly decide whether to revoke it or recheck endpoint eligibility.

`prepareRailgunOwnReceiptReader` copies and freezes the bounded input, creates a
scoped transaction client, and returns a one-use reader. It neither authenticates
the supplied capture nor proves that capture is current. A future controller must
derive and reattest it through account recovery. The existing journal-known-hash,
intent, transaction, receipt and anchor checks remain in the shared observation
core. All returned authentication, disclosure and spending flags stay false.

Preparation has an actively enforced, nonrenewing lifetime of at most 120 seconds.
Observation claims the reader synchronously before any await and uses the earlier
of that original deadline and a caller-shortenable 60-second operation deadline.
There is no new signal or replacement destination at observation time. Duplicate
calls refuse without cancelling admitted work. Success, failure, expiry or close
consumes the reader; an unused expired reader also closes. The prepare-time caller
signal governs the entire lifetime.

Close immediately revokes admission; `closed` waits for admitted logical work to
settle. A request that ignores abort must still settle before this barrier does.
Cancellation does not retract delivered traffic and provides no hard drain-time
guarantee or proof of physical socket closure. The shared transport and unrelated
reader scopes remain usable.

The existing `observeRailgunOwnReceipt` API prepares and immediately consumes the
same core with its original maximum 60-second total budget. It now schedules the
observation body in a microtask. A same-tick abort therefore refuses at `context`
with zero requests; previously a transaction request could already have been
admitted. The existing cancellation test adds a microtask wait to exercise its
original in-flight scenario; other compatibility edits supply mocked destination
accessors and network signals. This is a deliberate narrowing of admission, not
a claim that the old tests were untouched.

These changes stay within existing main-process network and wallet modules. No
renderer, IPC, dependency, package boundary, public-policy or TXID-policy input
changes are involved. Only the receipt client's destination is bound here. The
scan source's retained destination, operation cancellation and bounded validation
traffic still require their own implementation before a fixed POI sender.

## Qualification

Four focused suites pass 96 tests. Lint is clean. Four isolated in-memory controls
have an eight-test passing baseline and eight expected failures: removing exact
observation identity, the one-use claim or the original deadline each causes one
failure; removing the pending-work drain guard causes five failures covering
journal, chain-ID, transaction, receipt and header work. Production files are
unchanged by these controls.

The Electron receipt fixture uses genuine disposable vaults, encrypted account
stores, operation capture and resolution permits. The actual private RPC and
transaction-network implementations run over a simulated transport, registry and
Tor endpoint. Factory load-order checks and positive dispatch counts guard the
interception. Each operation kind exercises nine existing cases and seven new
prepared-reader groups. The active path makes 16 requests and the archived path
17, each including one actual automatic chain-ID request at the transport seam.

The fixture changes registry selection between preparation and use, mutates the
caller's detached capture, checks opaque observations and duplicate refusal,
holds chain-ID/receipt work after cancellation, and verifies healthy sibling use,
unused expiry and Tor-generation refusal. The URL argument passed to transport
is observed; network routing and actual Tor circuit isolation are not qualified.
Chain observations and spend proof/signature fixtures are synthetic. No live
requests, owned-note disclosures, funded profile access or submissions occur.

The frozen [transfer](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-receipt-destination-transfer-2026-10-04.json)
and [unshield](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-receipt-destination-unshield-2026-10-04.json)
reports each bind 146 source files and pass in 2,271 and 2,074 ms respectively.
Both record 223 simulated transport dispatches, including 16 chain-ID requests
across all scenarios. The alternate URL receives none. These are single offline
fixture timings, concurrent with other verification, not latency guarantees.

The older own-preflight, POI-preflight and POI-membership qualifiers use synthetic
RPC clients. Their compatibility shims maintain a private fixture registry for
exact client/handle/observation checks and live context/signal validation, while
leaving production code and the real sensitive-details accessor unchanged. Their
shims replace only private-RPC get/assert; genuine transaction-network ownership
and handle checks still run. Their
reports explicitly label destination binding as simulated and unqualified and
the chain-ID handshake as unexercised. These composed fixtures cannot supply the
real client-binding evidence supplied by the receipt fixture above.

The frozen full regression passes 11,812 tests / 33 skipped across 476 passing
suites in 396.424 seconds (native access; existing OpenLV exclusion). This run
precedes the next merge of main.

Own-preflight [transfer](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-receipt-compat-own-preflight-transfer-2026-10-04.json)
and [unshield](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-receipt-compat-own-preflight-unshield-2026-10-04.json)
pass ten cases each with 146 matching hashes in 15,171/15,202 ms. POI-preflight
[transfer](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-receipt-compat-poi-preflight-transfer-2026-10-04.json)
and [unshield](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-receipt-compat-poi-preflight-unshield-2026-10-04.json)
pass ten cases each with 153 hashes in 15,346/14,911 ms. These four compatibility
runs retain their synthetic private-RPC boundary; no chain-ID count is inferred.
Retained-history [transfer](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-receipt-compat-history-transfer-2026-10-04.json)
and [unshield](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-receipt-compat-history-unshield-2026-10-04.json)
pass 17 cases each with 204 matching hashes in 128,700/126,673 ms. All six
compatibility reports preserve their prior scenario results and RPC/service counts.

Claude reviewed production, controls, native evidence, compatibility shims and
prose; Codex supplied implementation and independent tests. This is engineering
review, not a security audit. Main advanced to `f9a13854` during verification;
this snapshot is committed before that separate merge and pinned-node refresh.
