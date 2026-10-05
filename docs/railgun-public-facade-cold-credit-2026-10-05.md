# Railgun public Shield credit across process restarts - October 5, 2026

The actual Kohaku public Shield instance now passes a three-process deposit,
receipt-resolution and wallet-credit sequence for both acknowledged and lost
submission responses. The first process signs and sends once; the next resolves
the retained submission and credits its note through the ordinary scanner; the
third opens the completed wallet read-only and still sees exactly one credit.
All six Electron processes exited zero, with their original launcher handles
observed and drained. Services and chain history are synthetic public-vector
fixtures. This does not qualify a live public-facade deposit or a private spend.

## What the connected test establishes

Setup uses genuine vault enrollment, public-source and encrypted wallet stores,
the real Kohaku public factory and its separate public submitter. A denied
preparation review stops before extra work. The wallet then reopens through the
normal active path. Copied tokens, the private broadcaster and token replay
refuse. Preparation review explicitly covers the protocol/transaction destinations
and simulation disclosures. An Ethereum signature and durable attempted record
precede the sole synthetic raw send. The lost-response case retains uncertainty;
it does not automatically resend.

A fresh process independently derives the funding owner and reopens genuine
stores. An unavailable receipt remains pending; an ABI-valid ciphertext change in
the receipt refuses before resolution review. Healthy receipt resolution retains
an explicitly accepted unverified-RPC result and does not alter the wallet
generation. Only after recovery closes and its logical transport groups revoke
does explicit public advancement run. The ordinary wallet engine scans/decrypts
the resulting Shield note and credits exactly its net WETH amount. Existing
notes, spent markers and unrelated balances remain unchanged.

The third process uses the fixed completed-only opener. It performs no receipt
queries, signing, sending or explicit source advancement, preserves the encrypted
wallet-generation bytes and reports the identical owned-data digest. Read-only
restoration can still perform its documented source checks; it is not a zero-RPC
operation. Balance and note reads remain unverified and grant no spendability.

## Native matrix and resource observations

| Response      |    Setup | Resolve and scan | Completed restore |
| ------------- | -------: | ---------------: | ----------------: |
| Acknowledged  | 3,234 ms |         2,177 ms |          2,911 ms |
| Lost response | 3,083 ms |         2,221 ms |          2,860 ms |

Times are fixture phase measurements, not network performance results. Each row
uses three distinct process IDs, checks its predecessor has exited, and verifies
unchanged source/input hashes before and after every phase.

Per sequence, utility jobs are 8/6/4 and storage-worker opens are 7/3/3. New source,
public and wallet stores each initialize a staging worker and reopen the published
store; setup also reopens the wallet after the denied review. Later phases open
three existing stores, with the final wallet using the read-only worker. Exact
category maps distinguish these operations rather than checking only totals.
Across both sequences, 36 utility closures and 26 exit-zero worker closures are
observed. All borrowed credential buffers are checked wiped. Utility closure
reports use their explicit normal-close code and non-escalated exit semantics;
this is not a claim that every utility process exits with numeric zero.

Each setup makes 47 source-header requests, one log request and one chain-ID
request, plus 13 deployment and 10 transaction requests. Resolve makes 36 source
header requests, two log requests and one chain-ID request, plus 41 transaction
requests. Restore makes 17 source-header requests, one log request and one
chain-ID request, with zero transaction requests. Attempted and validated method
maps must match exactly. Each setup has one Ethereum signature and one synthetic
send; all four later processes have zero. There is one controlled lost response.

Logical group revocation and observed process/worker closure do not establish
physical Tor/socket isolation or operating-system egress containment. This test
performs no POI/TXID service query, consensus verification or live eligibility check.

## Corrupted source control

The [aggregate negative evidence](qualification/railgun-public-cold-corrupted-source-control-2026-10-05.json)
records a separately frozen copied runtime that completed setup with exit zero, then flipped
one bit in the newly appended Shield ciphertext after healthy receipt resolution
and recovery closure. The matched synthetic receipt and transaction stayed
unchanged. Ordinary public advancement and wallet scanning completed: the public
leaf was applied, but the damaged note received no owned credit. Existing notes
and WETH balance stayed unchanged, and resolve made no signature or send.

The control then failed at the original required-credit assertion (zero notes
versus one), exactly as intended. Its second process exited one; the supervising
launcher exited zero only after checking that precise assertion, complete marker,
no successful successor handoff/report and unchanged source/input/dependency
inventories. A generic crash would not pass. This is evidence of the scanner's
ownership boundary under synthetic history, not independent chain authentication.
The sticky failure also prevents a successful final resource report:
`resources: null` and `cleanupQualified: false` are retained explicitly. Observed
process exits do not turn that failed observer closure into healthy drain evidence.
The mutated source tree and disposable profile are not publication inputs.

## Validation and source scope

The [qualification index](qualification/railgun-public-facade-cold-credit-index-2026-10-05.md)
links the six exact reports and their independent audit. The final root unit run passes 684 tests across 13 suites; full lint and scoped
formatting pass. The native campaign uses the r1 fixture with reviewed r2 address
normalization, r3 worker accounting and r4 Electron virtual-cache classification.
The outer frozen inventory contains 5,795 source/configuration entries and ten
external inputs, including the exact Electron executable and Framework, the engine
archive used by utility processes, the prover archive pinned only as provenance
(not launched), public source/bytecode inputs and pinned Kohaku contract files.

Each native report contains the identical 5,545-entry recursive source inventory.
Of these, 4,352 are JavaScript/JSON files under the nested engine fixture's
node_modules. This broad inventory records bytes, not execution coverage. The
archived engine actually used by utility processes remains separately pinned.
Main-process cache coverage requires all real project imports to be inventoried;
only the three observed Electron virtual aliases are separately recognized, with
exact metadata/export identity and no real shadow file. Unknown aliases still
refuse. The zero-operation import probe's smaller scratch inventory is not the
native inventory.

Handoffs seal selected identity/account/submission data and the inventory marker,
not the entire Chromium profile or an exact permitted-write delta. They are test
data, not transferable capabilities. Fresh enrollment and current owners supply
actual authority after each restart. No profiles, keys, signed wire or private
handoff plaintext belong in the published evidence.

## Excluded bring-up runs

The earlier setup-a, setup-b and setup-c processes exited one and are excluded
from the successful matrix. They exposed fixture errors: checksummed nonce
addresses versus a lowercase fixture owner; omitted staging-worker counts; and
Electron's virtual module-cache aliases being mistaken for files. Each correction
was source-traced, independently reviewed and tested before a fresh campaign.
The preparatory d freeze was not run; e additionally pins the Electron Framework.
No earlier failed profile was reused. The initial restricted runtime-only probe
aborted without output; its narrowly scoped unrestricted retry exited zero before
app readiness. It is not deposit lifecycle evidence.

Claude and an independent Codex reviewer checked the fixtures, native evidence
and publication claims. This is engineering review, not an external security
audit. No funded profile or live service was used.

## Remaining work

This closes the controlled public-facade cold-credit composition in the
[parity plan](railgun-parity-plan-2026-10-04.md). Portable host extraction,
production transport/platform qualification, live service and verifier acceptance,
and the funded private transfer/unshield journey remain separate. Any later read
projection extraction that rotates the wallet source policy needs a newly
qualified generation; this campaign must retain its original source/policy scope.
