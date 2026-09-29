# Freedom Agent feature review — September 2026

- Date: 2026-09-28
- Branch: `feature/freedom-automation-kernel`
- Review starting revision: `e82cb88d`
- Comparison base: `ee2d4147979c5350c3e07a358b1d8ddbd7fee57b`

## Scope and method

The user requested an independent, in-depth Claude review of the entire feature
branch, followed by fixes and repeated review until actionable findings converged.
The comparison covered 382 files, including production code, tests and research.
Claude reviewed browser automation and its CLI, permissions, sandbox boundaries,
files/Git/history, previews, providers, sessions/subagents, renderer approval flows,
wallet/node operations, publication, diagnostics, persistence and startup. Native
supervisors were reviewed statically; this is not a certification of every platform.

Findings were checked against actual call paths, focused reproductions and tests.
The implementation agent adjudicated findings and made changes; Claude re-reviewed
the changes in successive rounds. Risky filesystem/Git fault cases ran in disposable
fixtures on the designated Mac mini. Electron tests used disposable profiles, not
the user's live profile. Neither reviewer output nor model-generated reports were
treated as proof by themselves.

Claude's final broad verdict was no remaining actionable defect in the reviewed
worktree, conditional on native qualification. Its subsequent review of the final
Git recovery refinement also found no blocking defect. The intentional limitations
and follow-ups below remain explicit; this verdict is not a claim of bug-free code.

## Changes resulting from the review

| Area | Problem and resulting behavior |
| --- | --- |
| Browser cancellation | Stop, Pause and tab takeover could leave an approved/classifying action able to dispatch later. Tool calls now carry cancellation, and dispatch rechecks both cancellation and ownership. Run-bound approval callbacks cannot migrate to a later run. |
| Node requests | Encoded paths could make approval/classification describe a different route from dispatch. Paths are canonicalized consistently; postage, stake, wallet, chequebook and transaction spend routes retain a deterministic financial approval floor. |
| Approval UI | A double-click or an asynchronous wallet unlock could act on the next request. Decisions bind to the displayed request, rapid replacement is guarded, and unlock completion rechecks identity. Empty Enter no longer stops work. Dialog page text is quoted separately from browser-owned copy; typed/selected values are shown, with password/OTP masking. |
| Focus and downloads | Automation no longer takes chrome keyboard focus merely to inspect or switch a page. Frame keyboard delivery uses temporary CDP focus emulation, cleared in `finally`. Downloads from controlled pages require an attributed approved intent; unsolicited, extra and substituted downloads are rejected. Pause/completion/takeover release these controls for ordinary browsing. |
| Browser boundaries | Unauthorized frame listings suppress document names and reduce URLs to origins. Unregistered adapters detach observers. The standalone runtime refuses interactive/transfer/privileged operations that require the sidebar's approval integration. |
| Read-only projects | Changes/history inspection now uses a read-only policy. The inspection helper parses Git configuration and rejects execution-capable configuration instead of relying on a line-based regex; Git indirection is refused. Helpers have independent read-version maps, so their reads cannot authorize a parent's stale write. |
| Files and history | Writes prepare a sibling file, preserve mode bits and atomically replace the original after freshness checks. Interrupted restore/recovery preserves the original recovery baseline, including added files. User checkpoint exclusions cannot be silently overridden by Agent. Parallel read-only history inspection no longer takes an exclusive writer lock. Ordinary loose Git objects no longer exhaust the structural scan cap; checkpoint maintenance packs loose objects. |
| External Git | Case/Unicode aliases are refused, `core.fileMode=false` is respected, selected-path metadata reads avoid whole-repository output overflow, and expired commands are refused before dispatch. Exact-baseline not-applied recovery releases only the proven owned index lock and archives the private journal; interrupted journal cleanup can be retried without touching repository state. Ref locks or changed lock identity refuse repair. |
| Session lifecycle | Stopped/interrupted requests and cancelled guidance are not replayed as live instructions. Pi queues clear at every terminal state, and idle sessions cannot collect stale steering for the next turn. Finishing callers await the same completion promise; helper receipts settle before persistence. Long conversations no longer consume a cumulative delegation-input budget. |
| Provider privacy | Changing models updates provider identity, classifier bindings and diagnostic grants. Approval copy therefore names the actual recipient. Provider settings use atomic replacement; diagnostic URLs redact paths/queries, including decentralized schemes. Deleting a conversation removes its node-operation journal. |
| Publication and wallet | Publication freezes bounded source bytes before approval and publishes that snapshot. Approvals show the content or file manifest and omissions; source changes during approval cannot substitute new content. Hidden/secret files are excluded or refused. Oversized/malformed calldata is refused before signing. Page-facing Swarm capacity errors no longer disclose wallet capacity figures; Agent retains measured recovery guidance. |
| Availability and lifecycle | Agent storage failures leave the browser and normal dApp wallet handling usable. Store migrations are transactional. New server starts apply port/uncertain-exit checks, disabled nodes cannot be started by Agent, and PDF jobs reuse a bounded processor partition. |
| Smaller UI corrections | Pending approvals reveal the sidebar, obsolete Retry controls no longer replay old turns, session renaming uses an inline editor, and Agent-first view does not hide newly opened ordinary tabs. |

