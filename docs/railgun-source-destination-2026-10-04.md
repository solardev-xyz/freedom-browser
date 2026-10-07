# Railgun retained scan-source destination — October 4, 2026

A genuine enrolled public coordinator can now expose the destination of the exact
RPC client its scan source retains, before recovery or any request. Source and
account accessors return the existing opaque private-RPC observation; URL details
remain behind the explicit trusted-main accessor. These observations establish
destination identity only, not consent, canonicality or permission to query.

The source registry binds the returned source instance, its original handle,
retained client and active-state check. Get/assert reject copied or foreign
objects, dead ledgers, closed sources, revoked contexts and changed Tor endpoint
objects. They never reconstruct a client from current settings. A later genuine
client created on the same handle cannot replace the source's original client.
This matters even when Tor's endpoint object changes without aborting the old
endpoint signal: the original client is invalid despite its signal remaining
live. A dynamic lookup for whichever client is currently live would be weaker.

The account registry additionally binds the exact enrollment object and current
directory owner, then checks the existing active catalog generation, registered
policy and coordinator context. Unpublished candidate or pending generations
refuse. An active coordinator can be observed while cold, before lazy recovery.
While open, the pre-existing general account assertion retains its equivalent-
binding behavior; only the new destination accessors require exact enrollment
identity. Close now removes the old registration before revoking signals, so even
the general assertion refuses as soon as close begins. Old cleanup cannot remove
a replacement owner's entry.

No getter acquires a snapshot, refreshes a header, recomputes policy, derives keys,
opens storage or starts a utility job. It does not call RPC `ready()` and therefore
does not trigger the lazy chain-ID request. Existing acquisition APIs and the
host-based meaning of stored `providersSha256` remain unchanged. Invalid
observations refuse without closing a healthy source or account.

There is no new destination TTL; the source/account lifetime governs it. Settings
changes, including removal or disabling of an endpoint, do not replace or revoke
the retained client. Future UI wiring must explicitly decide whether to revoke
or recheck eligibility. Reopening creates a distinct source/client observation.
The accessors expose no URL on their ordinary serializable surface.

This stays within existing main-process source/account ownership. A new generic
handle-indexed RPC lookup was considered during review and rejected because it
could describe a replacement client the source did not retain. No coordinator API,
renderer, IPC, dependency or request-authorization hook was added. Shared-source
cancellation, completed-checkpoint-only admission, borrowed-work drain and bounded
validation traffic still need their separate implementation before a fixed sender.

## Policy and retained accounts

`railgun-scan-source.js` is a public-policy input. Its change moves the public
policy from `094a7be418c7b4ba71a882b06f17bb91ada8002d1f74833cc4347b0077b9a5ca`
to `9cd0ea7d300f2df40073d6a77c81e8f601280c0230fd905fc6ac0739bef33727`.
The TXID policy hash is unchanged: it hashes the bytes of the public-policy
module, not its computed value, and this slice changes none of its inputs.
Nevertheless, a new public generation changes TXID mirror directories, key
derivation and journal public-identity binding. An unchanged TXID policy does
not make an old generation's mirror interchangeable.

The former generations and files stay retained. They cannot silently satisfy the
new pinned public policy. Earlier generation-bound qualification reports are
historical. All qualification here uses fresh disposable generations and mirrors.
The funded profile is not represented as operational under this new policy and
is neither opened nor rebuilt. Its reviewed rebuild remains deferred until the
coming cancellation changes settle the policy inputs. There is no automatic live
migration, deletion, owned-note query or funded private operation.

## Qualification

The new source/account destination suites and existing source/account suites pass
72 tests across four suites; existing tests are unchanged and lint is clean.
Source tests use actual source and private-RPC implementations with simulated
ledger/transport. Account tests use the actual account registry, encrypted catalog,
source and private RPC, with explicit enrollment, store and coordinator authority
mocks. They assert zero query/chain-ID/recovery/key/job work for observations,
pending-generation refusal followed by publication, exact ownership, path
retention, lifecycle revocation and the same-handle Tor-replacement case above.

Two isolated in-memory controls have a two-test passing baseline. Removing the
exact enrollment comparison admits an equivalent but distinct enrolled object;
bypassing the source observation assertion admits a forged observation. Each
produces one expected failure without editing production files. These controls
do not independently distinguish the directory-owner comparison from the existing
lifetime checks.

The converted native source fixture uses real private RPC over a simulated
transport, network registry and Tor endpoint. Genuine disposable enrollment,
encrypted source/public stores, coordinator, planner and source capture remain.
It tests the URL passed to transport, not live routing or actual Tor circuits.
Native zero-work counters cover requests, client factories and authenticated
source visits; key/job/recovery zero-work spies belong to the unit tests above.
It adds opaque active/cold destination checks, retained same-host paths,
copied-owner/observation and policy refusal, close/reopen and Tor replacement to
the six existing capture/cancellation/storage-failure scenarios. This slice does
not improve those existing cancellation semantics.

Native [transfer](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-source-destination-transfer-2026-10-04.json)
and [unshield](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-source-destination-unshield-2026-10-04.json)
each pass six existing and three destination groups with 140 matching source
hashes in 1,857/1,825 ms. Each constructs two real clients and dispatches two
chain-ID requests, 92 header requests and two log requests. The original client
uses its retained path for 76 requests, including after registry selection
changes; the reopened client uses the newly selected path for 20 requests.
These single offline timings overlap other verification and are not guarantees.

Fresh retained-history [transfer](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-source-destination-history-transfer-2026-10-04.json)
and [unshield](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-source-destination-history-unshield-2026-10-04.json)
pass 17 scenarios each with 204 matching hashes in 133,178/131,420 ms. They
exercise the substituted historical-root refusal and healthy retry through
actual proof/recovery composition with simulated RPC and service observations.
Their destination identity remains explicitly fixture-simulated; these runs do
not replace the real-RPC binding evidence above.

The [enrolled staging rerun](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-source-destination-staging-2026-10-04.json)
passes all 19 surrounding cases with 130 matching hashes and records the new
public policy. Its handoff step takes 4,262 ms, restores the checkpoint and
recovers the same owned test note, observes detached utility exit and refuses
reuse. Six latest reads, one page and five root validations use five synthetic
service instances. Staging signer-launch, spending-key, transport and unrelated
RPC counters stay zero; surrounding fixture cases use public test keys for
their own proof/signing tests.

The frozen full regression passes 11,858 tests / 33 skipped across 480 passing
suites in 392.611 seconds (native access; existing OpenLV exclusion). Claude
reviewed implementation, controls, native evidence and prose; Codex supplied
implementation and independent tests. This is engineering review, not a security
audit. Main `f9a13854` and its pinned-node refresh were already incorporated in
`4c90a26d` before this slice.
