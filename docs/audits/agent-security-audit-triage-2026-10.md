# PR #457 security audit intake — 2026-10-21

Source: [Meinhard's October 21 security audit](https://github.com/solardev-xyz/freedom-browser/pull/457#issuecomment-6313239088),
posted at 09:59 UTC. It reviews head `17d08d34e` against base `a9d7e9978`
across six bounded passes. The latest layout re-review is separate:
[R3](https://github.com/solardev-xyz/freedom-browser/pull/457#issuecomment-6303673770)
reports no new layout findings after `17d08d34e`.

This intake checked the current feature head `aa347d79` and main `8a671891`.
It inspected representative code paths; it did not reproduce destructive races,
run platform exploits, contact model providers or perform wallet/publication
actions. Evidence labels below belong to the reviewer's report, unless explicitly
described as a local source check. Existing passing tests do not close these items.

## Priority and disposition

1. Address S1 before broad beta/release: sandbox-writable scratch must not let
   unsandboxed cleanup affect files outside the authorized tree. Reproduce only
   against explicitly disposable fixtures and qualify the affected native paths.
2. Fix/recheck S2, S4, S5 and S6 with bounded regressions: publication roots,
   executable-read grants, internal browser pages and truthful WebMCP approvals.
3. Validate S3, S7 and S8 on the applicable platforms. A hypothesis needs a
   demonstrated failure or a documented reason the current boundary already
   prevents it; do not count an unrun platform as fixed.
4. Work through L1–L12 below, starting with credential revocation, output spill,
   preview networking and approval records. Resolve product-policy questions
   explicitly rather than silently changing accepted capabilities.

The independent local-dictation review remains clearance of its own scope, not
this whole-feature audit. Domain skills remain planned; new capability work does
not take priority over these security findings.

## High and medium findings

| ID | Reported severity/evidence | Work and current intake status |
| --- | --- | --- |
| S1 | High; deletion-race mechanism reproduced, full macOS/Windows chain unrun | macOS and Windows grant writes inside per-command scratch and later recursively remove it from an unsandboxed process. Those paths are still present. Implement cleanup that cannot traverse attacker-controlled substitutions; cover surviving processes and native reparse/symlink behavior. |
| S2 | Medium; reproduced | Publication checks individual file paths and child names but not the selected folder's full path. The current source still has that asymmetry. Reject excluded selected roots and excluded full child paths; test hidden, SSH/AWS and nested credential folders. |
| S3 | Medium; hypothesis/partial demonstration | Static previews and publication use component/path checks followed by descriptor open and path rechecks. Current publication retains this pattern. Validate the claimed intermediate-directory swap against the actual product guards; use descriptor-relative or sandboxed reads if the escape is reachable. |
| S4 | Medium; fixture reproduction | Executable resolution can widen `bin` to its parent package root, excluding the home directory itself but allowing sensitive home subtrees. That source logic remains. Narrow grants and expose the actual granted roots to approval/classification; test runtime credentials/keyrings without exposing real user data. |
| S5 | Medium; unit reproduction | An unestablished task scope accepts a page with no recognized web origin. The current controller still returns `!workspaceEstablished` in this case. Prevent Agent interaction with internal trust/interstitial decisions; qualify supported decentralized and preview navigation as well as ordinary web pages. |
| S6 | Medium; Electron reproduction | WebMCP metadata infers manual submission and destination from a same-named DOM form. That lookup remains. Bind disclosures to actual declarative registration or omit unverified assurances; test a script tool plus a decoy form. |
| S7 | Medium; macOS hypothesis | Validate case-sensitive protection of an absent `.git` against case-insensitive filesystems and alternate case spellings. Require a real protected repository or enforce the intended case-insensitive boundary; keep this separate from the accepted nested-repository limitation. |
| S8 | Medium; Windows hypothesis | Test whether an offline workload can trigger DNS through the Windows DNS service despite account-scoped filters. Use a controlled DNS endpoint on the Windows test machine; do not infer this result from Linux network tests. |

## Other findings and verification work

The report groups these under Low. IDs here make its unnumbered bullets trackable;
they do not independently re-score severity or establish exploitability.

| ID | Finding | Work/status |
| --- | --- | --- |
| L1 | Connected-provider removal/key rotation does not revoke an already-open hosted runtime; Claude disconnect can leave a CLI session alive | Re-read or revoke credentials before later requests, abort/dispose affected live sessions, and test old-key/old-process refusal. Current hosted resolution still installs the selected key into the runtime; custom connections already have per-request lookup. |
| L2 | Pi codemode output can spill to shared OS temp without an explicit private mode or conversation cleanup | Installed Pi still writes `pi-codemode-*.txt` through its generic spill helper. Give spill files a private, conversation-owned lifecycle or prevent spill through a supported integration hook; cover model-selected output options and teardown. |
| L3 | Activity truncation can discard later approvals, errors and effect receipts | Current normalization keeps the first 2,000 entries. Preserve consequential evidence under bounded retention; test a large tool loop followed by an approved effect and reopening. |
| L4 | Static-preview WebRTC can bypass the documented offline expectation | Reviewer demonstrated TURN leakage in a standalone Electron window, not the full preview product. CSP `connect-src 'none'` remains; no preview-specific RTC restriction was found in this intake. Qualify and enforce the intended network boundary, including Tor/proxy behavior. |
| L5 | Model reasons and MCP names can mislead approval copy through newlines/control/bidi text | Keep untrusted reasons visually distinct/quoted or flattened, reject misleading control characters in names, and test the actual approval headline/body. Do not remove useful scope explanations. |
| L6 | Remote MCP OAuth metadata/refresh endpoints can target private hosts over HTTPS | Current endpoint validation restricts schemes/credentials but not destination address classes. Define the trusted service endpoint policy and enforce it across discovery, redirects, DNS and refresh without breaking intentionally connected local services. |
| L7 | Custom-provider public HTTP does not match the documented local/LAN-only contract | Reconcile implementation, disclosure and accepted connection policy. The current URL normalizer accepts HTTP without a private-host restriction. Do not silently broaden privacy claims. |
| L8 | Windows Claude CLI policy/config exclusions and scratch parent need native validation | Test instruction-file exclusion on Windows paths, legacy managed configuration locations and scratch privacy. The report labels these Windows hypotheses. |
| L9 | macOS dynamic-library inspection can widen reads after an editable executable changes | Validate the claimed executable-on-PATH chain and keep dependency read grants bounded to trusted runtime material. Source-only allegation in this intake; no hostile executable was launched. |
| L10 | Windows elevated setup/runtime supply-chain boundaries | Track three checks: replacement between hash verification and elevation; filter/provider GUID collisions with an installed Codex; and the Rust toolchain used for the setup binary. Validate on the Windows fixture host and preserve explicit administrator setup. |
| L11 | Missing wallet fee quote can appear as zero, followed by a different fee at signing | Refuse incomplete quotes or display/reapprove the actual bounded fee before dispatch; test the dApp transaction approval card. The Agent transfer path already has a refusal guard. |
| L12 | Dependency surface, outbound SDK behavior and published research evidence | Inventory Pi's additional production dependencies; verify optional catalogue/version/telemetry calls stay disabled; reassess the reported `elliptic` advisory through DCAP; review machine/user paths in research evidence for unnecessary disclosure. The audit's dependency counts are historical, not a new `npm audit` run here. |

## Already addressed separately

- [Wallet attribution issue #764](https://github.com/solardev-xyz/freedom-browser/issues/764)
  is closed by [PR #765](https://github.com/solardev-xyz/freedom-browser/pull/765).
  Main `8a671891` contains it, and feature integration `fdd2e729` already includes
  that main commit. This closes the separate requesting-tab attribution bug;
  it does not establish the audit's additional suggestion to prohibit automatic
  wallet approvals for every Agent-owned tab after control ends. Track that as
  part of the wallet authority follow-up.
- The R1/R2 layout, hard-link-message and test-stability repairs are present
  through `17d08d34e`. They are not fixes for S1–S8 or L1–L12.

Status: intake and initial source triage complete; security repairs and applicable
qualification remain open. No source change was made by this intake.
