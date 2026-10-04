# Connected Railgun Kohaku public Shield — October 4, 2026

The main-owned Kohaku instance now connects native ETH deposits to the genuine
Railgun Shield controllers through a separate public operation and submitter.
Three offline Electron cases pass with real engine jobs, receiver verification,
deployment-check code, vault EOA signing and durable submission journals.
RPC replies are synthetic. This is not a new live deposit or product activation.

## Interface and scope

`createRailgunKohakuPlugin({ mode: 'public', ... })` adopts a genuine enrolled
account. It requires the engine archive, preparation and transaction reviewers,
and gas limits. It refuses private-prover and artifact options.
`prepareShield({ asset: { __type: 'native' }, amount }, ownInstanceId?)` accepts a
positive bigint amount, up to the existing 0.01 ETH Sepolia qualification cap,
and only the enrolled private recipient. The pinned RelayAdapt wraps ETH into
WETH and deducts the pinned 25 bps Shield fee from the note value.

Preparation returns a frozen `{ __type: 'publicOperation' }` capability.
`createRailgunKohakuPublicSubmitter(plugin).submit(operation)` consumes it once.
Copies, serialization, foreign instances, private operations and repeated use
cannot create signing authority. The private broadcaster refuses public instances.
Existing read/private modes remain separate. Public mode does not add private
note selection, source queries, POI services or private-spend proof configuration.

This follows the selected Kohaku instance/public-operation shape documented in
the [implementation plan](railgun-kohaku-public-shield-plan-2026-10-04.md). It is
not a portable generic Host implementation or renderer/IPC interface. All new
responsibilities stay in the existing main-process wallet boundary.

## Two review boundaries

The first review reads public wallet metadata through `getWalletRecord(0)`;
it never derives the funding address by borrowing the vault key. Missing usable
mnemonic metadata refuses. Index, type, address, identity and RPC configuration
are snapshotted and rechecked throughout the operation.

The immutable summary identifies the funding EOA, native amount, own recipient,
WETH, fee/net note value and both exact RPC destinations. It explicitly permits
simulation and discloses that `eth_estimateGas` and `eth_call` reveal the amount,
funding address and exact Shield calldata, including encrypted note, before
the later transaction review. First approval does not permit signing or sending.
Genuine query-free destination previews issue restrictions retained through
preparation and submission; a changed destination cannot trigger an unrestricted
fallback. The second review uses the controller's exact intent, gas, balance
and nonce checks before vault EOA signing and journal-before-send.

The outer public budget is 120 seconds from before the first review, measured
with monotonic and wall clocks. It includes waiting with a prepared token and
submission; neither a delayed timer nor a new phase renews it. Review callbacks
also have their existing 30-second bound, and the controller's own remaining
freshness can be shorter. These callbacks are technical integration contracts,
not completed UI consent flows.

## Ownership, cancellation and uncertainty

A genuine wallet handoff remains held through the original preparation-review
callback and awaited wallet closure. The facade then releases it and enters the
Shield host synchronously; the host claims recovery before launching a utility.
Contention refuses before utility work. Controllers returned after cancellation
are adopted and their closure tracked before checking currentness.

During final public transaction review the Shield workers have drained and their
shared account phases are released. The facade retains its directory exclusion,
but generic wallet/recovery entry points may proceed. This differs from private
submission's signing-recovery phase. The cancellation fixture opens a genuine
contender wallet while showing that another facade still cannot adopt it.

Cancellation can return before an uncooperative review or cleanup completes.
Original work remains tracked; `closed` settles only after confirmed logical
cleanup, and unconfirmed cleanup keeps exclusion. This does not prove physical
socket drainage. A known submission result or genuine journal-backed uncertain
outcome survives later closure. Neither uncertainty nor an expired token permits
automatic retry. An unsubmitted public token does not imply private-proof recovery.

The public instance retains its verified `instanceId` after handing off its wallet.
Balance/note reads require reopening an account. Denying the first review closes
the adopted public instance; callers must explicitly reopen before another attempt.

## Qualification and its limits

The focused plugin/private-broadcaster/public-submitter group passes **162 tests
in three suites**. Claude and an independent Codex reviewer found no blocking
source issues. Claude's suggested import-order checks were added before execution.

