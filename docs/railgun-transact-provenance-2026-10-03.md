# Railgun operation-bound Transact provenance — October 3, 2026

The main-owned provenance lifetime consumes a genuine staging receipt once,
synchronously before asynchronous work. Failed or cancelled attempts cannot reuse
that receipt. The claim binds the exact account, owners, request and operation
window, and observes both staging and window cancellation.

Within A, the composer captures the selected note's authenticated creator prefix,
checks the row's graph transaction index against the creator, and compares block,
transaction hash and selected output. It obtains the operation digest from the
genuine creator receipt. The staged archive, state and witness feed the detached
pinned-engine verifier; utility exit must precede success. The resulting lifetime
allows one root-acquisition attempt for the exact staged checkpoint. It never
substitutes a newer service head for that root.

The opaque receipt rechecks the original selection, policies, generation, window,
creator receipt, operation deadline and first-query root freshness with a caller's
required margin. Its observation retains hashes of creator/source evidence and
the staged checkpoint, plus the exact operation digest. This is ephemeral
main-owned evidence, not a persistent policy or a renderer capability. Existing
staged policy checks remain active; qualification records hash the new composer.

The caller must await `close()` before leaving the callback. Close revokes
synchronously and drains pending root work; failed opening already awaits creator
and detached-verifier settlement. Service contexts check the monotonic operation
deadline synchronously between requests, so delayed timer dispatch cannot permit
another request. No account is closed from inside its own operation callback.

## Validation and limits

[Actual enrolled qualification](qualification/railgun-transact-provenance-enrolled-2026-10-03.json)
passes alongside 19 recovery runs with 130 matching source hashes. The new slice
takes 3,934 ms in one local measurement. Five independently revocable simulated
services receive six latest-root queries, one page query and five root checks.
The real composer succeeds, staging reuse and root reacquisition refuse, and a
20-second provenance/root/window margin is checked. The receipt is explicitly
closed before callback exit; its later refusal does not independently isolate
automatic window revocation.

The retained source is deliberately derived synthetic public-test-mnemonic
history, with one unrelated nullifier inserted into the creator transaction.
This does not establish valid on-chain spending. Public root acceptance is
simulated; bound-parameter authentication and global TXID completeness remain
false. Prefix authentication does not establish chain consensus. No POI,
preflight freshness, signing or submission authority follows from this receipt.

Sixty-three focused tests across three suites pass and lint is clean. The Codex
reviewer found two dispatch/cancellation defects: staging revocation was not
propagated into pending provenance work, and a delayed timer could permit a root
request after the operation deadline. Both are fixed. Regression controls fail
with the old boundaries; the root-boundary tests use the actual root source.

The qualification's new slice records zero signer launches, spending-key
requests, external transports and forbidden RPC attempts. Viewing keys and
simulated public queries are used; surrounding existing cases sign and prove
with public synthetic keys. No live owned-note query or transaction occurred.

The [private signing controller](railgun-transact-controller-2026-10-03.md) now
consumes this evidence alongside independent POI and preflight gates. The
composer itself grants no signing permission. Its root acquisition additionally
accepts a caller-shortenable 20-second budget, enforced synchronously between
requests and cleared after settlement; signing assertions retain the original
root-receipt freshness bound. No dependency, IPC or UI surface changes.

## Main integration and regression

Main `b18d571b` was merged cleanly in `27935f12`. Ant 0.5.56 was downloaded
for every configured target; freedom-ipfs 0.4.3 and libradicle 0.7.1 were refreshed
for this macOS arm64 host; all official Myotis 0.1.12 targets were refreshed,
including the host's offline ABI 32 checkpoint constructor check. Existing Arti
2.6.0 was version-checked. Node 24.18.1 matches `.nvmrc`; `npm ls --depth=0`,
`npm run check-binaries` and lint pass. No dependency manifests changed.

The frozen merged production/test/fixture tree passes 9,239 tests / 33 skipped
across 436 passing suites in 297.768 seconds. The prior OpenLV test exclusion
remains. This is local regression evidence, not a new funded operation, platform
matrix, renderer smoke test or current-HEAD rerun of every historical report.
