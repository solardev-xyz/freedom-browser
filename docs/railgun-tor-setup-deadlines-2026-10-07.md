# Bounded Tor setup for public chain metadata

The metadata repair passed production readback at `2867c4fa`. Both subsequent
preparations stopped on their first Tor RPC read with `TOR_REQUEST_FAILED`.
Neither reached a private preflight probe or reserved the continuation's recovery
attempt. No transaction was submitted. The campaign stopped after the repeated
preparation failure; its manifest, old consumed ledger and repair evidence remain
unchanged.

## Evidence and limits

Public-only diagnostics used the actual wallet transport, and then the actual Tor
manager and private RPC client, without unlocking a vault or selecting a note.
Scratch comparisons copied only the funded profile's Tor cache/state and verified
that the original files remained unchanged. Those copies use its guard state;
this is not a claim of no profile-derived network metadata. Copies and logs stay
local, and no Tor state was reset or deleted.

| Diagnostic                            | Bootstrap | Public RPC result                                    |
| ------------------------------------- | --------- | ---------------------------------------------------- |
| Dedicated fresh Arti                  | 4,631 ms  | Chain ID 741 ms; finalized header 247 ms             |
| Fresh managed Tor                     | 10,100 ms | Chain check plus finalized header passed in 1,884 ms |
| Full copied Tor cache/state           | 1,229 ms  | Failed at `connect` after 10,020 ms                  |
| Copied cache, fresh state             | 1,225 ms  | Passed in 891 ms; SOCKS setup 87 ms                  |
| Copied state, fresh cache             | 3,233 ms  | Passed in 2,500 ms; SOCKS setup 1,347 ms             |
| Full copied cache/state, separate run | 1,255 ms  | Passed in 10,638 ms; SOCKS setup 9,864 ms            |

The extra SOCKS setup cap is 10 seconds, while these public RPC requests allow
45 seconds overall. The successful near-limit setup justifies testing a candidate
that removes this additional cap for public metadata reads. It does not establish
the precise cause of either funded failure, predict a circuit's latency, prove
corrupt state or qualify the complete live wallet journey. Earlier warm submission
and probe failures retain their original unknown causes.

Diagnostic development failures are preserved separately: one synthetic context
used an unsupported role/kind and made no RPC request; one scratch copy had
broader nested directory permissions and Arti refused before readiness. The copy
was corrected by preserving source modes, never by disabling Arti checks or
chmod-ing the original state.

## Candidate behavior

Only `eth_chainId` and `eth_getBlockByNumber` opt into a setup budget equal to their
existing request budget. Other methods—including nullifier calls, calldata
simulation and raw transaction sends—keep the 10-second setup cap. There is no
retry, provider change, new isolation policy or receipt renewal. The RPC client
rechecks admission after its hidden chain-ID request before admitting the requested
method.

The transport validates each setup budget and caps it by the request's remaining
monotonic lifetime when connection creation begins. The original timer starts
before Agent queueing and continues through SOCKS, TLS and the response. Context,
endpoint and caller cancellation continue to revoke the same request. If the
request-bound SOCKS timer wins a timer tie, it aborts the original request timeout
controller, yielding `TOR_REQUEST_TIMEOUT`. A shorter setup-cap failure remains
`TOR_REQUEST_FAILED` at `connect`.

The queue regression exposed a related ownership problem: Node's same-origin
`Agent.removeSocket` replacement path can call `createSocket` with the retired
socket's options. Private request metadata is now recorded by request identity at
`addRequest` and restored for that actual request at `createSocket`. A queued
request therefore cannot inherit the prior request's setup budget, diagnostic
record or cancellation signal. No private Node symbols are used.

The inherited-options defect also exists in the live baseline `2867c4fa`.
Cancelling a queued request there did not cancel its replacement setup, and a
setup failure could be attributed to the retired request. Agents remain isolated
by context, so this did not mix context identities.

Review of the first candidate found that refusing a destroyed queue head could
strand live requests behind it. The revised candidate reads Node's queue without
modifying it and binds setup to the first live owner. Expired owners are aborted
before being skipped. If that owner dies during setup, selection continues on a
microtask, with explicit group-liveness checks, a visited-owner set and a maximum
of 32 owners. A still-live owner's setup failure is delivered to that owner and
never retried. The original Agent callback receives one final result. Each
connection attempt and abandoned socket remains tracked through the close barrier.

## Validation

- Six focused suites: 345 tests pass, covering real HTTP/TLS/SOCKS setup beyond
  10 seconds, concurrent capped and extended requests, queue expiry before a
  delayed timer callback, setup/response deadline sharing, admission after a slow
  chain check, private preflight and journal/submission boundaries.
- Four additional lifecycle, stage, RPC-composition and read-budget suites:
  161 tests pass. The controlled HTTP lifecycle fixture now forwards the request
  options that real Node forwards; real Agent queue behavior is tested separately.
- Initial sandbox-denied loopback failures, two queue-test development failures,
  the timer-tie regression and the outdated controlled fixture are recorded
  separately from passing runs.

