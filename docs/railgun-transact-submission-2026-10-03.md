# Railgun staged Transact submission — October 3, 2026

The enrolled qualification now connects genuine Transact staging and the
[private signing controller](railgun-transact-controller-2026-10-03.md) to
completion, fresh independent C verification, real vault EOA signing, the
production transaction service and encrypted EOA submission journal.

| Synthetic run | Combined staging/controller/submission | Result |
| --- | ---: | --- |
| [Transfer](qualification/railgun-transact-submission-transfer-2026-10-03.json) | 7,540 ms | Simulated acknowledgment; submitted journal record |
| [Unshield](qualification/railgun-transact-submission-unshield-uncertain-2026-10-03.json) | 7,178 ms | Simulated lost acknowledgment; attempted record and authenticated hash retained |

Both reports contain 19 recovery runs and 130 source hashes matching the frozen
qualification tree. Timings are single local observations from concurrent runs,
not production latency estimates. Each records exactly one B launch, one
synthetic spending-key request, one real vault EOA signature and one simulated
raw send. External transport attempts and unexpected submission RPC attempts
are zero. The nine simulated submission RPC requests comprise code, gas estimate,
call, gas price, balance, three nonce reads and one send.

The actual encrypted journal contains the attempted hash and exact intent before
the simulated transport observes signed bytes. A fresh in-process context reopens
the journal and checks that the unresolved attempt blocks another transaction.
Completion reuse refuses at the completion stage, leaving all recorded RPC,
signer, review and private-gate counters unchanged. Exact private signing entry
and stored capsule state are compared before and after submission, then preserved
through the existing public-cache rebuild and enrollment-reopen sequence.

The fixture counts RPC and signing attempts before assertions. Its shared fixed
response table defines permitted simulated RPC methods. A second assertion after
the production submission call rejects any unexpected method even if production
caught the fixture error. Codex identified this qualification gap, then approved
the correction and both final reports. Captured fixture sources are revoked and
module exports/cache entries restored on exit.

Root services, POI, private preflight and EOA RPC are simulated. History and vault
keys come from the existing public test vector. These runs make no live requests
or submissions and establish neither mined inclusion/finality, full application
restart, nor post-transaction POI acceptance. Creator bound-parameter coverage and
global TXID completeness remain false. The live funded Shield note is untouched;
owned-note POI disclosure remains pending authorization.

Only qualification scripts changed after production commit `98aeed04`, whose
full native regression passed 9,253 tests / 33 skipped across 436 suites with the
existing OpenLV exclusion. The updated scripts pass lint and both actual Electron
qualifications. No production dependency, IPC or renderer surface changed.

Remaining work includes interrupted private-signing recovery, post-transaction
POI and a second spend, broadcaster integration, and funded private qualification.
