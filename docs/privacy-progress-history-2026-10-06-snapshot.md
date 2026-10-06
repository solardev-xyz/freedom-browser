## Current checkpoint: restricted Kohaku reads qualified

At `7df961d3608a4d502d86839e425a9ed6b6aab2a8`, the Railgun work includes a reusable completed-snapshot read adapter and a fixed bridge that borrows an already-open Freedom account. Its data validation, detached mutable results and lifecycle handling are separate from transaction authority. The existing public/private transaction facade remains Freedom-owned.

One fresh native case at source commit `20560d86` passed on the pinned Electron 44.5.1 runtime. It exercised **13 successful reads**, mutation isolation, an admitted read refused during close, three post-close refusals, a genuine host-abort refusal and two healthy borrowed-account reads afterward. All **14 measured activity deltas** stayed zero, and measured encrypted file names/bytes stayed unchanged. Original child and launcher exits were observed. This uses genuine local account owners over synthetic WETH history; it does not qualify live services or physical drainage.

A separate strict TypeScript 6.0.3 check passed one positive and **24 negative cases**: nine bind pinned upstream types, fifteen check Freedom's declaration. All eight loaded Kohaku source files match the pinned Git commit. This checks declaration/consumer assignability, not JavaScript implementation types. Installed ox 0.14.45 differs from upstream's requested ^0.12.0; the result is limited to the recorded resolved graph. Inspectable harness inputs and reproduction instructions are archived.

Root checks passed **544 tests across 16 suites**, with natural exit, clean full lint and changed-source formatting. This milestone does not refresh the earlier full regression or broader native campaigns. The intervening [read-dispatch milestone](https://github.com/solardev-xyz/freedom-browser/blob/7df961d3608a4d502d86839e425a9ed6b6aab2a8/docs/railgun-kohaku-read-dispatch-2026-10-05.md) passed nine native compatibility cases and 924 checked reads at `e4ec6dd5`. Main `e98e2dd5` remains merged with its locked dependencies and explicitly refreshed nodes.

- [Implementation, results and limits](https://github.com/solardev-xyz/freedom-browser/blob/7df961d3608a4d502d86839e425a9ed6b6aab2a8/docs/railgun-kohaku-snapshot-qualification-2026-10-06.md)
- [Exact native report and source evidence](https://github.com/solardev-xyz/freedom-browser/blob/7df961d3608a4d502d86839e425a9ed6b6aab2a8/docs/qualification/railgun-kohaku-snapshot-native-2026-10-06/INDEX.json)
- [Type-check evidence and reproduction archive](https://github.com/solardev-xyz/freedom-browser/blob/7df961d3608a4d502d86839e425a9ed6b6aab2a8/docs/qualification/railgun-kohaku-snapshot-types-2026-10-06/INDEX.json)
- [Remaining work](https://github.com/solardev-xyz/freedom-browser/blob/7df961d3608a4d502d86839e425a9ed6b6aab2a8/docs/railgun-parity-plan-2026-10-04.md) and [complete roadmap](https://github.com/solardev-xyz/freedom-browser/blob/7df961d3608a4d502d86839e425a9ed6b6aab2a8/research/privacy-roadmap.md)

Next: bounded reusable transaction preparation, generic Host/package design, live private/service and broadcaster qualification with the necessary disclosure approval, and later UI/product work. PPv2's earlier bounded live Sepolia journey and Railgun's funded Shield/restart remain established milestones. Production privacy activation stays disabled. Claude and Codex reviewed the design, code or evidence in their recorded scopes; this is engineering review, not an external security audit.

The prior origin checkpoint is preserved [verbatim in the progress history](https://github.com/solardev-xyz/freedom-browser/blob/7df961d3608a4d502d86839e425a9ed6b6aab2a8/docs/privacy-progress-history-2026-10-06-origin.md). The original research/implementation narrative follows unchanged.

---

