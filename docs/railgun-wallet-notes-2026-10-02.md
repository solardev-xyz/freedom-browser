# Railgun viewing-only note validation — October 2, 2026

The pinned engine9.6 now has a controlled wallet-note qualification and validation
helpers. [Eighteen guarded real-engine cases](qualification/railgun-wallet-notes-2026-10-02.json)
exercise guarded scanning against synthetic encrypted Shield
and Transact notes, using public upstream viewing vectors and disposable encrypted
stores. This is not a product wallet, a host coverage grant or a funded test.

## Result and validation boundary

Normal scans recover two ERC-20 notes with values1,000 and2,000. A fresh process
recovers the same notes; a local nullifier reduces the observed unspent total to
2,000, including after another restart. A same-range receive/spend is immediately
classified spent. Self-transfers exercise both received and sent record sets.
No scan invokes a POI endpoint, RPC, prover or signer. Pending Shield and missing
external-POI buckets are preserved; none becomes a spendable balance.

The guarded path authenticates and checks note/NPK
hashes before token lookup or storage. Mismatches are excluded while preserving
leaf positions, so crafted incoming data cannot veto subsequent valid notes.
Wrong-NPK plus unavailable NFT metadata is also excluded before metadata resolution.
A valid NFT is recovered entirely from its source preimage, without a token query.

Token resolution uses only locally supplied, re-hashed public preimages and the
ERC-20 address encoding. Failure is sticky and refuses completion regardless of how intermediate
callers handle the error. The preflight records receive/sent matches separately. Received
and sent record sets must exactly equal those expected positions; each recovered
record must match the public commitment, transaction, block and type. Received
nullifiers are recomputed and compared against the complete local public nullifier
set. A forced SDK deserialization error is refused by the guarded completeness check. A mismatch in stored records is fatal;
quarantine happens before the engine sees a malformed leaf.

Preflight cryptography is injected from the authenticated engine closure; Freedom
does not add a cryptographic implementation. Public-field bounds prevent
noncanonical token values from reaching token resolution. The test's sender and
receiver classification uses the pinned engine's existing blinding/annotation
semantics. [A real guarded Electron utility test](qualification/railgun-wallet-aes-2026-10-02.json)
confirms the exact AES authentication-failure text on this macOS arm64 runtime.
Other exceptions fail rather than being treated as foreign notes. That narrow
error mapping remains a platform qualification requirement.

The tests also found and fixed a synchronous LevelDOWN bridge problem: encoding
and presentation options reached the strict paged-store range parser. The adapter
now forwards only range fields, preserving output formatting locally. A real
paged-store regression verifies bounded iteration and clearing with those options.
The remote worker adapter already filtered them correctly.

## Scope and remaining work

The note matrix uses a synthetic two-leaf history and the direct in-process
adapter. It does not exercise a coordinator wallet window, actual user viewing
material, live discovery, full-history wallet throughput or product balances.
The AES utility test covers authentication semantics, not the complete wallet job.
Module-wide POI state is isolated by fresh processes. No production dependency,
public IPC, renderer flow or spending capability is added.

Next, the host must open an exclusive read-only public checkpoint window and keep
a separate encrypted derived-wallet cache. Coverage, cumulative received/sent
expectations and quarantine positions/transaction/reason must be persisted together
against that checkpoint; no attacker-chosen amount or token label belongs in a
quarantine display. New public history invalidates derived readiness until its
wallet scan completes. Imported/restored wallets scan from the beginning unless
a creation position is independently established. Neither an SDK scan cursor nor
promise resolution is sufficient evidence of completion.

Then connect current Kohaku balance/note semantics, qualify guarded Electron wallet
scans and live acquisition, bind proving artifacts to deployed verification keys,
and implement operation-bound signing, POI/relay transport and recoverable funded
shield/transfer/unshield. Existing authorized Sepolia funds remain untouched by
Railgun. Claude reviewed these helpers and the engineering evidence; this is not
a security audit. Focused checks:24 wallet validation cases and36 paged-store
cases; lint passes. Full regression passes7,614 tests with33 skipped across356 passing suites.
