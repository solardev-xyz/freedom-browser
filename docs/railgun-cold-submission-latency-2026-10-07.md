# Recovered submission under simulated latency — October 7, 2026

The recovered review budget (H = F, 10 s send reserve, 15 s review floor, 30 s
cap) was previously exercised only by the fake-clock boundary suite. The native
cold-submission qualifier now has an opt-in, fixture-only latency mode that runs
the same third-process submission through real Electron processes, receipts and
timers while each synthetic request waits on the wallet side.

## The hook

`scripts/fixtures/railgun-cold-submission-latency.js` wraps the synthetic
transport after the services and EOA fixtures and passes every request through
until the qualifier arms it for its one submission phase. While armed it delays
requests by destination: the four selected-POI source requests finish at evenly
spaced points of min(14 s, 65 %) of the POI phase (the boundary suite's split),
protocol and transaction RPC reads take the case's read latency, one deployment
read can stall, and the raw send has a delivery point inside its latency. The
local POI membership job's result reply is held for the rest of the POI phase;
in production that step is local work, so the hold is a simulated duration.
Aborts follow the real transport: caller signal, context revocation, close and
timeout. The wrapper records every request it issues, with its delivery and
outcome, as the per-destination inventory.

Cases with resolved history seed earlier ordinary sends through the production
journal API; the EOA fixture then answers their history-refresh reads and the
nonce. Approval is a simulated person: three seconds after the review is shown,
or one second before its shown deadline.

`node scripts/qualify-railgun-cold-submission-matrix.js <electron> <source>
<new-base> <engine> <prover> <artifacts> <bytecodes> latency` runs all nine
cases, each from a fresh disposable profile, and keeps going past a failure.
Without the final argument the launcher, qualifier and EOA fixture behave as
before.

## Cases and outcomes

All nine cases matched their stated expectation on their first launcher run
at `f071dc37` (27 process exits, all code 0). One earlier single-case smoke
run of `healthy-empty` also passed; an attempt before it never started, because
its shell passed the arguments as one word. Before the change, the unmodified
fourteen-case cold-submission matrix and its two warm cases passed at
`bd46dad5` (44 process exits, all code 0). The expectations are the
committed policy's column of the boundary suite's comparison, or its budget
arithmetic for `reads-650ms` and `send-9s-late`.

| Case                  | POI phase |  Reads | Resolved | Send, approval     | Shown review | Outcome                                           |
| --------------------- | --------: | -----: | -------: | ------------------ | -----------: | ------------------------------------------------- |
| healthy-empty         | 18,664 ms | 150 ms |        0 | 1 s, after 3 s     |    26,216 ms | acknowledged                                      |
| healthy-four-resolved | 18,651 ms | 150 ms |        4 | 1 s, after 3 s     |    24,946 ms | acknowledged                                      |
| poi-22s               | 22,066 ms | 150 ms |        4 | 1 s, after 3 s     |    21,519 ms | acknowledged                                      |
| poi-25s               | 25,070 ms | 150 ms |        4 | —                  |            — | refused before the nullifier: membership, budget  |
| reads-400ms           | 18,668 ms | 400 ms |        4 | 1 s, after 3 s     |    16,197 ms | acknowledged                                      |
| reads-650ms           | 18,664 ms | 650 ms |        4 | —                  |            — | refused before the nullifier: stale at nullifiers |
| nullifier-deadline    | 18,651 ms | 150 ms |        4 | —                  |            — | refused before the nullifier: stale at nullifiers |
| send-9s-late          | 18,645 ms | 150 ms |        0 | 9 s, 1 s before H  |    26,161 ms | acknowledged                                      |
| send-12s-late         | 18,673 ms | 150 ms |        0 | 12 s, 1 s before H |    26,120 ms | journaled-uncertain, node accepted                |

The nullifier-deadline case stalls the seventh deployment read for 10 s. Both
stale refusals carry `{stage: preflight, substage: acquire, code:
RAILGUN_PRIVATE_PREFLIGHT_REFUSED, reason: stale, step: nullifiers}`; their
inventories show the selected-POI requests, 13 deployment reads and the chain
check, root, fee and verifier reads, then no nullifier query and no
transaction-RPC request. The 25 s case carries `{stage: membership, code:
RAILGUN_PRIVATE_REVIEW_BUDGET}` and issued no preflight or transaction-RPC
request at all. In the 12 s case the genuine proof receipt expired about 11 s
into the send, after delivery: the journal holds the attempt, the result is a
`recovery-required` value at stage `submission` with code
`PRIVATE_BROADCAST_UNCERTAIN`, and the repeat was refused as a prior attempt.
The uncertain hash is available from the journal, not from that returned
value. Shown review windows are within about 0.6 s of the boundary suite's
for the same scenarios.

Outcomes are classified as the boundary suite does: an acknowledged hash, else
a durable journal attempt, else the first disclosure class (selected POI
commitment, selected nullifier, proved calldata, signed transaction) that was
never issued. A refusal report asserts that nothing at or after that class left
the wallet, that the synthetic services saw no nullifier query or transaction
request, and that the hold and EOA journal are unchanged.

## Limits

This is simulated service latency over a synthetic chain and synthetic services.
It is not live, not Tor, and circuit isolation is not applicable. The latency
model is the boundary suite's, not a measurement of Tor. Only the Shield private
transfer with an advanced root is covered; TXID-root acquisition for received
Transact inputs is not exercised under latency.
