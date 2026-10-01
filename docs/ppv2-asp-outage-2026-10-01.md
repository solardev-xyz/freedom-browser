# PPv2 controlled ASP-outage recovery — October 1

This qualification extends the pinned real Kohaku/SDK lifecycle with a complete ASP failure. It uses synthetic chain responses, the public test mnemonic and disposable Electron profiles. It does not access the funded profile or submit a live transaction.

## Exercised paths

- Fresh in-memory inspection reconstructs the exact deposited note across a 25,000-block synthetic history, with RPC windows capped at 5,000 blocks and routed through the protocol context. Real SDK history work drives the sanitized progress callback.
- During one inspection, every log request from the third window onward fails, including SDK retries. The public error is sanitized, the encrypted SDK cache remains byte-identical, and a later inspection succeeds once the fixture outage is removed. This is a sustained failure followed by retry, not a single flaky request or a persisted partial-scan checkpoint.
- A separate fresh Electron profile starts without a persistent SDK store. It receives only the public synthetic chain fixture and the fixed test mnemonic, reconstructs the note while ASP is unavailable, and preserves it through encrypted storage and session reopening while all encrypted `Note` events are withheld from the replay. The missing events make persistence reuse distinguishable from another successful full rescan. It sends no transaction. This is cold SDK initialization coverage, not a product backup/restore flow: journal and profile migration remain separate concerns.
- Real process restarts reopen the original encrypted profile. The synthetic emergency exit is proved and submitted, remains reserved before finality and across session reopening, and becomes terminal after finalized chain evidence. Every phase attempts the unavailable ASP and makes zero non-ASP HTTP requests.

The controlled HTTP replacement models unavailable services; transport grant enforcement and Tor are tested elsewhere. Exit-purpose preflight is covered by its separate unit fixtures. The work-limit and stall-limit failure branches also remain unit-test evidence: this short controlled history run does not approach those limits.

## Limits and next decisions

Mock RPC latency is not live Tor performance. Real chain growth, archival endpoint behavior, large event volume, transient network instability and durable intermediate scan checkpoints still need qualification. A successful remote reconstruction remains unverified chain/history evidence and gives no spend authority to the inspection result.

The host reservation, bounded-work and legacy-binding follow-ups are now implemented. Safe release of a failed or replaced exit still needs a decided evidence/finality policy; uncertain submissions cannot be retried based on a timeout. Product recovery, pending-state presentation and the first user-facing operation set need design discussion. Production activation, upstream audit/deployment matching and broad platform/egress qualification remain gates.

The [machine-readable controlled result](qualification/ppv2-asp-outage-2026-10-01.json) records the measurements and their scope. Claude reviewed the test and required explicit cold-profile coverage, failure attribution and progress assertions before accepting the evidence.
