# Railgun live scan cancellation, 2026-10-03

The read-only Sepolia scan exposed an incomplete cancellation path in the wallet
Tor transport. At commit `6918d098`, one run completed 205 additional ranges,
moving from block 5,859,999 to 9,959,999, then stopped progressing following an
Arti guard connection failure. The RPC and source deadlines did not settle the
scan promise. Inspection found no remaining TCP connections, Railgun utility
processes, or open Railgun SQLite descriptors. The qualification process and its
own Arti child were terminated; the encrypted profile and completed checkpoints
were retained. No signing or submission was enabled.

The exact live event sequence has **not** been reproduced. Several real SOCKS
fixtures, including failed replacement connections, also pass against the old
transport. Node can nevertheless leave a destroyed queued ClientRequest waiting
for socket assignment before emitting an error. Our old promise depended on
that error event. A controlled event-silent request regression times out against
the old implementation and passes with explicit cancellation settlement.

The transport now destroys the request and settles its promise directly when
its combined lifetime aborts, removes its abort listener on settlement, and
continues consuming late errors. Request close without a complete response
rejects. A complete response remains eligible for its readable end event even
when the server closes the connection first. All outcomes remain bounded by the
original request deadline; there is no direct-network fallback or automatic
retry. Claude reviewed the change and identified the complete-response close
race before the final fix.

The qualification harness also has a ten-minute per-range watchdog. It saves a
failed observation, revokes capabilities, locks the vault, stops Tor, and forces
process exit if draining remains stuck. This is last-resort qualification
diagnostics, not a way to release or reuse live production capabilities. The
first recorded failure survives subsequent cleanup errors.

The first restart recovered block 9,959,999 and completed eight more ranges to
10,119,999. A subsequent scan refusal settled and shut down normally, retaining
that progress. Its report is a **failed partial run**, not a full-history
qualification. Another explicitly started read-only continuation is in progress.
The refusal is unclassified: the coordinator's generic error does not distinguish
transport failures from source limits or canonical mismatches. This continuation
used the final transport with an earlier 360-second watchdog; the interrupted run
used the old transport and harness at `6918d098`. Each report records its source
hashes. Neither report exercises the watchdog's forced-exit path.

Evidence:

- [Interrupted original observation](qualification/railgun-live-interrupted-2026-10-03.json):
  the original saved report, intentionally lacking a final pass/failure result.
- [Bounded failed continuation](qualification/railgun-live-bounded-failure-2026-10-03.json):
  eight recovered/advanced ranges and the final refusal.
- Transport/source focused checks passed under Electron's Node 24.21.0.
- Native full suite: 7,993 passed, 33 skipped, 382 passing suites; lint clean.
  This run also included the initial TXID omission classifier tests; subsequent
  TXID projection work is separate.

This does not qualify Tor circuit isolation, RPC completeness, POI eligibility,
mainnet use, or a Railgun funded transaction.
