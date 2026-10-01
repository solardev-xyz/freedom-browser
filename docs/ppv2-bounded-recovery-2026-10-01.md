# PPv2 bounded work and exit readiness — October 1

This follows the [durable exit reservation](ppv2-exit-reservations-2026-10-01.md) fix. It changes main-owned development infrastructure only; it does not enable production, change runtime pins, or touch the funded profile.

## Session lifetime and history scans

Session opening and serialized SDK operations now have a five-minute stall budget. A successful history window may renew that budget for explicitly designated scanning tasks. Keys, storage or a hung dependency cannot keep it alive by emitting messages. Non-scanning operations retain an absolute five-minute limit; an explicitly shortened main-only startup timeout is also absolute.

A scan cannot renew forever: before sending each log request, main accounts for its requested block range against a task-specific allowance. The allowance is 64 times the range from the lowest audited contract floor to the first observed head, plus a 10,000-block growth margin. A per-task maximum tolerates a later lower head; a later higher head cannot enlarge that fixed allowance or move beyond the margin. Repeated rescans eventually close the scope with `PRIVATE_PPV2_SCAN_LIMIT`; stalled work closes it with `PRIVATE_PPV2_TASK_TIMEOUT`. Bounded scan grants require audited floors. Individual RPC requests keep their existing deadlines and 5,000-block limits.

This is a work bound, not a promise that a fresh scan finishes within five minutes. The pinned SDK persists some cursors only after a full scan, so an arbitrary short wall-clock cutoff could prevent it from ever catching up. Persistent intermediate checkpoints and real Tor/outage latency calibration remain future work. Remote heads and history completeness remain unverified; a malicious endpoint can still deny service.

Expiry revokes only the child session: transport, prover and storage capabilities close, the account lease is released, and late results cannot publish a session or write state. Submission-task timeouts explicitly carry `submissionStatus: unknown` and `reconciliationRequired: true`; they do not authorize retry. Existing public and relay journals remain authoritative.

Main-only progress reports contain fixed stages, elapsed milliseconds, completed window counts and scanned block counts. They omit addresses, URLs, heights, ranges, notes, SDK errors and causes. Diagnostic callback failures are ignored. The standalone qualification harness also sanitizes detached promise failures.

## RPC context separation

Unfiltered public event scans and their `latest` head use the protocol context, including keystore history. Owner contract calls keep the owner context. The log grant still permits only topic zero, not owner-indexed filters. A protocol-routed call containing the known owner word is refused before transport.

## Exit preflight

Preflight now declares its purpose. The default `full` purpose is unchanged; unknown purposes are refused. For `exit`, ASP feed/key/root checks, relayer discovery, quote requests and quote-lifetime checks are explicitly marked not applicable, as is native deposit eligibility. The same exit purpose is used at harness startup, preparation and the final guarded signing check.

Chain identity, canonical finalized anchor, contract/proxy/address links, every pinned verifier, processor interface and keystore root liveness remain checked. The pool-pause gate is conservatively retained until the deployed contract's exit behavior while paused is independently established. The SDK may still try an ASP snapshot and fall back to a longer chain scan; skipping preflight service checks does not mean no ASP request can occur anywhere in the SDK.

No claim of complete ASP-outage recovery or production availability is made. The qualification harness continues to require its explicit disposable test profile and direct-relayer exposure marker, even though exit preflight no longer sends a relayer quote request.

Validation: 101 focused unit tests passed (2 environment-dependent skips); repository lint clean. Controlled pinned-SDK Electron lifecycle, controller and stale-withdrawal regressions passed. After the final lower-head correction, lifecycle and controller were rerun. Tests exercise late results/writes, lease reuse, progress beyond five minutes, stalls, work exhaustion before log transport, task reset, head inflation and lower heads, and exit preflight during service outages. Claude reviewed each correction read-only.
