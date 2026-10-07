# Local Shield-origin recovery qualification — October 5, 2026

At `233cac0105be642f3d6185f6774429b1a7b02b61`, all fifteen fresh native
processes pass on Electron 44.5.1. The new diagnostic can join an already-open
genuine Railgun account to its authenticated local deposit journal after a
restart, while refusing stale or substituted inputs. It remains internal and
has no production caller. This is local recovery evidence, not permission to
spend or a live-service qualification.

## Implementation

The [existing-only reader](railgun-existing-journal-reader-2026-10-05.md)
authenticates a registered encrypted EOA journal without creating, adopting or
repairing storage. Its detached result is deeply frozen. The shared encrypted
storage path also wipes temporary plaintext when authentication fails.

The [main-only diagnostic](railgun-shield-origin-diagnostic-2026-10-05.md)
authenticates genuine account and owner handles, captures the selected note,
view, checkpoint and generations, reads the existing journal twice, and
rechecks those bindings before returning. Cancellation, owner closure and a
fixed acceptance deadline refuse the operation while retaining admitted work
until it settles. Borrowed owners remain usable.

A match authenticates only the local account snapshot source and encrypted
journal relationship. Supplied transaction and receipt hints remain supplied
data: ownership, canonicality, spending and POI-bypass flags stay false. This
does not prove cryptographic note ownership, recipient, provider provenance,
chain finality, eligibility or continuing authority. The reader derives a local
journal storage key; the diagnostic issues no additional Railgun key loan.

## Native results

The [index](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-shield-origin-2026-10-05.json) links all fifteen
byte-exact reports. The [audit](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-shield-origin-audit-2026-10-05.md)
lists actual PIDs, per-case work and resource limits.

- Nine adapter/ordinary-wallet compatibility cases preserve Shield and received
  Transact transfer/unshield, lost acknowledgment, review cancellation, public
  deposits and ordinary-wallet behavior. They retain 924 checked adapter reads.
- Two separate three-process sequences cover acknowledged and lost-response
  public deposit, receipt resolution with normal scanner credit, and completed
  restore. Each sequence sends once in setup and credits the selected net-WETH
  note; later processes do not resend.
- In each of four resolve/restore phases, the genuine host matches, refuses a
  stale checkpoint, refuses a shallow copy of the actual account, refuses a
  changed sender, refuses a pre-aborted call, and matches again. The total is
  **24 calls: eight matches and sixteen refusals**.
- At those measured diagnostic boundaries, RPC, jobs, workers, signing and
  Railgun-key counters do not increase. Wallet-generation and selected encrypted
  profile files remain byte-identical. This is not a whole-browser-profile
  immutability claim or an instrumented journal-read-count assertion.

All fifteen child exits and the original driver exit were observed as zero.
The exporter completed separately and checked exact report shapes, source maps,
hashes and final driver observations. Contract counters are snapshots before
final cleanup and allow only the reviewed zero-to-two pending worker bound;
exit-zero additionally requires the fixture's final cleanup/sticky gate. This
does not prove physical socket drainage.

The chain, receipt and external service inputs are synthetic. Legacy private
contract cases retain simulated POI/preflight authority seams. Scanner credit
does not establish spendability. No funded profile or live owned-note service
lookup was used for this campaign.

## Regression and source identity

The frozen root source passes **16,986 tests / 33 skipped**, in 572 passing and
five skipped suites, in 684.222 seconds. The runner exits naturally without
force-exit. The existing OpenLV exclusion is checked separately: six tests pass
in 0.488 seconds under experimental VM modules. All 513 focused wallet/fixture
tests across thirteen suites pass in 15.216 seconds, also with natural exit.
Full lint passes; formatting of the thirteen changed source/test files passes. Repository tests include public Safe RPC/local
Anvil and disposable real Ant integration; they are not entirely offline.

The [source record](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-shield-origin-source-hashes-2026-10-05.json)
distinguishes the 5,561-file selected union (179 contract; 5,551 cold) from the
11,524-file outer inventory with fifteen source symlinks. These are inventories,
not execution coverage. Ten external inputs and twenty-five inherited prover
artifacts are pinned. The successful launcher rechecks their bytes; the exporter
independently rehashes source and checks runtime maps without reading runtime
payloads. Log hashes, test-exit observation flags and the original driver handle are
retained in the index. Main `e98e2dd5` and the [explicit node/runtime refresh](privacy-main-sync-e98e2dd5-2026-10-05.md)
precede the campaign. Electron is 44.5.1 throughout.

Fresh disposable profiles create new generations under source-derived policy.
Reports do not record a wallet-policy digest or qualify legacy-generation
reopening. Earlier campaigns retain their original source/runtime scope. The
reader's earlier scratch regression is superseded for this milestone by the
stable-runtime root regression above.

## Remaining work

Next is a restricted read-dispatch extraction toward portable Kohaku Host
compatibility, preserving genuine owner checks and promise settlement behavior.
Generic Host injection, upstream TypeScript conformance and a standalone adapter
package are not established by this milestone. Live Railgun private/service and
broadcaster qualification still require the separately reviewed disclosure
approval. Broader platform/egress checks and product/UI design remain open.
Production privacy activation stays disabled. See the
[parity plan](railgun-parity-plan-2026-10-04.md) and
[full roadmap](../research/privacy-roadmap.md).

Claude and Codex reviewed the implementation, fixtures, exported evidence and
publication wording. This engineering review is not an external security audit.
