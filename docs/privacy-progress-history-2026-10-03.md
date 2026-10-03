# Historical issue/PR progress summary — October 3, 2026

The following previous prefix is retained verbatim as historical context.
The live issue and draft PR carry the newer enrolled public-scan summary.

## October 3 continuation: Railgun vault identity, reads, independent runtimes and enrollment

[Current-Kohaku reads](https://github.com/solardev-xyz/freedom-browser/blob/069c7ca04e91cec24afbb4a2bbf76f00a43b4fcc/docs/railgun-kohaku-reads-2026-10-03.md) expose receipt-bound identity, balances and notes over validated wallet checkpoints. Synthetic receive/spent/self-transfer cases and the archived 10,194-commitment cold scan pass. Balances remain unverified; stale/replayed evidence and unsupported unfiltered ERC1155 reads refuse. WETH remains ERC20.

[Independent prover packaging](https://github.com/solardev-xyz/freedom-browser/blob/302db90ed34bf852970f4df230bcc31cc823951b/docs/railgun-independent-prover-2026-10-03.md) removes the PPv2 archive dependency. Two strict builds are identical; all five transaction shapes and POI3×3 verify and reject changed public inputs. Installed build inputs remain explicitly pinned; no dependencies were added. POI-service eligibility and production distribution/license clearance remain open.

[Vault-bound identity and scans](https://github.com/solardev-xyz/freedom-browser/blob/2dba1f0de6286c8fca29b00930a787f12e570b79/docs/railgun-vault-identity-2026-10-03.md) authenticate a separately packed engine. Public spending-key derivation and viewing scans run in separate utilities with one-use binary key handoffs; address and wallet ID now match vault derivation. Actual lock-during-handoff cancellation, eight account scan windows, thirteen recovery cases and six proof jobs pass. Normal native-addon loading is refused; supported WebSocket JS fallbacks avoid an unnecessary native import. Full native regression: 7,808 passed /33 skipped; identity commit2dba1f0d passed CI; prover commit302db90e passed on rerun after attempt1 terminated on an unhandled privacy-session revocation during PPv2 reconciliation-test teardown; root-cause review remains open. Earlier read commit069c7ca0 failed macOS onboarding at the backup-confirmation checkbox; that earlier failure is not relabelled a pass or a flake.

[Durable enrollment](https://github.com/solardev-xyz/freedom-browser/blob/1869f211d42b43d9f940e5bc10390b06f07fb3a2/docs/railgun-enrollment-2026-10-03.md) adds an encrypted pending→catalog→active account manifest and purpose/generation-separated vault-derived storage keys. Runtime/policy belongs to cache generations, not account identity. A real disposable vault creates and reopens three encrypted stores after lock/unlock; five files are inventoried. Changed identity/seed, moved or missing state, symlinks and interrupted enrollment are checked. The qualifier registers the SQLite files; the reusable store/coordinator composition is still next. This is empty-store lifecycle evidence, not new scan coverage or funded recovery. Enrollment regression: 7,835 passed /33 skipped; 48 focused checks pass. Claude reviewed implementation and evidence; engineering review is not a security audit.

Next: staged SQLite initialization and inventory registration in the host composition; active-generation/store-ID checks; live source acquisition and governance-boundary advancement; TXID/POI and relay services; independently checked intent-bound proving/signing; reservations/journals and funded shield/private-transfer/unshield recovery. Main834409b1 remains merged with explicitly refreshed nodes. No Railgun funds have moved. Product UI, production enablement and distribution gates remain unfinished.

Earlier published updates and exact historical evidence are retained in the [progress history](https://github.com/solardev-xyz/freedom-browser/blob/1869f211d42b43d9f940e5bc10390b06f07fb3a2/docs/privacy-progress-history-2026-10-02.md). Earlier checkpoints below are historical.

---

This is a historical status snapshot, superseded by the current continuation.
