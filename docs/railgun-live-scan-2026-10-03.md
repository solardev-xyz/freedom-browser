# Railgun enrolled live scan, 2026-10-03

The existing disposable Railgun Sepolia profile completed its live public scan
through block **11,832,799** and then scanned the enrolled wallet through the
same checkpoint. The final continuation acquired 86 ranges from 10,120,000,
using the retained authenticated checkpoints from the earlier runs. Source
hashes remained unchanged throughout this continuation, at commit `2a91a685`.

The final public state contains 10,242 commitments, 5,634 nullifiers and 2,549
unshield events. Its UTXO root is
`0x090d851b9be3f06c5288c3196cd4eabcf392a73ffeebfcd6298d19b50cb2c6d3`.
The harness compared this root with the contract's `merkleRoot()` using an
EIP-1898 `eth_call` at block hash
`0x49d0b93f21f94b98746a29d3bc1f99048ec9805757f3c1191372c0d2e4a34191`.
They matched. Both event acquisition and this final contract read used the
same Sentio RPC through managed Tor: this is **single-provider consistency**,
not independent chain verification or a proof of complete RPC history.

The wallet view reported `wallet-scanned-unverified`, zero assets and
`poi: unverified`. Zero assets are expected for this separate, unfunded
Railgun test account. Signing and submission were disabled; no funds moved.
Tor circuit isolation remains unqualified.

This was a resumed qualification, not an uninterrupted first attempt. The
[cancellation report](railgun-tor-drain-2026-10-03.md) records the interrupted
run at block 9,959,999 and the subsequent failed partial continuation through
10,119,999. The final successful continuation preserves those failures as
part of the evidence. Its [machine-readable report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-live-scan-2026-10-03.json)
records the ranges, source hashes, public state and wallet result.

TXID membership, independent TXID/event comparison, account POI and funded
shield/transfer/unshield are separate qualifications. This result grants no
spendability and does not resolve the known TXID service omission.
