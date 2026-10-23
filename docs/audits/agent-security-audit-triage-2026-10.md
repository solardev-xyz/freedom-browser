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

## Repair status — 2026-10-21

The intake below is retained as the historical baseline. The following record
supersedes its descriptions of code that was still unchanged. Implementation is
not blanket audit clearance: native Windows qualification and independent
re-review remain gates.

| IDs | Implemented repair / present evidence | Still open |
| --- | --- | --- |
| S1, additional conversation-deletion race | macOS cleanup runs under a write-confined Seatbelt profile using the originally authorized pathname, including when the root is replaced. Windows cleanup uses Rust's handle-relative `remove_dir_all`. Conversation deletion aborts and drains commands/processes before deleting; timeouts preserve the tree. Native macOS link/root-substitution sentinels and shutdown regressions pass. | Native Windows rebuild and junction/root-substitution checks passed in [CI run 39642815354](https://github.com/solardev-xyz/freedom-browser/actions/runs/39642815354). Stress qualification with surviving writers remains open. No unrestricted recursive fallback after a workload has run. |
| S2 | Publication rejects the selected root and full child paths for hidden/credential directories. Root `.` and public `.well-known` remain usable. Regression fixtures cover `.private`, `.ssh`, `.aws` and nested `config/secrets`. | None identified in this bounded repair. |
| S3 | Validate the opened object, rather than repeatedly trusting its pathname: Linux `/proc/self/fd`, macOS `F_GETPATH` through the pinned native helper, Windows `GetFinalPathNameByHandleW` before reading. A deterministic swap-back fixture proves an outside descriptor retains its outside identity. The follow-up carries the authorized root device/inode from the external grant, checks canonicalization against that identity, and rechecks root identity around each read; preview tokens also retain their selected-subroot identity. Deterministic root substitution regressions cover both readers. Existing ordinary-file/hard-link and size restrictions remain. | Native Windows ordinary-read and outside-junction refusal passed in the same CI run; applicable platform race qualification remains open. |
| S4, L9 | Home-level hidden toolchain/package directories no longer become implicit grants; approvals/classification receive the exact executable and read-root paths. `otool` dependencies cannot widen reads beyond approved runtime material or bounded Homebrew packages. | Broader installed toolchain compatibility remains subject to its normal platform matrix. |
| S5 | Internal start/interstitial pages cannot be read or clicked, even before the first supported page. Navigation away to a supported URL remains permitted. Both paths have regressions. | None identified in this bounded repair. |
| S6 | Removed same-name DOM form inference and its manual-submit/destination assurances. Native pending jobs remain pollable without claiming that a decoy form controls them. Actual automatic/manual WebMCP behavior passes Electron qualification. | None identified in this bounded repair. |
| S7 | No boundary change: the macOS hypothesis did not reproduce. A permanent native regression applies the production absent-`.git` rule and tests `.git`, `.GIT`, `.Git`, `.gIT` with a successful ordinary-write control. | Do not extrapolate the macOS result to another filesystem/platform. |
| S8 | **Confirmed on Windows CI:** the owned DNS listener received one host-control query and one offline-workload query (`control:1, offlinePackets:1`). Direct sockets remained blocked. The namespace-only NRPT rule was removed in `finally`. | **Bounded production repair qualified:** remove the unsupported offline-command capability. Windows shell commands require the existing explicit full-network grant (exact command/directory for allow-once; existing broader conversation scope when selected). Controller, executor and native protocol reject an ordinary offline command before launch. Fixed built-in file operations have a separate controller-owned entry point and retain filesystem restrictions. Strong offline execution is deferred; no silent network promotion. Both current-source native jobs passed in [run 39675000994](https://github.com/solardev-xyz/freedom-browser/actions/runs/39675000994). |
| L1 | Credential removal/rotation invalidates cached runtimes before requests, including separately stored subscription OAuth ciphertext revisions; affected live sessions are stopped/disposed and transcript restoration is preserved. Disposal is awaited, including an earlier detached session. Regression tests cover old-key refusal and asynchronous disposal, plus real-store OAuth replacement during an active run. A runtime can advance its own revision only through its successful serialized refresh; stale runtimes cannot modify/delete replacement credentials. | Native Windows Claude process lifecycle is not inferred from these unit tests. |
| L2 | Codemode prevents Pi's shared-temp spill path through its integration, then bounds/coalesces output in memory and preserves failure diagnostics. A native SDK regression forces `max_output_tokens:0`, verifies no spill file appears and checks partial effects/cancellation. | No dependency or vendor patch was made. |
| L3 | Keep the latest 2,000 routine activity entries while retaining approvals, failures and effect receipts in chronological order; saved-history regression covers late evidence after a large read loop. | Consequential records remain proportional to actual effects, rather than silently discarded. |
| L4 | Previews use a separate non-persistent Chromium session with a rejecting local proxy and `disable_non_proxied_udp`; all device/permission requests and downloads are denied. The normal browsing session is unchanged. Constructor removal is only defense in depth. Live Electron loopback-enabled control: 40 UDP packets / 4 TCP connections; isolated preview: 0 / 0. Real app modules, local storage and interactions pass. | Independent macOS/Linux/Windows owned-listener jobs passed in [CI run 39651868810](https://github.com/solardev-xyz/freedom-browser/actions/runs/39651868810), using positive UDP/TCP controls and zero isolated observations. Hostname/DNS qualification remains separate. |
| L5 | Flatten approval-reason control/bidi/separator characters and reject those characters in MCP tool names. Reasons remain explicitly labelled as Agent requests. Regression checks the actual approval projection. | None identified in this bounded repair. |
| L6 | MCP OAuth discovery and refresh use guarded fetches. Same-origin access remains available for deliberately connected local services; foreign authentication endpoints must resolve publicly, are pinned to those addresses for TLS and cannot redirect. IPv6 destinations must be allocated global unicast (2000::/3) outside the denied special/documentation ranges; mixed public/non-public DNS answers are refused. AI-disable cancellation remains applied; response size is bounded. | Separate private authentication origins require an explicit future connection policy; no implicit private-host access. |
| L7 | Public custom-provider HTTP endpoints are refused; HTTPS plus localhost/private-IP HTTP remain supported. | LAN DNS names require HTTPS or their private IP address. |
| L8 | Claude runs inside a private scratch parent and work directory, and excludes both rooted and Windows-compatible instruction patterns. The legacy `ProgramData\ClaudeCode` allegation does not apply to the modern required CLI: [Anthropic documents that it no longer reads that path](https://code.claude.com/docs/en/managed-settings#where-each-mechanism-stores-the-policy). Active managed configuration is still refused. Checks run before/after spawn, before each input and tool dispatch, and every two seconds while idle; a detected policy revokes the bridge and terminates the child. This bounds detection latency, rather than claiming an atomic hook-reload barrier. Regression covers ignoring the dead legacy location rather than blocking a working connection. | Native Windows CLI exclusion/ACL qualification; do not claim it from macOS tests. |
| L10 | Freedom owns all 14 WFP GUIDs and names; build validation fails if originals remain or expected replacements disappear. Rust is explicitly pinned to upstream 1.95.0. Interactive setup rechecks hashes after acquiring write/delete-denying handles on the runtime directory and helpers, retaining those handles through elevation. | Native compilation/provisioning and the elevation-lock Rust regression passed in [CI run 39647888860](https://github.com/solardev-xyz/freedom-browser/actions/runs/39647888860), including changed-byte refusal and write/delete/rename denial while locks are held. Installed WFP qualification remains pending. Old shared Codex identifiers are deliberately not removed, as they may belong to Codex. |
| L11, wallet authority follow-up | Missing/zero transaction fee quotes are refused before approval/dispatch. Main refuses site auto-approval for Agent-owned guests even after Stop/runtime disposal; only explicit user takeover releases custody. Renderer routes these requests to normal explicit confirmation. Regressions exercise quote refusal and custody release. | Native signing/provider matrix remains its existing qualification scope. |
| L12 | Current production audit: 406 production packages, 10 Low advisories, no Moderate/High/Critical. DCAP uses elliptic only for public-signature verification; the other installed chain is Ledger's ethers-v5 transaction dependency. No patched elliptic release is reported; the audit's suggested DCAP major change is not a demonstrated remediation. Pi model network refresh remains explicitly disabled; the embedded session uses no CLI discovery/update startup. Personally identifying home-directory portions in tracked research evidence are redacted; hashes/revisions are unchanged. | Keep the dependency advisory tracked; no unsupported upgrade/downgrade or cryptographic rewrite is asserted as a fix. |

Verification so far: lint; final full unit suite (10,840 passed / 129 skipped);
13 Electron preview/WebMCP cases and five final real Electron startup/delegated-edit cases after the shared-helper extraction; controlled
UDP/TCP fixture above. The zoom E2E fixture now waits for layout/paint after changing scale (3 repeated local passes); its security target checks are unchanged. New E2E coverage is wired into general CI. Windows CI
also exercises read/cleanup junctions and the shared DNS service. The physical Windows desktop is powered off; these native checks use disposable GitHub-hosted Windows runners. Claude provided the initial S1/L10 design
review and a non-reproduction report for S7, but its model stopped the subsequent
review. The user-selected Daybreak Blue Codex reviewer completed the source repair review
and accepted the root-identity, bounded CLI-revocation, IPv6 and OAuth-generation
follow-ups. Its final S8 capability-removal review accepted the dedicated fixed-helper route, controller/backend/native gates, preserved permission scopes, disclosure normalization and prelaunch receipts; it found no further concrete source repair. Linux CI unit, theme-parity and screenshot checks passed at `6f539472`. Remaining
qualification gaps are the non-atomic CLI-policy reload interval, Linux cleanup
after uncertain namespace termination, hostname-based preview DNS/ICE, installed
WFP object enumeration. The native lock and execution-class Rust tests passed on both Windows runners. This is bounded repair evidence, not blanket release clearance.

Standard-user rerun (#779 item 3), 2026-10-23: S1, S8, the L10 locks and the
helper DLL search path passed as a standard user under real UAC, against an
installed build of `42158f97d`. See
[windows-standard-user-validation-2026-10.md](windows-standard-user-validation-2026-10.md).

S8 originally reproduced a confirmed DNS boundary failure. The bounded repair removes arbitrary offline execution from the Windows product contract. Current-source [native qualification 39675000994](https://github.com/solardev-xyz/freedom-browser/actions/runs/39675000994) passed on Server 2022 and Server 2025 at `6f539472`: two Rust tests per runner; filesystem/outside/Git/junction sentinels; cancellation and abrupt-parent-exit controls; real Electron file operations, npm build, checkpoint and external-project access; exact-once network-permission rejection/consumption; and five Agent startup/delegated-edit E2E cases per runner. Each DNS fixture observed a positive host control, **zero packets from the refused ordinary command** (`sandbox_denied`) and a positive approved-full control (`completed`). Zero packets are evidence of denial before launch, not a claim that an offline workload ran safely. Daybreak independently reviewed the final source and both native logs and accepted closing S8 for the bounded capability-removal claim. The standard-user desktop/UAC path was rerun on 2026-10-23 against an installed build (see the standard-user rerun above).

S8 enforcement research: [run 39658881966](https://github.com/solardev-xyz/freedom-browser/actions/runs/39658881966)
installed and read back an offline-caller-scoped `RPC_UM` filter on the observed
DNS resolver UUID `45776b01-5956-4485-9f80-f428f7d60129`, with version and local
RPC conditions, under a uniquely keyed dynamic sublayer. Windows Server 2022
still sent the offline lookup (`host:1, offline:1`). Removing the optional
version/protocol conditions in [run 39659535496](https://github.com/solardev-xyz/freedom-browser/actions/runs/39659535496)
also failed to block that path. Server 2025 timed out during the second NRPT
setup in those runs, so no enforcement result is inferred there. Dynamic test
filters close with their helper process. Neither experiment changed production
network policy or constitutes a fix. The owned dual-stack default-resolver
fixture removed NRPT from attribution in [run 39664666767](https://github.com/solardev-xyz/freedom-browser/actions/runs/39664666767):
on both Windows Server versions, query-only, policy-only and combined RPC filters
still produced two offline DNS packets, with positive host/full controls. Earlier
fixture-restoration defects were in disposable CI setup, not production changes;
the later PowerShell-5 array handling repair now restores addresses and source
modes successfully.

An isolated zero-capability AppContainer prototype in [run 39667871740](https://github.com/solardev-xyz/freedom-browser/actions/runs/39667871740)
verified the actual package SID and capability list and successfully ran Node and
wrote an ordinary medium-labelled project file on both versions, with all ACL
changes confined to an owned copied runtime/project fixture. DNS observations
were `offline:0, host:2, full:2` on Server 2025, but `offline:2, host:2, full:2` on
Server 2022. Both restored their DNS configuration. **This is a prototype, not a
production repair; the AppContainer flag alone is not a verified offline
boundary.** An explicit package-identity WFP experiment and service/profile
readiness evidence are pending. Production networking remains unchanged.

The exact-package filter experiment [39671944140](https://github.com/solardev-xyz/freedom-browser/actions/runs/39671944140)
proved a narrower mechanism on Server 2022: bare DNS 2, package-filtered DNS 0,
14 drop events attributed to the two owned filters, while host and approved-full
controls both remained 2 with the rule still installed. Server 2025 had a bare
baseline of 0, so its extra filter efficacy is inconclusive; normal/full controls
remained positive. Workload timeout was reported as timeout, not completion.
Both restored original DNS configuration. The attempted combined-token follow-up
stopped at its CI environment guard and provides no compatibility evidence.

Daybreak recommends the smaller capability-removal repair for this PR. A new
AppContainer overlay remains a future work item: combined restricted-token and
package ACL compatibility, persistent filters/profile setup, readiness, crash
ordering, upgrades and uninstall all need qualification. The historical prototype
scripts are research fixtures; the automatic PR workflow no longer downloads an
expiring old artifact or treats a prototype as product qualification. The product
workflow builds current native sources and checks both Windows Server 2022/2025.

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

Status: repair implementation and local verification are in progress as recorded
above. Remaining native and independent-review gates are explicit; the historical
intake itself made no source changes.