Fixes stay within the existing main-process controllers, renderer presentation
and automation adapters; no package boundary or dependency changed.

## Validation

- Full unit run: **6,741 passed, 116 skipped, 3 failed**, across 337 passing,
  10 skipped and 2 failing suites. The three failures match the independently
  established baseline: two macOS shortcut-default expectations in
  `settings-store.test.js`, and the Base/Gnosis policy expectation in
  `wallet/safe/__tests__/integration/safe-fork.test.js`. They are not reported as
  passes and were not changed as part of this review.
- Final recovery-protocol unit run: **13 passed**, including changed ownership
  timestamps, ref-lock refusal and interruption after owned-lock release.
- Disposable Electron corpus: **155 passed initially**; three stale expectations
  were corrected (financial postage classification and opaque-frame name
  suppression). The targeted rerun passed **all three**. Thus all **158 selected
  cases** passed across these runs, not in one all-green invocation. Coverage
  includes automation, frames, dialogs, WebMCP, cancellation, sidebar, product
  qualification and Agent evaluation. Type/Enter with chrome focus elsewhere and
  redirected iframe focus passed; this does not claim a physical background-window
  interaction test.
- Mac mini real-Git qualification: **43 tests passed** for selected commits,
  aliases, file modes, a 6,600-file repository, deadline handling and interrupted
  recovery. Separate fault fixtures verified that retrying private-journal cleanup
  leaves the index/refs/working files unchanged, preserves a foreign file at the
  former archive destination, and refuses a substituted live lock. The final
  timestamp/ref-lock refinement also passed all 43 tests; an additional branch-lock
  fixture confirmed repair refusal without deleting either lock or changing files.
- Mac mini SQLite qualification injected migration failure and verified rollback
  and successful reopen. A malicious-filter fixture verified read-only inspection.
  The remote disposable candidate reused its existing dependency tree: Electron
  43/Pi 0.84.2/better-sqlite3 12.11.1, versus candidate declarations of Electron
  44/Pi 0.86/better-sqlite3 13. Pure Node/Git checks are unaffected by the Electron
  mismatch; the SQLite result has this version qualification. No remote dependency
  upgrade or persistent checkout/profile modification was made.
- Native probes rejected both `.git` and `.GIT` creation under the tested absent
  protected path. Cross-origin WebMCP discovery was denied; own-origin page access
  was not an additional authority. These observations resolved the review's
  corresponding hypotheses without speculative API changes.
- Lint and whitespace checks passed. No new dependency was added.

## Intentional limits and follow-ups

These are retained product/qualification decisions, not silently completed work:

