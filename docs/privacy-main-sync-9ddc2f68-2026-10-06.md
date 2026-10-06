# Main synchronization: 9ddc2f68

Merged main `9ddc2f68` into the privacy feature branch in `01e20b97`. The private balance router still returns before ordinary source selection; main's new opt-in Blockscout route remains ordinary Ant/Gnosis traffic. Both shutdown/privacy-session changes and main's test-only adblock startup gate survive. Claude reviewed the two-parent integration and found no lost behavior.

The existing disabled wallet Tor control now sits under Advanced alongside main's regrouped settings. Its existing experimental label is retained: this unavailable qualification control has not graduated to an enabled Beta feature. Its IDs, help text and availability rule are unchanged. Search and copy checks reflect its new location. The two historical `42-settings-experimental` images are retained as unused historical files under the no-deletion rule; the current tour uses `38-settings-advanced`.

All four applicable downloaders were explicitly rerun successfully after the merge: Ant **0.5.59** (all supported targets), freedom-ipfs **0.4.5** (host addon), Radicle **0.7.1** (host addon), Myotis **0.1.12** (official targets). The Myotis supervisor was rebuilt. Installed Arti **2.6.0** matches its unchanged pin, so the playbook's unchanged-pin exception avoids recompilation. `check-binaries` passes. Package, lockfile and binary pins did not change; no npm dependency installation or upgrade was necessary.

Validation:

- 420 distinct focused unit cases pass across routing, Blockscout, Ant bridge, private balances, Tor, Settings, styles and theme definitions. The first sandboxed run had 85 localhost-listener failures and one stale Settings expectation; the bridge and corrected Settings suite then passed all 116 cases outside the sandbox.
- 360 further privacy transport, Kohaku, adblock/startup and preload cases pass across nine suites. No funded profile or live private service was used.
- Strict repository lint and formatting of the four conflict-resolution files pass.
- The direct Advanced smoke check passes in dark and light (two cases). [Dark](qualification/privacy-main-sync-9ddc2f68-2026-10-06/dark-advanced.png) and [light](qualification/privacy-main-sync-9ddc2f68-2026-10-06/light-advanced.png) captures were visually inspected: the row, disabled toggle and complete help text fit the existing card. An earlier smoke assertion used only the static HTML help text and was corrected to the existing complete runtime text; it is not counted as a pass.
- The full macOS theme walk is **4 passed / 4 failed**. Chrome cases hit the existing `Control+f` recipe on macOS and contrast-baseline differences; internal-page cases report stale Ad Blocking contrast entries at the regrouped permissions surface. No Linux baseline was rewritten from macOS. The Linux `38-settings-advanced` screenshot pair still needs regeneration to include the retained wallet Tor row; the full screenshot suite has not been qualified here.

These UI checks use the ordinary disposable Playwright harness. Its bounded forced teardown is separate from Railgun's original-process native evidence and establishes no private utility drainage guarantee. Historical Railgun native reports remain pinned to their original source snapshots, including cooperative enrollment at `8288b5c2`; this merge does not retrospectively qualify a new native source graph.