The original 506 tests also passed under Electron 44.5.1's Node 24.21.0. This
includes real same-origin replacement tests exercising the wrapped Agent methods.
The subsequent queue fix adds regression cases for cancelled and expired heads,
no live successor, cancellation during replacement, group revocation and delivery
of setup failures to a live owner behind a destroyed head.
The combined queue fix and continuation source-binding change pass 886 tests in
12 suites under Electron, including the private submission and qualifier tests.

One public-only run at `ec873815` used three successive contexts with distinct
SOCKS isolation tokens. Their setup times were 11,045 ms, 293 ms and 862 ms; all
three public chain checks and finalized-header reads passed. Source hashes match
that commit and the original Tor-state files were unchanged. The first setup
demonstrates useful work beyond the old 10-second cap. Distinct tokens do not
prove distinct Tor circuits, and this was not a funded wallet qualification.

These source and controlled-network results preceded the bounded live continuation
below. A longer first public connection can still exhaust the unchanged 20-second
preflight acquisition budget; it cannot guarantee recovery or POI service acceptance.

## Source revision binding

The original `continuation.json` remains unchanged. An optional, fixed
`tor-setup-source-revision.json` binds its exact digest, both failed preparation
reports, the reviewed source commit and one remaining round. When this file is
present, the helper refuses the old source and any different source. Missing or
altered historical evidence refuses admission. The repair writer and metadata
hash checks remain mandatory.

The recovery ledger filename remains `recover-submit.metadata-repair-1.jsonl`.
Any existing file there, even torn or pending, still consumes the allowance.
The new header includes the original manifest digest and the source revision
digest. The revision creates no second recovery attempt and changes no send,
fee, disclosure, receipt or retry limit. Probe scheduling and reservation of
the one remaining preparation are enforced separately by the operator guard.

## Final live continuation at `c208245f`

Independent review cleared the queue fix and the fixed source revision. The last
of the three preparation rounds completed a fresh scan through block 11,865,286,
with one asset and independent event coverage. The local spent read found the
held input unspent through that anchor only. Exactly one private preflight probe
passed in 16,770 ms, queried the nullifier, and left the protected hold, capsule
and journal unchanged. The probe does not establish that the later recovery can
complete; that operation acquires fresh prerequisites.

The one reserved recovery attempt then refused with submission elapsed 43,729 ms at
`preflight / acquire / deployment / anchor`, with reason `rpc` and cause code
`TOR_REQUEST_FAILED`. It reached one combined disclosure review (POI, private preflight and
transaction RPC) and no transaction review. Before refusal it made the submitter
EOA reads and completed the POI membership step, then stopped at deployment before
the private preflight nullifier query. Only the earlier probe queried the nullifier. The authenticated journal readback found no attempt or send. The input
remained `proved-unsent` and reserved. The fixed continuation allowance is consumed;
no observation, POI submission, restart or unshield step followed, and there was
no resend. The old consumed ledger and original manifest stayed unchanged. All
349 reported source hashes matched the clean live commit.

| Retained report  | SHA-256                                                            |
| ---------------- | ------------------------------------------------------------------ |
| Completed scan   | `4e196a6237d2c74fab779a0339fd3fc3c110d29885426d1a15c1e0050bb47d7d` |
| Passed probe     | `b926daea13088f0a83df3a28912448c379162d4744c6de5563bd5e8ad86c386a` |
| Refused recovery | `77bf7dce8cf05683b880bd2327ba69fe90b0b908bf315a8b7e099fc3754a81b8` |

Reports containing account-linked data remain local; this document retains only
the outcome and integrity references. Earlier calldata exposure through gas
estimation means a local no-send result is not proof that nobody else submitted
that transaction. The spent observation above is limited to its scan anchor.

The public-metadata setup deadline now ends as `TOR_REQUEST_TIMEOUT`; the
20-second preflight stop yields `inactive` / `PRIVACY_REQUEST_ABORTED`. This
`rpc` / `TOR_REQUEST_FAILED` observation is a different failure from the old
10-second metadata setup cap. The probe and recovery each used a fresh dedicated
Arti with empty state. The managed Tor state examined by copied-state diagnostics
applied only to the scan qualifier. These distinctions do not identify the cause.

The deployment preflight dropped the transport's closed `stage` field when wrapping
its error. A follow-up forwards the six allowed stage values through both wrappers
and the existing private-submission diagnostic. Own-data property reads refuse
accessors, proxies, inherited fields and unknown values without evaluating them.
This adds no requests, retries, fallback or authority. It cannot retrospectively
identify the failed transport stage or root cause of this live attempt. The
follow-up passes 520 tests in four affected suites; independent review covered the
forwarding path, with additional getter/proxy controls added for its review nit.

The live end-to-end self-transfer, output POI acceptance, cold recovery and full
unshield milestone remains open. This campaign is stopped, not reset. Independent
portable-package work continues without opening the funded profile.
