# Account-bound Railgun POI preflight — October 4, 2026

`preflightRailgunOwnPoi` adds a fixed main-only path to the existing phased
own-transaction check. It derives the capsule and record from genuine account
recovery, observes the exact chain receipt, opens the existing TXID checkpoint,
verifies the path in a fresh keyless process, then acquires the combined creator
and own-transaction source receipt. Source acquisition stays late so its freshness
budget covers final root validation and account recapture. The combined receipt
is asserted again after recapture; no second source snapshot invalidates it.

The result supplies frozen private `poiPreparation` data: the normalized creator,
exact own evidence (capsule, final journal record, observed transaction/receipt and
verified TXID row), state and witness. It also classifies the creator's block as
before or at/after the POI launch block. Classification does not choose real or
dummy membership proofs. Descriptor, viewing credential, artifacts, list proofs
and controlled proof execution remain separate work.

This is detached evidence, with every overall authority flag false and explicit
`disclosureEnabled: false`. No source/root receipt survives the call. A newly
introduced archival anchor remains identified as unchecked, as in the existing
preflight; later authorization must handle that condition. There is no ongoing
journal writer exclusion. Transact creators can be extracted and classified, but
at this qualification checkpoint, post-transaction reconstruction accepted only
Shield inputs. [The later received-note extension](railgun-poi-transact-reconstruction-2026-10-04.md)
qualifies Transact reconstruction and cryptography separately. These structural
preflight fixtures do not qualify joined account/Transact-proof composition.

The existing plain witness and own-transaction preflight exports retain their
behavior and cannot enter POI mode through extra arguments or option properties.
No dependency, policy, key-release, renderer/IPC or top-level responsibility changed.

## Evidence

The new [transfer](qualification/railgun-poi-preflight-transfer-2026-10-04.json) and
[unshield](qualification/railgun-poi-preflight-unshield-2026-10-04.json) native runs
pass ten scenarios each, taking 15,307 ms and 15,127 ms with 153 matching source
hashes. They use real enrollment, encrypted reservation/capsule/journal storage,
keyless TXID verification and combined source capture. In-memory assertions compare
the entire preparation with the recaptured account and source observations. The
preparation-shape, classification and disclosure checks are assertions in the hashed
qualifier; the report entries retain the existing redacted scenario fields.

Both existing preflight exports were also requalified after the shared function
changed: [transfer](qualification/railgun-own-preflight-transfer-2026-10-04-poi-regression.json)
takes 14,928 ms and [unshield](qualification/railgun-own-preflight-unshield-2026-10-04-poi-regression.json)
14,802 ms. Each passes ten scenarios with 146 matching source hashes. These cover
active/archived recovery, store reopening, wrong selector, root refusal, archive
finality lag and unresolved journal conflicts. No live RPC or POI requests occur.

The new fixtures use legacy Shield creators at block 290 and structural note
ciphertext/signatures. They qualify account/source composition, not Shield
note-hash verification, decryption, membership selection or POI proving. Actual
POI cryptography was qualified separately with synthetic inputs; a joined real-
cryptography account/proof fixture remains future work. Reports omit the private
preparation, creator and witness data.

Claude approved production/native evidence and Codex approved tests and all four
reports. 118 focused tests across five suites pass, covering genuine capsule forwarding,
fixed-export isolation, launch-block boundary classification, late source freshness,
source/root refusal and capsule drift. Lint is clean. The merged 9,669-test full
regression predates this shared-function extension.

Next: controlled viewing-only proof/key handoff with current membership and final
account/source/root checks and Transact creating-transaction provenance composition;
then the disclosure controller and funded private qualification. The pending live
owned-note disclosure authorization is unchanged.
