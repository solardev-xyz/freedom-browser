# Railgun POI reads and local membership, 2026-10-03

The main process can now acquire POI evidence for a fixed set of up to three
blinded notes and verify their Merkle paths in the guarded Electron engine.
This is the transport and verification layer for subsequent account POI work;
it does not yet derive the notes from an enrolled wallet or authorize spending.

The source accepts a private-account context for Sepolia, role `poi`, and a
specific operation digest. A separate scope gives it its own Tor isolation
token and binds it to the current endpoint and account lifetime. Requests go
only to `https://ppoi.fdi.network`, with fixed chain/version parameters and the
reviewed required list
`efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88`.
This list is pinned from [shared-models b37e643e](https://github.com/Railgun-Community/shared-models/blob/b37e643ef38e3df554deffa33f40530b20ce9065/src/models/proof-of-innocence.ts);
advertised optional lists do not change the policy. The initial implementation
supports one depth-16 list tree and at most three inputs, matching the qualified
POI circuit. Larger trees and operation shapes need separate work.

The reader requests statuses, proofs for all-valid notes, one signed event per
proof index, and finally acceptance of the proof roots. Responses have exact
schemas and a 32 KiB bound; requests are sequential and any failure closes the
source. A negative status or root answer stays negative. The source exposes no
submission API and accepts no caller-selected URL, method or list key.

Every signed event must match its note's blinded commitment, type and proof
index. Node's built-in Ed25519 verifier checks the exact UTF-8 serialization of
`{index, blindedCommitment, type}` under the pinned list key. The encoding follows
[the pinned node source](https://github.com/Railgun-Community/private-proof-of-innocence/blob/4b1eaf6ef19099dbfd6b43b1ca78d2ce0132a752/packages/node/src/util/ed25519.ts).
The signature does not bind a chain or root and therefore cannot independently
establish network provenance. The returned historical `validatedMerkleroot` is
an unsigned service assertion. Neither signature nor advisory status alone
establishes current eligibility. Fresh root acceptance means the service currently
accepts that root; it does not prove it is the latest root or independently
establish the absence of later removals or blocks.

Local membership requires a genuine registered source receipt, all-valid
statuses and positive root acceptance. A separate utility resolves and verifies
the pinned engine archive, then recomputes each 16-level Poseidon path with the
specified leaf and index. It receives no vault material, storage, network or
signing capability. Main checks the exact result, engine inventory and zero
guard attempts, and waits for utility exit before issuing an opaque membership
receipt. That receipt remains tied to its originating service receipt: a refresh,
scope closure, endpoint change, or the 60-second lifetime invalidates it.

The [actual qualification report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-poi-read-2026-10-03.json)
passes using the public Sepolia event at index zero. The initial signed-event
fixture was captured through direct public HTTPS with no account information.
The qualifier reacquires the proof, signed event and root acceptance over Tor,
then runs the real Electron engine. Service acquisition took 3,002 ms and local
membership verification 204 ms in this run. Separate real-utility cases reject a
changed sibling, a changed in-range position and an out-of-range index. Forged
and closed receipts are refused.

The qualifier uses dedicated bundled Arti with an endpoint shim and a synthetic
account context for that public note. It does not qualify Electron Tor-manager
ownership, enrolled account POI or actual circuit isolation. No funds moved.
The 48 focused tests additionally exercise exact signature bytes, wrong event
type/index/commitment, empty/duplicate events, malformed replies, stale and
foreign receipts, account revocation, and waiting for utility exit after failure.
Full native regression passes **8,149 tests, 33 skipped**, across 394 passing
suites; lint passes. Claude reviewed the code, tests and qualification cases.

The remaining account step must derive blinded commitments from authenticated
local wallet notes, bind them to the current Sepolia public snapshot and unspent
state, and require checked TXID membership for transact-created notes. It must
consume fresh POI receipts as part of an operation-bound proof/signing journal.
The POI node still sees queried blinded commitments and their grouping; this is
Tor transport, not PIR. Required-list policy, service availability, recovery,
post-transaction POI submission, and a broadcaster path remain explicit concerns.
All new modules live in main-owned wallet infrastructure without changing public
or wallet cache policies, package boundaries, renderer APIs or dependencies.
