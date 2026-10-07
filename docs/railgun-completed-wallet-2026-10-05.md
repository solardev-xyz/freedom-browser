# Completed wallet restoration and credential drainage — October 5, 2026

A saved, completed Railgun wallet can now be opened through a fixed read-only
route. This is a prerequisite for resuming an interrupted proof without repairing
or advancing the wallet as a side effect. Proof resumption itself is still open.
The implementation stays in the existing main-process wallet, storage and utility
modules; it adds no renderer surface, IPC channel, dependency or runtime pin.

## Completed-only admission

`openRailgunCompletedAccountWallet` requires a current identity, enrollment,
public destination and active generation under the current wallet policy. Both
wallet database and journal must already be registered in the authenticated
profile inventory. Missing, pending, unregistered or stale state refuses without
creating stores, adopting files, rotating the journal lease or rebuilding caches.
Ordinary prepare, operate and handoff methods remain unavailable on this account.

The fixed database route opens SQLite with `readonly` and `fileMustExist`, uses a
read transaction, and rejects recovery sidecars before opening. It authenticates
current and retired pages without collecting retired pages. Mutations refuse
before SQLite dispatch; SQLite remains a second barrier. Close releases resources
before reporting unexpected file metadata changes. This is change detection under
the existing profile-lock/trusted-OS model, not hostile-filesystem rollback protection.

The fixed completed coverage store accepts only a genuine read-only worker. Its
surface omits engine-write and host-write methods. A first restoration requires
its own fresh authenticated coverage read. Main compares that coverage's exact
checkpoint, hash and summary, and the inspected wallet state, with the completed
journal before any source RPC or viewing-key loan. The completed public snapshot
must then match the same checkpoint. No receipt or scan authority is granted by
the prerequisite read: the actual viewing utility and normal journal revalidation
must succeed. Repeated restores consume the genuine restore-receipt chain.

## Drainage and uncertain exits

The viewing runner now retains all admitted dispatch and credential work through
closure, refuses invalid or out-of-order protocol messages, and wipes late key
loans. Closing an account waits for restoration work and actual storage/utility
exit observations before releasing account ownership.

An unobserved exit produces `RAILGUN_WALLET_EXIT_UNOBSERVED`, retains account
exclusion and quarantines credential issuance for that profile/account until
application restart. The shared identity issuer revokes sibling scopes, wipes
outstanding loans, and rejects reopening the same account before vault derivation.
The independent receiver uses the same quarantine. An observed nonzero exit is
distinguished from an unobserved exit. These fault cases are unit-level evidence;
the native run below does not simulate an unknown physical child exit.

## Qualification

The [recorded manifest](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-completed-wallet-2026-10-05.json)
binds the changed source/test files, logs, policies and three native reports.
All **849 tests across 14 suites pass** in **41.197 seconds**, including storage,
coverage, journal, account, identity, receiver, runner and existing private/staging
and Kohaku consumers. `npm run lint` is clean. This refreshes the listed suites,
not the full repository regression.

The [completed-wallet native run](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-completed-wallet-native-2026-10-05.json)
passes **12 measured groups in 26,031 ms**, with **531 unchanged source hashes**.
It creates a disposable public-vector account through genuine enrollment and
public/wallet scanning, then exercises missing state, cancellation, expiry,
copied destination, wrong policy, missing/unregistered database, completed open
plus two restores, healthy reuse, a stale checkpoint and a genuine pending journal.
Every measured group preserves the entire account directory and inventory bytes
and filenames. Every measured storage start uses the read-only factory; reports
also count the fixed completed coverage factory and assert its writable surface
is absent. Admitted children and workers drain and viewing loans are wiped.

Successful open/two restores use three viewing jobs and 72 protocol RPC calls;
healthy reuse uses one viewing job and 24 calls. Held-response cancellation makes
five header calls and no viewing-key loan. A newer public checkpoint makes 13
protocol calls and refuses before the viewing utility. Per-group RPC methods are
recorded: each successful restore makes 23 `eth_getBlockByNumber` and one
`eth_getLogs` call; the stale case makes 12 and one respectively, cancellation
makes five header calls, and earlier local refusals make none. No POI service,
selected-nullifier, EOA, deployment or private-preflight
query occurs. Global totals include fixture setup: 75 children and 15 storage
workers exit, with five viewing loans including the original writable scan.

The pending case uses an actual ordinary journal prepare followed by a controlled
wallet-launch refusal; the unregistered case replays the genuine pre-wallet
inventory marker. These are explicit fixture controls, not claims of rollback
protection. Cancellation holds a simulated response and proves logical drainage,
not physical Tor/socket behavior. Byte snapshots begin after enrollment and
public-owner opening; those ordinary setup paths are not claimed to be read-only.
Reopening occurs in the same application process, not a fresh process restart.

The [Shield compatibility run](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-completed-wallet-shield-compatibility-2026-10-05.json)
and [received-Transact compatibility run](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-completed-wallet-transact-compatibility-2026-10-05.json)
pass the existing real internal partial signing/proving/reopening journey in
**22,910 / 33,010 ms**, each with **522 unchanged hashes**. Their simulated
chain/service/list trust and creator limitations remain those of the
[previous checkpoint](railgun-partial-transact-controller-2026-10-05.md).

The initial completed-wallet run failed because ordinary restore required an
in-process scan receipt. It is diagnostic only. The fix adds the distinct
authenticated cold path; it does not enable a writable bootstrap. The final run
uses a fresh profile. Claude reviewed the production changes, composition, reports
and documentation; a separate Codex reviewer also checked the read-only paged store.

## Policy and remaining work

`railgun-wallet-run` and `railgun-wallet-coverage-store` are wallet-policy inputs.
The new wallet policy is `e8cf71217fdd3de4adfb39748f9bee478d81cd812c5a151931345eb1a05de3ae`;
public `d454092c…` and TXID `03a45fd1…` policies are unchanged. Existing derived
wallet generations therefore require explicit maintenance before this opener can
use them. Recovery must not silently rebuild an old generation. No funded profile
was opened or changed. Freshly fetched main remains `dbfd0e7d`; no new node refresh
is required for this checkpoint.

Next: resume a signed, unfinished proof using the original capsule and signature,
with no new admission or spending-key loan, independently verify it, and fill only
the original proof slot. All three private kinds and both input creators need
qualification. Partial submission/capture, durable combined POI, actual change
ingestion, fresh-process restart/second spend and live private qualification remain
open. No live service acceptance or funded private spend is established here.
