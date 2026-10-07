# Railgun funded qualification — October 3, 2026

The dedicated disposable Railgun account now holds 0.01 Sepolia ETH transferred
from the existing PPv2 qualification account. The first 0.001 ETH shield was subsequently acknowledged by the RPC;
its receipt matches the prepared note and the subsequent wallet scan recovers
one asset at the finalized checkpoint (the expected Shield note).
The PPv2 vault and prior protocol history remain intact. Its October 1 balance
is historical; this transfer spends 0.01 ETH plus gas from that balance.
The transfer publicly links the PPv2 test EOA to the Railgun funding EOA.
Shielding also exposes the funding EOA, amount and time; the recipient note
contents remain encrypted.

## Funding evidence

[The send report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-funding-send-2026-10-03.json) records one
broadcast attempt over the qualification Tor transport. The transaction is
`0x431f109703f7c100c54c3c17c59897f718243d69dabe6312e34e2b544cfd67d9`,
from `0x6d7d00e435919ead9845f25e2c2f85b969d2c331` to the dedicated vault-derived
Railgun funding EOA `0xc08016f92e3bcee92e8d723eec9af1ac19b1dc6e`.

[The finality report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-funding-finality-2026-10-03.json)
records inclusion in block 11,834,322 and explicit resolution at 75 confirmations,
after the RPC's finalized height covered inclusion. Earlier observations at
7, 52 and 62 confirmations correctly left it unresolved. This is unverified
single-provider (Sentio) RPC evidence, not an independent consensus proof.

The sender is the actual vault-backed ordinary signer. The harness pins the
destination report by SHA-256, enforces a separate disposable destination,
fixed 0.01 ETH amount, empty calldata, legacy 21,000 gas, undelegated EOAs and
equal latest/pending nonces. It doubles the gas-price quote within a 0.0005 ETH
maximum gas-cost budget. Before bytes reach transport, the ordinary submission
journal records the hash and nonce. A separate non-secret unsigned transfer
plan is fsynced before that handoff. Explicit identical-hash rebroadcast can
reproduce the original signed transaction; no new nonce or journal entry is
created. Its deterministic re-signing and plan checks are unit-tested; the harness
rebroadcast mode itself was not exercised because the live send was acknowledged. No raw signed bytes or private keys are written to reports.

The account-report file contains a local profile path and remains local. The
published funding reports contain public test addresses and transaction facts.
The send report retains an unusable `undefined/tx/...` explorer URL because
the custom qualification chain has no explorer base; the transaction hash is valid.
Fourteen transfer-plan tests and lint pass. Claude reviewed the destination,
signing, journal, replay and finality gates. The latest main-wallet regression
before these qualification scripts was 8,287 passed / 33 skipped.

## First live shield

The live controller requires an existing enrolled profile, the pinned finalized
funding report and a pinned, completed, source-matched public/TXID/wallet scan.
It cold-restores the exact public generation and empty wallet before preparing
one 0.001 ETH shield. It caps gas at 1,100,000 and maximum gas cost at 0.002 ETH.
The main-owned operation independently simulates the transaction and checks
its recipient, current deployment, nonce, balance and reviewed bytes.

The first two check runs stopped before signing at the original 750,000 gas
cap; the second measured 877,565 gas. The controller limit was raised to
1,100,000 (about 25% headroom) while keeping the 0.002 ETH maximum gas cost.
[Check run `c`](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-shield-live-check-2026-10-03.json) passed
with an 882,668 gas estimate, 939,609,142 wei gas price and the expected 0.01 ETH
balance. Check mode performs a live funded simulation without signing. Shield mode
permits at most one journaled shield attempt across active and archived journal records;
an uncertain attempt requires observation, not an automatic resend. Recovery
works after restart through the dedicated shield matcher and finalized review.
[The actual send report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-shield-live-send-2026-10-03.json)
records acknowledged transaction
`0x5b935d5592e32807135e39d3770a5cd6e40343c682454d83c472dba8d17cda57`,
nonce 0, with 7.955 seconds of preparation and 8.736 seconds in submission.
It used the genuine vault signer and live Tor through the qualification Arti
endpoint shim. Expected note value is
0.0009975 WETH after the 0.0000025 WETH protocol fee. A subsequent local, unpublished recovery run observed inclusion at block 11,834,494 with ten
confirmations and matched the exact Shield at tree 0, position 10,245. Net value
and fee matched with no deviation. [Finality run `d`](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-shield-live-finality-2026-10-03.json)
subsequently resolved the matched outcome at 97 confirmations, with the
finalized checkpoint at block 11,834,513.
[The subsequent wallet scan](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-shield-wallet-recovery-2026-10-03.json)
advanced the same public generation to that checkpoint, reconstructed 10,246
commitments and recovered one asset. The report records the aggregate asset count;
it does not report the token, amount or wallet generation ID. Nullifier and
unshield totals were unchanged. All 4,230 mirrored TXID rows still matched
public events with the known omission retained. Live owned-note POI remains
the next check; these observations do not authorize spending.
The legacy `broadcastSource: direct` field identifies the selected RPC route,
not a Tor bypass; the qualification transport metadata describes the actual
HTTP/TLS-over-Arti path. See [the signing/recovery design](railgun-shield-submission-2026-10-03.md).

The transport here uses a dedicated bundled Arti process through a qualification
endpoint shim. This does not qualify production Tor-manager ownership or
per-account circuit isolation. Owned-note POI and TXID provenance, operation-bound
private proofs/signing, transfer, unshield and output recovery remain required
to reach the funded PPv2 milestone. No product UI or production activation is
part of this qualification.