| Offline case                                                                             | Public-flow time | EOA signatures | Simulated sends |
| ---------------------------------------------------------------------------------------- | ---------------: | -------------: | --------------: |
| [Acknowledged](qualification/railgun-kohaku-public-acknowledged-2026-10-04.json)         |         1,839 ms |              1 |               1 |
| [Lost response](qualification/railgun-kohaku-public-lost-response-2026-10-04.json)       |         1,854 ms |              1 |               1 |
| [Review cancelled](qualification/railgun-kohaku-public-review-cancelled-2026-10-04.json) |         2,149 ms |              0 |               0 |

Each is a fresh Electron process and disposable public-vector profile; each also
passes the existing 19 enrolled wallet/recovery cases. All three reports contain
169 matching source hashes, an inventory rather than execution coverage. Each
public flow performs two actual Shield utility jobs and one viewing-credential
callback, whose borrowed buffers are wiped. Before each main flow, denial proves
no new key/RPC/signer admission, and held first-review cancellation proves that
a direct recovery claim stays busy even after the adopted wallet drains. There is no private spending key,
POI traffic or added retained-source query for the public operation. Baseline
address derivation and account setup/reopens are outside that admission claim.

Both RPC roles are intercepted before client modules load. Real pinned public
bytecodes feed the actual preflight checker, but headers, slots, getters, balances
and transaction responses are synthetic. Each final review follows exactly one
estimate and call. In acknowledged/lost-response cases, exact simulated, reviewed, signed and
journaled intents agree.
The lost-response case preserves attempted state and refuses another submission;
the acknowledged case preserves submitted state. Both refuse another submission
until resolution and reopen the journal under a fresh context. Cancellation waits for the original callback without signing or
sending, and late approval adds no observed wrapper entries.

The native foreign-token control uses a consumed token from a previous genuine
instance; an unconsumed foreign token is covered by unit tests. The report does
not claim observation of rejected calls below the instrumented wrappers, cold
transaction resolution, new-note ingestion, physical Tor, mined chain evidence
or live service eligibility. Lower-level Shield recovery has its separate
[prerequisite qualification](railgun-shield-prerequisites-2026-10-04.md).

The inherited top-level `submissions: 0` is a legacy baseline field, not the
public simulated-send total. Top-level `requests` counts wallet/archive work,
including account reopens; it is not a pre-public-operation snapshot. Public-flow simulated sends and counters are under
`kohakuQualification`; its archived-request total includes setup/reopen traffic,
including the cancellation contender. It does not mean Shield itself queried
retained note history.

[Five fresh private compatibility runs](qualification/railgun-kohaku-public-private-compatibility-2026-10-04.json)
also pass: Shield transfer with lost acknowledgment (4,554 ms), Shield full
unshield (4,067 ms), received-Transact transfer (8,061 ms), received-Transact full
unshield with lost acknowledgment (7,914 ms), and held private transaction-review
cancellation (3,593 ms). Each passes 19 baseline cases with 133 matching source
hashes. Genuine proofs, independent verification, vault signatures and controller
journals execute; private POI/preflight authority and RPC remain simulated.
The four sending cases each make one private signature, one EOA signature and
one simulated send. Cancellation retains the private signature/capsule for
recovery with no EOA signature or send. The compact report retains all five
Kohaku result objects and the shared source inventory; repeated baseline rows
are omitted there, and each byte-identical full original is committed alongside
the aggregate and identified by its relative filename and SHA-256.

The [full frozen-tree regression](qualification/railgun-kohaku-public-regression-2026-10-04.json)
passes **13,736 tests / 33 skipped**, with **502 passing suites / five skipped**,
in **521.36 seconds**. All 1,494 source/test/configuration hashes remain identical
before and after. The command retains the existing `openlv-protocol.test.js`
exclusion and explicit `--forceExit`; it does not establish natural application
handle drainage. Full lint passes. Current main
`3b4f62df` remains merged; the fresh fetch found no newer main commit. Dependencies,
runtime archives, policies and deployment pins are unchanged by this slice.

## Remaining parity work

Next implement [partial WETH withdrawal with authenticated change and a second
spend](railgun-partial-unshield-plan-2026-10-04.md). Live private eligibility,
disclosure and end-to-end qualification remain open, as do restricted Host
extraction, UI/UX, activation and production release checks. No funded profile,
owned-note service query or live submission was opened by this milestone.
