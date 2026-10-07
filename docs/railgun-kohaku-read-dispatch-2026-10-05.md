# Internal Kohaku read dispatch — October 5, 2026

The facade's asynchronous read sequence now lives in a small internal helper.
The public constructor and genuine account authority remain in the main-process
facade. This is a prerequisite for reusable adapter composition, not a generic
Kohaku Host implementation or a standalone package.

The helper dispatches only `instanceId`, `balance` and `notes`. Fixed private
closures capture the current genuine account/view, retain pending work, recheck
the same account/view after success, and sanitize failure. The helper preserves
the view receiver, argument references and successful result identity. It retains
the derived promise including the post-read checks, as the original code did;
it does not promise identity with the delegate's original promise.

The facade freezes those closures and never accepts caller-supplied ports or
returns them. It retains its existing account lifecycle, directory exclusion,
operation issuers and preparation/submission behavior. Closing prevents new
admission and keeps directory ownership until admitted reads settle. The helper
imports only builtin assert and issues no account or operation authority.

This belongs under `src/main/wallet/` because it sequences privileged wallet
reads using existing main-owned account checks. Moving it to a renderer or
public host API would cross a boundary that this change does not require.
There are no dependency, IPC, key/job permission or source-policy changes.

## Validation

Root focused checks pass **421 tests across thirteen suites in 1.397 seconds**,
with natural exit and no force-exit. Full lint passes without warnings and all
five changed JavaScript files pass formatting (root-attested; no saved log). The earlier scratch lint returned
zero with an unused test-argument warning; root caught it, renamed that argument
to `_args`, and reran tests and lint. Production bytes are unchanged from the
independently reviewed candidate.

Tests cover fixed authority, receiver/argument/result identity, synchronous and
asynchronous failure, post-settlement revocation and directory retention while
reads are held. Three detached controls distinguish removal of the recheck,
removal of pending-work retention and cloning the returned value. Existing unit
registry mocks remain explicit; these tests do not establish native ownership.
An AST comparison preserves the remaining facade functions and owner checks.
Both independent and external Codex reviews found no source blocker.

The wallet-journal qualifier's explicit Kohaku inventory includes the new helper.
Other relevant inventories discover it recursively. Existing evidence remains
pinned to its historical sources. The prior full regression and fifteen-process
[origin campaign](railgun-shield-origin-2026-10-05.md) precede this extraction;
they are not relabeled as current. The bounded native contract campaign below now passes.

Portable Host compatibility, upstream TypeScript conformance, live Railgun
service/broadcaster qualification and product activation remain separate work.
No funded profile, owned-note service lookup or live private spending was used.

## Native compatibility follow-up

At `e4ec6dd5`, nine fresh contract compatibility processes pass on Electron
44.5.1. The source-pinned launcher preserves the complete expected reports,
including 924 checked adapter reads and original forwarding outcomes. The
private Shield/Transact, public Shield and ordinary-wallet cases cover six
synthetic sends and two review-cancellation outcomes.

The selected source maps contain 144 private, 179 public and 140 default-wallet
entries, with a 180-file union. Eight Kohaku maps include the new read
helper; ordinary-wallet selection is unchanged. The complete outer inventory
contains 11,526 files and fifteen source symlinks, with ten external inputs and
twenty-five prover artifacts pinned. Inventories identify bytes, not execution
coverage. The qualifier changed only its source list; lifecycle code is identical.

All nine original child exits and the original driver exit were observed as
zero. Pre-cleanup worker snapshots retain the reviewed zero-to-two pending
worker bound; final exit requires the fixture cleanup/sticky gate. This is
logical lifetime evidence, not physical socket drainage.

The chain and service inputs remain synthetic, including legacy private
POI/preflight authority seams. Only the 421 focused tests and clean lint/format
above apply to these sources. The prior full regression and cold restart campaign
remain historical. No new full suite or cold sequence was run for this refactor.

Raw reports, selected hashes and observed process evidence are published in
[the evidence index](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-kohaku-dispatch-2026-10-05/INDEX.json).
Claude reviewed the launcher, exporter and final evidence.
