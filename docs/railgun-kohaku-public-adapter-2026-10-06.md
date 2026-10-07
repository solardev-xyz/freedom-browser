# Restricted Kohaku public Shield adapter — October 6, 2026

The reusable adapter now covers public Shield preparation as well as the existing private operations. Freedom supplies a fixed host that keeps account ownership, disclosure reviews, transaction simulation, vault signing and durable submission journals in the main process. The portable adapter exposes current scanned reads, one native-asset preparation and a separate public submitter. This is wallet infrastructure; the user-facing privacy experience remains to be designed.

Source checkpoint: `deb3439481f9922f1bba44c164ac9467a4caac48`. The current integration is restricted to Sepolia, native ETH wrapped into WETH, a self recipient and an amount no greater than 10^16 wei, submitted through the transaction RPC. The fixed Freedom host enforces recipient ownership and the existing transaction policy. A foreign trusted host must supply its own authority and policy; structural compatibility alone cannot establish either. The amount ceiling is an integration restriction, not a protocol limit.

## Operations and results

While ready, the adapter returns detached balance and note projections with host-supplied provenance. Reads grant no ownership, eligibility or spending authority. It refuses preparation while admitted reads remain pending, then permits only one preparation attempt per session. A denied preparation closes that session.

Successful preparation returns an opaque public-operation token. The original object's identity is its authority: copies, private tokens, foreign tokens and replays cannot submit. The fixed host hides the genuine Freedom operation behind a separate handle, and both layers consume their mapping before delegation. The fixed host relies on the original facade lifecycle and the portable adapter's session rule; it does not add an independent general-purpose attempt policy.

An acknowledged public deposit preserves the original eight-field result, including object identity. Its value must equal the admitted gross amount. A lost response preserves the original rejected error and its known transaction hash; it does not become the private adapter's fulfilled uncertainty union. A malformed post-admission result produces a distinct adapter contract error with `submissionMayHaveOccurred: true`. None of these errors authorizes retry. With a foreign host, rejection reasons are untrusted: matching a familiar error code cannot establish whether a transaction was sent.

Closing revokes further admission and asks the host to stop. The adapter waits for admitted host work and the separate host closure barrier, without adding an abort race that could hide a successful submission or its original error. A trusted foreign host is responsible for prompt outward cancellation; otherwise admitted reads and preparation can remain pending until it settles. Cleanup failure is reported separately and cannot replace a valid original submission outcome.

Review found that native Promise observation can itself throw through a malformed constructor or species. Both public and private adapters now revoke the session and reject successful closure in that case, while retaining other observable work. Rejected closure does not establish drainage of the unobservable promise. This correction is included in this checkpoint; earlier private native reports and the earlier standalone prototype retain their original source hashes.

## Verification

Combined root checks pass 823 tests across 24 suites with natural exit, lint with zero warnings, and explicit formatting of all fifteen changed files. Public core tests cover original result/error identity, amount binding, malformed promises, copied/cross-kind tokens and independent cleanup. Eight constructor/species cases cover public preparation, reads, submission and invalid asynchronous cleanup. Nine private regressions distinguish the previous source. Claude and Codex reviewed the implementation and qualification fixtures; that engineering review is not an external security audit.

The public declaration passes one positive and 21 negative compiler programs against the actual pinned Kohaku source graph. The compatible target is a specialized Shield-only PluginInstance plus a separate public submitter. The private Broadcaster and generic Host/factory are not public submission interfaces. [Compiler evidence](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-kohaku-public-types-2026-10-06/README.md) records exact source pins, programs and diagnostic results.

These are declaration-consumer checks, not JavaScript implementation checks or a standalone package build. Typed token spreads can compile and still require runtime identity checks. The campaign does not prove that all calls through arbitrarily widened upstream types preserve the concrete adapter's restrictions.

## Native qualification

All three fresh disposable-account Electron processes pass at `0645ab59fb43f5373441fed2c06951aa7eb45ed4`; the original driver also exits 0. This checkpoint adds the corrected whole-inventory regression to the implementation at `deb34394`. The [native evidence index](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-kohaku-public-adapter-2026-10-06/INDEX.json) joins original exits, exact raw reports, source/runtime pins and completed root checks.

| Case                              | Observed result                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Acknowledged deposit              | Original eight-field result and identity preserved; amount equals the admitted gross amount; one EOA signature and send               |
| Submission response lost          | Original rejected uncertainty error and canonical transaction hash preserved; one EOA signature and send                              |
| Final review held, then cancelled | Original cancellation error reaches the caller before review release; zero EOA signatures or sends; closure retains the held callback |

Each process checks thirteen ready-state projections and mutation isolation, plus three prepared-state and three closed-state read refusals. Independent observation confirms distinct inner and outer operation tokens and exactly one genuine submission delegate/settlement. Refused reads and tokens add no measured work at their tested boundaries.

The acknowledged and lost-response cases each record 729 parent RPC requests, 734 archived public requests and 757 transport entries. Cancellation records 739, 744 and 766 respectively. These counters have different scopes and include the ordinary-wallet baseline. Utility starts/settlements are 97/97, 97/97 and 98/98; worker starts/pre-final settlements are 81/81, 81/79 and 82/82. The inherited bound allows up to two pending public workers at the pre-final snapshot; lost-response has two, the other cases none. Original exit-zero evidence follows cleanup separately. This is not physical socket drainage.

The complete selected-source maps contain 188 entries; the broader freeze covers 11,552 source files, fifteen symlinks, ten external inputs and 25 proof artifacts. These are inventories, not execution coverage. Pre-run review corrected an initial expected-map extraction that omitted twenty appended entries; that draft never ran a native child. Three positive and 92 refusal controls support the corrected report validation. The original raw report bytes are retained.

The later [loopback transport regression](railgun-private-rpc-transport-2026-10-06.md) is test-only and is not part of the native source freeze at `0645ab59`.

The campaign uses genuine wallet ownership, controllers, cryptography, vault signing and submission journals with disposable public vectors and synthetic chain/services. It does not establish live deposit finality, cold credited-note recovery through this new host, private-service eligibility, funded-account behavior or Tor anonymity. Earlier cold-credit and private campaigns retain their original source scope.

## Remaining work

The [five-factory Node prototype](railgun-kohaku-public-node-prototype-2026-10-06.md) now includes the public exports and the private observation correction, with separate build, runtime, declaration and final-package evidence. Live private-service eligibility and broadcast qualification, broader chain/asset/recipient support, platform integration and product design remain separate work. Existing simulated runs do not authorize disclosures from funded profiles or establish network anonymity.
