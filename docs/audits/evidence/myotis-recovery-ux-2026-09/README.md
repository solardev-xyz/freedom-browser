# Recovery failure UX — 2026-09-16

This follow-up closes the actionable UX gaps found before review of Freedom PR #353.
Official Myotis v0.1.10 / ABI 26, checkpoint quorum, and mandatory Colibri verification
are unchanged. The changes live in the existing manager/store and renderer modules;
privileged repair/help requests use the browser preload and validate the real chrome
main frame. No package boundaries or dependencies changed.

## User-visible behavior

| Situation | Explanation and action |
| --- | --- |
| Recovery still in progress after one minute | Quiet dismissible notice: still trying automatically. Open Nodes shows progress. It clears on success or stop; dismissing progress does not suppress a later failure. |
| Disk full, permissions, read-only storage or I/O error | Check disk space and folder permissions, then **Retry sync**; **Get help** if needed. |
| Inconsistent local checkpoint metadata or native anchor mismatch | **Repair sync data** with a native confirmation. Old generations and a byte-for-byte pointer backup are kept; wallets/settings are untouched. |
| Unconfirmed old native exit | **Retry sync** rechecks ownership. **Get help** explains persistent quarantine and offers bounded, copyable support details. No automatic reset of ownership. |
| Missing/incompatible addon | **Update or reinstall Freedom**, plus **Get help**, even if a native process never started. No ineffective checkpoint Retry button. Settings uses the same product guidance. |
| Quorum unavailable, conflict, proof mismatch, clock/stale/startup failures | Existing bounded retries and persistent failure actions remain. Verification never becomes optional. |

Repair requires confirmed exit of the manager's previous child plus absent or
validated-retired ownership records in the base and **every** generation directory,
including orphans. These checks run again immediately before atomic pointer
publication. Unknown directory entries, linked generation paths, unsafe pointer
files and active/unknown owners block repair. No old native marker, snapshot or
owner record is changed. A stale bundled anchor must still pass the ordinary
quorum + Colibri recovery flow before reads become ready.

A persistent ownership quarantine still needs operator assistance to establish
that the old child cannot run and provision fresh storage while preserving the
old evidence. Rebooting can stop a leftover process, but it does not rewrite the
ownership record. The UI says this explicitly instead of promising Retry will
always fix it. Repair may also refuse unsafe filesystem layouts; Get help is the
fallback. This is an intentional limit, not an unsafe-reset button.

## Checks

- Focused Myotis, preload, renderer and style suite: **332 passed** (11 suites).
- Full unit suite: **4,556 passed, 13 skipped, 3 known unrelated failures**: two
  macOS shortcut-remap expectations in `settings-store.test.js`, and the Safe fork
  test expecting Base support. These are the same failures recorded before this
  follow-up. A subsequent focused run covers the final fallback-copy and
  nonblocking file-read refinements.
- `npm run lint` and `git diff --check`: pass.
- New regressions exercise actual filesystem repair/backup preservation, corruption
  of pointer/anchor/native marker, active ownership in base/current/orphan dirs,
  ownership changing before publication, linked directories, storage-access error
  categories, addon-load categories, trusted-frame enforcement, single-flight
  confirmation, cancellation/stop/profile/navigation races, stale-after-repair
  proof acquisition, progress timing, dismissal, success clearing and action routing.
- `node docs/audits/evidence/myotis-recovery-ux-2026-09/ui-check.cjs`: both themes pass
  in real Electron with simulated statuses and IPC action handlers. It checks
  visible actions, Repair/Get help routing, slow-notice dismissal, later failure
  notification and success clearing. **This is a UI check, not a live network or
  native repair qualification.** Native dialog decisions are covered by manager
  tests; screenshots show the Nodes menu and notice, not the OS dialog.
- `npm run test:e2e:theme-parity`: 6 passed, 2 failed on the already documented
  macOS chrome-tour issues: stale Radicle contrast-baseline entry and the recipe's
  `Control+f` shortcut waiting for Find. No contrast changes are introduced here.
- `npm run test:e2e:screenshots`: 12 skipped as designed on macOS; baselines are
  Linux-only. The touched surfaces were captured and inspected in both themes.

The preceding live native/proof campaign remains documented in
[the v0.1.10 evidence](../myotis-v0110-2026-09/README.md). It was not repeated for
this UX follow-up; its platform and snapshot-restoration limits still apply.

## Screenshots and reproduction

Before screenshots use clean commit `5543a886c11075ab8e654c392807b642f663912f`
in an isolated temporary checkout. After screenshots use this follow-up. Both
use scratch profiles and simulated service statuses; no user profile is touched.
The retained script supports `MYOTIS_UX_ROOT=/path/to/baseline` for the before pass.
Run screenshots sequentially with other UI tours to avoid macOS window occlusion.

| State | Before dark / light | After dark / light |
| --- | --- | --- |
| Inconsistent data | [dark](before-storage-dark.png) / [light](before-storage-light.png) | [dark](after-storage-dark.png) / [light](after-storage-light.png) |
| Ownership blocked | [dark](before-ownership-dark.png) / [light](before-ownership-light.png) | [dark](after-ownership-dark.png) / [light](after-ownership-light.png) |
| Missing addon | [dark](before-installation-dark.png) / [light](before-installation-light.png) | [dark](after-installation-dark.png) / [light](after-installation-light.png) |
| Storage access error | Previously conflated with inconsistent data | [dark](after-storage-io-dark.png) / [light](after-storage-io-light.png) |
| Recovery over one minute | Previously silent outside Nodes | [dark](after-slow-dark.png) / [light](after-slow-light.png) |

Buttons reuse the existing recovery-action style and theme tokens. The new
explanations remain within the bounded, scrollable Nodes menu. Support details
contain only version/ABI, network, platform, failure category and addon presence;
copying is explicit and nothing is sent automatically.
