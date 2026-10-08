# Startup main merge and bundled-node refresh

Merge `f4ec26e98044d7e3ac3e492a79ef214ef539cb1f` joins the reviewed Railgun restart milestone `7540636842b8e2d746a223ba2444610c42cbd01d` with main `484bf25987bce105d03729f02b98706b711197ef`. Main changed startup migration (`index.js`, `migrate-user-data.js` and its tests) and one changelog fragment. Bee-only state is set aside before Ant starts, then removed through the filesystem worker after the first window is ready. No funded profile or normal browser startup was opened during this verification.

The package/lockfile, node pins, wallet code and privacy qualification fixtures are unchanged. No npm dependency installation or pin upgrade was required. All four downloaders were explicitly rerun: Ant 0.5.58 (all targets), IPFS 0.4.3 (host packaged/development), Radicle 0.7.1 (host), and Myotis 0.1.12 (five targets). The Myotis supervisor was rebuilt. Arti 2.6.0 remains unchanged and its version was checked.

All original command handles exited 0 and were drained. Binary presence/checkpoint checks pass; the refreshed Radicle addon loads 30 required exports and answers `node not started`. No network node was started. The [evidence index](qualification/privacy-main-sync-484bf259-2026-10-05.json) records installed hashes, unchanged pin hashes and exact local log hashes. Arti's local binary hash is provenance, not an upstream binary checksum pin.

The affected migration, filesystem-worker, profile-resolver and profile-lock suites pass 57 tests in four suites (1.048s); full lint passes. This is targeted post-merge validation, not a new full regression.

The [18-process second cold-submission qualification](https://github.com/solardev-xyz/freedom-browser/blob/354e9a9887dff106ec7fb62a24d7a9490d002d5e/docs/railgun-second-cold-submission-2026-10-05.md) remains pinned to `7540636842b8e2d746a223ba2444610c42cbd01d`. Three files in its broad source inventory changed with main; its original 913-source reports and the historical 16,276-test production regression are not relabeled as runs against this merge. The next combined recovery/facade campaign will use a new source inventory.
