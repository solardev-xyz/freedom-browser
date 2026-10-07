# Vault-bound Railgun identity and viewing scans — October 3, 2026

Railgun now has a main-owned identity derived from the unlocked Freedom vault,
and its wallet runner reconstructs that identity before scanning. The engine runs
from an independently authenticated archive. This closes the earlier read-layer
address-binding gap: wallet ID and 0zk address are checked against vault-derived
identity, not accepted only because a scanner returned them.

This is development infrastructure. Qualification uses a fresh disposable vault
with an explicitly public mnemonic, synthetic history and test-owned encrypted
storage keys. It does not open the funded Sepolia profile, establish production
account storage/enrollment, call a POI service or submit a Railgun transaction.

## Key flow and lifetime

`openRailgunIdentity` reuses the existing profile/unlock privacy session and
restricted account derivation paths. One dedicated utility requests the spending
key solely to derive public coordinates. It offers no signing, arbitrary digest,
scan, database or network operation. After observed exit, a separate utility gets
only the viewing key and public spending coordinates. It constructs a view-only
wallet and returns its public descriptor. The shareable viewing key is secret;
it remains inside that second process and is never reported.

Issued identities are registered in a WeakMap. They are immutable and bound to
profile, account index and vault session. Clones cannot authenticate. A lock,
profile change or explicit close revokes them. The per-account owner is retained
until any running utility has actually exited. Initialization refusals close the
new scope. Viewing-key callbacks wipe their borrowed key on abort and completion.

The host byte derivation API returns a dedicated 32-byte buffer. Spending keys
never enter startup JSON, hex strings in the broker, or a wallet scan process.
A narrow binary response path allows one key only for two exact runtime entries:
identity derivation with its keystore-purpose scope, and wallet scanning with an
engine `wallet-viewing` scope. The latter can request only a viewing key. Ordinary
engine, planner and proof entries cannot opt into the key channel.

Both supervisor and child require offset zero, a 32-byte view and a 32-byte
ArrayBuffer backing store. A small view over Node's larger shared Buffer pool is
refused. Electron's MessagePortMain transfers ports rather than ArrayBuffers, so
this uses structured clone with explicit owned-buffer wiping, not a claimed
zero-copy transfer. The supervisor wipes successful, refused and late replies;
the wallet broker also wipes an allocated copy if revocation prevents handoff.
The child wipes its received buffer in finally. Electron serialization copies,
SDK-internal copies and process memory are not fully erasable by this code; there
is no claim of perfect memory wiping or an OS sandbox.

## Account-bound scans

`createRailgunAccountRunner` requires a genuine current identity and authenticates
the packed engine. `runRailgunWalletSnapshot` requires matching profile, principal,
protocol, deployment, chain and wallet ID, then grants only the current public
snapshot and that wallet's derived-store prefixes. The separate scanner receives
one viewing key and the public descriptor, reconstructs its shareable-key-derived
wallet ID and address, and requires both to match before any wallet scan.
Main checks the address again after observed exit. Every later receipt-backed
Kohaku read rechecks identity currency as well as journal/snapshot/cache evidence.

The shared scan, encrypted coverage, wallet journal and generation catalog remain
in use. Balances stay `unverified`; POI and spending are not granted. No renderer
or IPC access was added. Normal-profile account initialization, storage-key and
profile-inventory composition, live source acquisition, TXID/POI/relay services,
checked signing and funded transaction recovery remain ahead.

## Engine container

`build-railgun-engine.js` copies the exact approved engine 9.6.0 fixture and its
locked dependency inventory, excluding only the previously excluded npm
bookkeeping and executable links. It authenticates original and copied files.
No dependency is installed, upgraded or transformed. Two separate builds produce
identical 81,790,332-byte archives with SHA-256:

`019f10880abf1c448aee02ec77c5c2d68c3561c7b4eef02095d66bb5fecd6a7a`

The loader hashes the entire real container before import, refuses symbolic-link
archives and unpacked siblings, and checks file identity/stability as with the
prover loader. Local application/OS trust and verify-to-require race limitations
remain. The archive includes 10,060 dependency files, packaged native binaries
and WASM. A native-load probe found the optional ws 8 bufferutil addon. The bootstrap
now selects ws 8's supported JavaScript fallbacks with two fixed environment
flags and refuses normal `process.dlopen` calls. Real identity, wallet scan and
proof jobs pass with that hook canaried and zero attempts. Wallet and proof
reports retain the guard records; for identity this is enforced by the runner
assertions, with the report binding that runner and guard source. The older
eth-lib ws 3 copy lacks these flags; no native load attempt occurs from it on
the qualified paths. No Node addon is
loaded on those qualified paths. The archive still ships native binaries; the
JS guards do not constrain malicious code or direct filesystem access. Electron
may extract a native file before calling `dlopen`; the refusal blocks loading,
not every possible extraction. Existing dependency advisories, mixed licenses and distribution
review remain unresolved; `productionDistributionApproved` is false.

## Qualification

- Real vault import/unlock with public test keys, two account indices, duplicate
  enrollment refusal, clone refusal, callback-buffer wiping, vault lock and
  identical identity after unlock/reopen.
- Actual spending-key handoff interruption: lock before delivery, observed utility
  exit, produced key copy zeroed, then the same account index opens successfully.
- Eight actual account scan/restore/rebuild windows: independently engine-derived
  synthetic source identity matches the vault-derived wallet ID and address.
  Kohaku observed balances follow 3,000 → 2,000 → 2,700 fixture units. Cold restores
  reproduce them; stale reads and forged receipts are refused.
- Existing thirteen wallet interruption/recovery cases and all six transaction/POI
  proof jobs pass after the shared bootstrap changes.
- Full native regression: 7,808 passed / 33 skipped across 371 passing suites.
  Focused identity, key, process, loader, wallet-runner and broker tests pass.

The viewing-handoff interruption also passes: the key copy is produced, the
vault locks before handoff, the supervisor refuses delivery and wipes its copy.
The coordinator reports `RAILGUN_SCAN_COORDINATOR_REFUSED`; the test separately
waits for observed process exit (`RAILGUN_SESSION_REVOKED`), checks the vault and
identity are revoked, and observes exactly one broker message (the key request).
No storage request or result follows. This does not claim visibility into all
transient IPC memory.

Reports are byte-identical copies of the successful runs, with every recorded
source SHA-256 checked against this slice before copying:

- [Vault identity and spending-key interruption](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-vault-identity-2026-10-03.json).
- [Eight account scan windows and viewing-key interruption](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-vault-wallet-2026-10-03.json).
- [Thirteen wallet recovery cases](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-vault-wallet-recovery-2026-10-03.json).
- [Six proof regression jobs](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-vault-proof-regression-2026-10-03.json).

The guard addition passes 75 focused tests; lint passes. The final native
regression passes 7,808 tests / 33 skipped across 371 suites after the native-loader
restriction. Earlier reports
remain historical evidence for their recorded source hashes, including older
Electron fixture jobs whose empty-environment assertion now permits exactly the
two fixed fallback flags. The independent non-Electron coordinated fixture has
its own environment-clearing entry and remains unchanged.

Claude reviewed identity binding, binary handoff, cancellation and native-load
handling. This is engineering review, not a security audit. Reports contain
public fixtures only; no real wallet keys or transactions are included.

Prior packaging commit `302db90e` passed CI. Earlier read commit `069c7ca0`
failed macOS onboarding at a 30-second `page.check` timeout; that earlier run
is not treated as passing or assigned a cause without further diagnosis.
