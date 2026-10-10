# Main merge and node-refresh provenance

Merge `4ab31ac1bc88a8e7e07475d5a2ea62e5c9d425fd` joins feature `69c31ac32f1dc60b6ebf25e3241ba868d634c548` and main `cec2eb799be9bb1c57baf425fc71827324d39cc8`.

The primary agent observed exit 0 for Ant/IPFS/Radicle/Myotis refresh, Myotis supervisor build and binary checks. This review only read existing logs and hashed installed files; it did not repeat downloads, addon loads or native work.

| Component | Installed version | mac-arm64 binary SHA256                                            |
| --------- | ----------------- | ------------------------------------------------------------------ |
| Ant       | 0.5.58            | `d27bed99adc077c4c06d5e22e52aeeda0b43e5aa11622a1f084ba02ea63a35c3` |
| IPFS      | 0.4.3             | `10218e249ba00cb0c7646cbc738a85bb806a9f030aa449736bfa056284955b4b` |
| Radicle   | 0.7.1             | `807ef2c0679ee3cedebf9ef2f9f4c012f921b2f43bdcba52d3715a35e6d4d210` |
| Myotis    | v0.1.12           | `19f1866ce23230ebad65262b79bf2dd0792f5b98684fdfdd9a0e6c5d0295d9cc` |
| Arti      | 2.6.0             | `9d67b310f6d73848a83c5be54454ffc42565076cf46395782d7f7d80fc856d34` |

The Ant refresh log reports all five archives verified against the pinned SHA256SUMS manifest (archives are no longer retained there; this review rehashed the manifest and installed binaries); all five Myotis installed targets match committed v0.1.12 hashes. IPFS packaged/development addons are byte-identical. Radicle refresh verifies its pinned checksum manifest; the primary agent additionally loaded 30 exports. Arti’s unchanged 2.6.0 version matched the recorded `--version` check; its local binary hash is recorded rather than represented as an upstream binary pin. The supervisor hash and every installed platform binary appear in the [evidence index](qualification/privacy-main-sync-2026-10-05.json).

Package/lock and all listed pin/fetch inputs are byte-identical across this merge. No npm ci was required or run for this merge. Adblock asset requirements are unchanged and check-binaries passed. An old myotis-bin/myotis-node.SHA256SUMS file is not the current download manifest; the current downloader verifies the new manifest in memory and all installed target hashes independently match committed pins.

Validation: 199 corrected merge-focused tests in five suites (3.694 seconds); 251 merged restart tests in 14 suites (9.528 seconds); both full lint runs passed. The original router command’s exit 1 is retained separately: 92 router tests passed, but a wrong networks/ path caused ENOENT for the wallet private-transaction suite. No fresh full-regression or completed merged-native claim is made here.

Read-only fresh-process import-cache probe confirmed merged profile-resolver -> profile-catalog -> fs-offload/updater-owner-lock does not preload privacy-storage or account-enrollment. initializeProfile was not executed by the probe; source inspection finds no later lazy imports on the test-profile path.

The evidence index contains exact logs and hashes, source pin hashes, archive/installed-binary hashes, root-vs-reviewer evidence attribution and the separated diagnostic. No secrets or profile contents are included.

The JSON native-qualification field records the report-creation snapshot. See the [connected restart evidence](https://github.com/solardev-xyz/freedom-browser/blob/354e9a9887dff106ec7fb62a24d7a9490d002d5e/docs/railgun-connected-change-restart-2026-10-05.md) for the completed campaign.