1. **External Git reconciliation — implemented in a September 29 follow-up:**
   The original review left manually reconciled journals blocked. The Agent now
   inspects recovery evidence and automatically finalizes exact known states or
   archives a record whose selected changes are already committed with reconciled
   staging. Ambiguous intent is discussed in chat; `keep_current` archives only
   the private record, leaving repository files, index and refs untouched. Fresh
   tokens, existing editing access, cancellation and lock checks remain required.
   Active Git operations, foreign/changed locks and replaced metadata still
   require investigation; old journals without ownership proof cannot authorize
   deleting a lock. See the [current contract](../agent-project-viewer.md#interrupted-commits-in-external-repositories)
   and [dated roadmap](../../research/freedom-agent-cli-roadmap.md).
   This follow-up was not part of Claude's September 28 review verdict.
2. **Retained recovery evidence:** interrupted writes can leave an owned temporary
   file, excluded from checkpoints/publication. Do not sweep files merely by name.
   Git recovery retains its private journal and prepared evidence; the final
   protocol does not create an index-lock archive in the user's repository.
   Define evidence retention and long-history pack consolidation separately.
3. **Downloads:** scripted/button-driven exports that cannot be attributed to the
   supported download tool report that manual downloading is required. Supporting
   these safely is a future adapter feature, not an approval bypass.
4. **Publication bounds:** attached-folder and workspace publication now share
   limits of 100 files, 1,000 scanned entries and 50 MiB. Raising them needs an
   explicit storage/approval design. Atomic replacement preserves mode bits, not
   arbitrary extended attributes/ACLs.
5. **Cancellation/reporting — September 29 follow-up implemented:** interaction
   and node-effect classifiers now receive cancellation, stop waiting promptly,
   abort/dispose their sessions and dispose sessions created after cancellation.
   Timeout also bounds session creation. Cancellation copy no longer certifies
   that a started action had no effects. Explicitly declined/withdrawn approvals
   remain distinguishable from uncertain action outcomes. Restored stopped turns
   are still omitted rather than annotated as possibly partially completed.
6. **Additional defense in depth — September 29 follow-up implemented:** host Git
   configuration is screened using Git's parser without include expansion;
   ordinary credential/diff settings remain supported by the fixed plumbing path.
   Inspection refuses common-directory/alternate indirection and promisor config;
   protocol lockdown also prevents lazy-fetch helper execution. Approval copy
   exposes invisible Unicode controls without changing execution bytes; page text
   cannot use embedded newlines to impersonate separate browser-owned lines.
   Website tool names reject control/format characters and remain opaque model
   references. Artifact open/show already inherits main's chrome-only IPC policy.
   These were checked against the merged implementation, not assumed resolved by
   the earlier verdict. See the pre-PR validation record below.
7. **Platform qualification:** Windows/Linux command containment remains deferred.
   Linux full-network mode shares the host network namespace, including abstract
   Unix sockets/possible X11 or host IPC; future qualification and approval copy
   should make this concrete. The macOS private-directory teardown race remains
   an unproven native hypothesis requiring a surviving-process fault fixture.
8. **Other deliberate behavior:** ordinary task navigation is not classified as a
   sensitive action on every URL; `personal_sign` shows exact bytes without a new
   UTF-8 view; multi-window Agent ownership remains single-owner. Database deletion
   does not promise forensic secure erasure. Previously half-migrated development
   databases are not automatically repaired by making future migrations atomic.

The existing [subagent backlog](../agent-subagents.md#delivery-status-and-remaining-roadmap--2026-09-28)
and [active roadmap](../../research/freedom-agent-cli-roadmap.md) remain the source
for optional product extensions. This review does not mark those extensions done.

## September 29 pre-PR follow-up

Claude independently revisited the remaining hardening items and the new Git
recovery implementation. Its focused findings led to parsed Git-config screening,
inspection-layout/lazy-fetch restrictions, Unicode display refinements and cleanup
of a journal whose write failed before ref dispatch. Incomplete journals left by
a crash can be inspected and explicitly archived when no lock remains, without
claiming a commit outcome or changing repository state. Unknown locks are retained.

The final focused re-review closed all five findings and reported no concrete
remaining finding. Its qualification conditions passed: 7,897 local unit tests,
lint, 21 Electron cancellation/WebMCP tests, the approval display smoke, and
91 Mac mini tests plus seven real-Git recovery probes using Node 24.18.1 and
the locked dependencies. These are scoped checks, not packaged/native containment
qualification. The [review guide](../agent-review-guide.md) gives the colleague a reading
order, smoke checklist and explicit limits. The active roadmap records final test
counts and CI status; the September 28 validation above remains historical.

CI subsequently exposed two main-merge integration regressions: the download
history footer inherited the shelf's disabled pointer events, and the global
chrome navigation lock applied to hidden automation windows as well. Claude
confirmed both causes. The footer restores pointer events; the navigation guard
exempts only manager-owned pages with no preload, Node integration or webview
support, preserving sandboxing and isolation. Unknown/privileged windows remain
locked. CI/test setup corrections and dated qualification are in the roadmap.
