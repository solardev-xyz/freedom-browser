## Latest milestone: partial withdrawals through the Kohaku adapter - October 5

The existing Railgun `prepareUnshield` now supports withdrawing part of a selected note, with encrypted change returned to the same private account. It snapshots and reviews gross withdrawal/input/change amounts, verifies the destination, and uses the genuine operation controller, proof, signer and journal. Full-note withdrawal and transfer behavior remains covered by compatibility checks. Those four legacy private cases still substitute POI/preflight authority; the new partial cases exercise the real gates. No UI or IPC activation is added.

**Native qualification: 17 processes passed across partial outcomes, cancellation controls, direct/legacy private operations, public Shield and read-only compatibility.** The six core cases use both Shield-origin and received-Transact inputs, each with acknowledged submission, lost reply and wrong-verifier refusal. Four named Shield controls cover copied tokens, replay and closure during held preparation/final review. Every successful submission has one journaled EOA signature/send; lost replies never trigger a resend. Chain/list/receipt/finality services and review callbacks are simulated. Real Railgun contract execution, live private service acceptance and human review are not claimed.

The adapter explains whole-input consumption and the separate confirmed scan, reviewed combined-POI publication and list acceptance needed to spend change. It does not publish that change automatically. A separate second genuine adapter instance spending that scanned change is next, alongside cold second submission and original-signature recovery of interrupted second proving. Live private transfer/withdrawal, private broadcasting, extraction into a portable adapter project and UX remain open.

Main `758c98b0` is merged as `6392c1ea`; bundled nodes were refreshed again. The full regression passed 16,276 tests/544 suites (33 tests/five suites skipped; explicit Jest force-exit), plus six OpenLV integration tests separately; focused checks, lint and formatting passed. Eight new facade reports share 904 source hashes; the direct compatibility report has 578 matching subset hashes. Legacy private/public/read-only reports carry smaller 133/169/130-source maps, supplemented by the unchanged broader freeze. The driver mismatch between those inventory scopes is preserved and explained separately from the successful native exits. Older builds still refuse the entire version-3 retained-POI store after its first combined prepare. Claude and another agent reviewed the code/evidence; this is engineering review, not an external security audit.

Pinned review entry points at `189c0a31aedfb012758f8177d7cf79952ebdfae0`:
- [Implementation, native results and limits](https://github.com/solardev-xyz/freedom-browser/blob/189c0a31aedfb012758f8177d7cf79952ebdfae0/docs/railgun-kohaku-partial-facade-2026-10-05.md)
- [Complete roadmap](https://github.com/solardev-xyz/freedom-browser/blob/189c0a31aedfb012758f8177d7cf79952ebdfae0/research/privacy-roadmap.md)
- [Previous connected restart update, preserved verbatim](https://github.com/solardev-xyz/freedom-browser/blob/189c0a31aedfb012758f8177d7cf79952ebdfae0/docs/privacy-progress-history-2026-10-05-connected-restart.md)

The earlier research and implementation history follows unchanged.

---

