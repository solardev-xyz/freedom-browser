# Railgun native shield preparation — 2026-10-03

The enrolled Sepolia account can prepare a native-ETH shield through the pinned
RelayAdapt contract and verify, before signing, that its viewing key decrypts
the resulting note. This slice does not sign or submit a transaction. It does
not yet qualify scanning a mined deposit, spending it, or recovery on another
device.

The implementation stays in the existing main-process wallet boundary. A
network-denied utility process constructs the note using the pinned Railgun
engine; main independently decodes and validates the calldata. A separate
utility job receives one copy of the enrolled viewing key and reconstructs the
recipient, note public key and fee-adjusted commitment. This keeps SDK work out
of the renderer and gives it no signing or broadcast authority.

## Constraints and verification

- Sepolia only, one native shield per transaction, at most 0.01 ETH.
- Canonical RelayAdapt multicall: require success, exactly `wrapBase(amount)`
  followed by one shield, both self-calls with zero inner ETH. Outer ETH and
  the shield amount must equal the same positive amount. Zero/all-balance
  behavior and extra calls are refused.
- The encrypted note belongs to the enrolled recipient. Random note and
  encryption keys are generated for each preparation; no sender EOA signature
  is used as the encryption key. Recovery relies on recipient scanning, not
  sender-signature-derived shield history.
- Main accepts the guarded engine result only with the pinned runtime inventory
  and zero egress attempts. Receipts bind the exact identity, enrollment and
  preparation; a new preparation, expiry or vault lock invalidates them.
- The viewing-key reply owns exactly its 32-byte backing allocation. The
  supervisor transfers it once and wipes it. The utility wipes key buffers
  where possible; decrypted strings and internally derived values are bounded
  by process exit, not claimed to be securely erased from JavaScript memory.
- The Tor preflight checks runtime code hashes for proxy, implementation,
  RelayAdapt and WETH; proxy implementation/pause slots; RelayAdapt getters;
  25 bps shield fee; and WETH blocklist status, all at one EIP-1898 block hash.
  A final header reread must agree. Acquisition and receipt share a 60-second
  monotonic lifetime. The header must be at least block 11,833,631, no more than
  120 seconds old and no more than 30 seconds ahead of local time.
- These are RPC consistency checks, not authenticated chain state. The block
  floor comes from the reviewed deployment observation, not a consensus proof.
  Governance can change after preflight and before inclusion. The original
  deployment build has not been reproduced from Solidity compiler settings.

## Qualification evidence

[Offline engine report](qualification/railgun-shield-build-2026-10-03.json):
two real guarded builds produce distinct note keys and calldata. Independent
engine decryption reproduces each note and net commitment; a wrong viewing key
is refused. Zero amount and invalid recipient are refused. No account opened,
network request or submission occurs in this qualification.

[Enrolled account report](qualification/railgun-shield-account-2026-10-03.json):
two preparations in a disposable, known public-vector vault, with a cold reopen
between them. Both pass enrolled viewing-key recovery and fresh deployment
checks over Tor. The recipient stays the same, notes differ, and locking the
vault invalidates preparation, receiver and deployment receipts. This qualification never funds the account; its keys are public. The transport uses the existing qualification-only
Arti endpoint shim; this is not production Tor-manager or circuit-isolation
qualification.

The successful account report is run `d`. Earlier `a` stopped during its second
deployment check with an undifferentiated refusal; `b` passed preparation and
deployment before enrolled receiver checks were added. Run `c` completed both
receiver checks but its second deployment acquisition failed at the initial
RPC read (chain-ID check or latest header), classified `rpc`. Run `d` reopened a fresh transport and passed.
Two of these four account runs failed; the underlying transport cause has not
yet been established. Failed observations are retained locally, not represented
as successful runs.
The successful offline report is run `b`, repeated after the pin and supervisor
changes; source hashes in both published reports bind the files actually run.

Validation: 110 focused tests and 8,223 native regression tests pass (33 skipped);
`npm run lint` passes. The native run excludes the separately configured OpenLV
protocol suite.

## Next transaction boundary

Signing must require genuine preparation, receiver and fresh deployment
receipts. The funding EOA uses its own public-address transaction context;
private account scan, TXID and POI traffic must not share that context. Before
broadcast, persist the transaction hash, nonce and calldata-derived shield
intent in the existing encrypted submission journal. Do not store signed raw
bytes, retry uncertain submissions automatically, or use a new nonce while an
earlier one is unresolved.

Reconciliation must match a mined Shield by transaction hash and note public
key and use its actual value. A governance fee change can alter the resulting
commitment without making the note foreign; record that deviation explicitly.
A successful receipt without the expected Shield is not a completed deposit.
The next funded steps remain shield, authenticated scan/recovery, owned-note
TXID and POI evidence, local transfer/unshield proofs, and post-transaction
inclusion checks.
