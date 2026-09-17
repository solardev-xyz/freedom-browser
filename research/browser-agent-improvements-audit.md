# Browser-agent improvements: Browser Use reference audit

Date: 2026-09-17
Last updated: 2026-09-18
Status: first-pass source audit complete; semantic, coverage, scrolling and initial dynamic-form slices implemented and locally qualified
Branch: `experiment/browser-agent-improvements`
Freedom baseline: `3438d498a6a427795f81e518407711e7c161d9c0`
Related plan: [Freedom Agent roadmap](freedom-agent-cli-roadmap.md)

## Decision and scope

Improve Freedom's browser competence using Browser Use as a reference implementation. Study implementations, regression tests and selected fixes before choosing what to reuse. Retain Freedom's ownership of browser operations and policy; keep Pi responsible for reasoning mechanics. A component adoption or larger replacement remains an option if later evidence justifies it.

The user chose to defer the upfront comparative benchmark and work sequentially in this conversation, without delegated agents or remote machines. This first pass covers all eight workflow areas below. It is not an exhaustive source/security audit, a claim of upstream test success, or a performance comparison. No upstream code was executed, no dependencies installed, and no Freedom browser behavior changed during this pass.

## Reproducible source baseline

Public source was fetched into a disposable research directory, outside the product checkout, with `git clone --depth 30 --single-branch`. Revisions below are the fetched heads, not asserted release versions. Recent history is shallow; only specific inspected changes are used as evidence, not a claim of complete project history.

| Project | Exact revision | Role in this audit |
| --- | --- | --- |
| [Browser Use Python][py-root] | `d8110c5ff87ccba887aaa726cdb780f2f84bef8d` | Rich DOM processing, browser tools, agent loop and regression cases |
| [Browser Use Pi][pi-root] | `fa838f3298673950923bdaf12bd3c1b6279cd119` | TypeScript/Pi loop, AX observations, context recovery, budgets and lifecycle |
| [Browser Harness JS][h-root] | `2d9a5ed37ed11f31b2622cd69c4b55f979cb905f` | CDP routing and interaction recipes |

These are separate implementations. Python's DOM serializer and specialized actions are not automatically capabilities of the Pi package. The Pi browser surface is intentionally small and exposes generated JavaScript/raw CDP. Harness recipes are guidance for an agent, not automatically enforced product behavior. Hosted services and the standalone benchmark repository are outside this pass. The Pi [benchmark document][pi-bench] explicitly describes historical results predating its current helper surface; none are used as Freedom performance evidence.

The fetched repositories contain MIT licenses. No upstream implementation/test code is copied into Freedom in this pass. If a later change copies or ports code, record its exact source and retain the required copyright/license notices through Freedom's existing attribution process.

## Finding register

Decisions are **adapt** (use the technique within Freedom), **investigate** (needs a bounded experiment), **retain** (existing Freedom capability worth testing against upstream cases), or **leave out** (unsuitable unchanged). Effort is relative integration effort, not a delivery estimate. Every verification below is proposed unless explicitly described as existing coverage.

### Page understanding

**OBS-01 — Labels and control state. Adapt; high benefit, small/medium effort.**

- Upstream: Pi [AX projection][pi-page] preserves names and checked/mixed, pressed, selected, expanded and disabled state. Its [real-browser tests][pi-ax-tests] exercise changes after input and shadow-root controls.
- Freedom: `collectPageSnapshot` in the [page adapter][f-page] resolves ARIA labels and several text fallbacks, but not ordinary associated HTML labels. It reports disabled/focused/editable and native select options; checkbox/radio state and ARIA toggle/expansion state are absent. A value can currently become an input's fallback name, which is different from exposing a separate value field.
- Proposal: add correct associated-label handling and bounded, role-appropriate state before broadening the action API. Investigate a browser-computed AX source for cases where manual naming becomes complex; do not present a partial DOM algorithm as full accessible-name conformance.
- Verify: explicit/wrapped/multiple labels without redundant ARIA, ARIA precedence, checkbox mixed state, radios, toggles, disclosure changes, open shadow roots and password exclusion. Use actual Chromium DOM collection, not only mocked snapshot objects. Existing [evaluation][f-eval] and [kernel fixtures][f-kernel-tests] often supply `aria-label` alongside HTML labels, so they do not establish this behavior.

**OBS-02 — Bounded observations with a way to retrieve omitted content. Adapt; high benefit, medium effort.**

- Upstream: Python [extraction tools][py-tools] offer continuation via `start_from_char`; Pi teaches filtering AX results and targeted extraction rather than repeated full dumps in its [prompt][pi-prompt]. Neither approach needs to be copied literally.
- Freedom: [snapshots][f-page] cap controls at 250, body text at 12,000 characters and native options at 100. There is no continuation/search operation. `truncated` concerns element capacity, not text loss; an otherwise valid snapshot can silently omit the requested text. DOM-order selection can exhaust the control budget before relevant frames/shadow content.
- Proposal: separate control/text truncation metadata; design bounded search or continuation tied to an observation/document identity, with explicit stale handling and per-field limits. Prefer compact default observations plus retrieval over simply raising caps. Distinguish retained observation retrieval from rereading a changed page.
- Verify: useful content after the 250th control/12,000th character, oversized individual names/options, late shadow/frame content, Unicode boundaries, repeatable continuation and navigation/DOM changes between reads. Output bounds must also bound collection work; output truncation alone does not prevent a huge DOM traversal.

**OBS-03 — Viewport, occlusion and page structure. Investigate; medium/high benefit, medium/high effort.**

- Upstream: Python [DOM service][py-dom] combines DOM, AX and layout; the [serializer][py-serializer] uses paint order, hierarchy and scroll hints. The [occluded-text regression][py-paint-tests] prevents covered text from being serialized as available foreground content.
- Freedom: computed style/client rect visibility is not viewport or occlusion classification. Flat text loses structure, while click-time hit testing already rejects obstructed targets. This can produce a discoverable control that cannot be used.
- Proposal: distinguish rendered, in-viewport and obstructed observations; investigate heading/region context and viewport prioritization without making offscreen controls undiscoverable. Avoid importing the entire Python pipeline before measuring collection cost and correctness in Electron.
- Verify: modal over page, sticky header, clipped controls, duplicate labels in distinct regions and offscreen-but-reachable controls. Do not confuse occluded content with secret content or claim paint-order heuristics provide confidentiality.

### Targeting and browser actions

**ACT-01 — Explicit scrolling and text finding. Adapt; high benefit, medium effort.**

- Upstream: Python [scroll/find tools][py-tools] and Harness [scroll recipes][h-scroll] handle viewport and container movement. The [zero-coordinate test][py-scroll-tests] catches a small but useful geometry edge case.
- Freedom: clicking a known reference scrolls it into view and `press` supports PageDown/PageUp. Those do not provide discovery of unmounted virtual-list items or an explicit scrollable-container action; no dedicated scroll/find operation exists in the [contract][f-contract].
- Proposal: canonical bounded scroll and text-search operations, selected through observed page/container identities. Return actual movement/boundary evidence. Read-only text search should not silently become a click or select action. Decide explicitly whether finding text also scrolls.
- Verify: page and nested scrollers, sticky overlays, horizontal movement, virtualized lists, end-of-scroll, zero displacement, cancellation and reacquisition after layout changes. Existing [below-fold click coverage][f-eval] is useful but is not virtual-list scrolling coverage.

**ACT-02 — Richer forms. Adapt selectively; high benefit, medium effort.**

- Upstream: Python [ARIA-menu fixtures][py-menu-tests] distinguish custom menus from native selects. Pi's state tests make the post-action value observable.
- Freedom: native single-select, ordinary click/type/press and semantic ARIA candidates already exist. Multi-select/listbox-specific selection is unsupported; custom menus may be usable via ordinary interaction but must not be described as universally supported.
- Proposal: first improve observation/state and qualify common keyboard/click flows. Add specialized operations only when a fixture demonstrates a missing capability. Preserve native form-effect inspection, exact approved payload checks, trusted input and upload/download gates.
- Verify: controlled inputs, custom combobox, multi-select, disabled options, autocomplete, clipped native checkbox with a visible label, and a menu whose selection navigates. Assert actual DOM/application state, not merely successful dispatch.

**ACT-03 — Frames and shadow roots. Investigate, then adapt; high benefit, high effort.**

- Upstream: Python has explicit frame-tree/AX processing; Harness [frame recipes][h-frames] explain routing to out-of-process frame targets and invalidation after navigation. Those recipes are not proof of Electron compatibility or authority isolation.
- Freedom: same-origin frames and open shadow roots are traversed; cross-origin frames are explicitly reported inaccessible. Existing [evaluation coverage][f-eval] checks that limitation honestly. A frame scan through document `querySelectorAll` also needs qualification for frames nested inside shadow roots.
- Proposal: prototype browser-owned frame observation in the existing adapter. Bind any CDP session/node to the owned tab's actual descendant frame tree, document and origin. Never attach to a target merely because its URL resembles an iframe URL. Define approval/effect attribution to the frame origin before enabling cross-origin actions.
- Verify: same-origin and cross-origin siblings with identical URLs, nested frames, shadow-hosted frames, sandboxed frames, frame detachment/navigation during approval, and no access to unrelated tabs. Account for debugger ownership/detachment and interaction with the existing upload path.

**ACT-04 — Visual targeting. Investigate; valuable fallback, high effort.**

- Upstream: Pi offers coordinate input; Python [coordinate tests][py-coordinate-tests] make support conditional. Freedom's [screenshot tool][f-tools] intentionally supplies observation only.
- Proposal: isolated prototype after semantic improvements. Bind a visual target to an owned tab, document, capture identity, viewport, scale and scroll position. Use browser hit testing/effect classification where possible; define how unknown/canvas targets are approved. A screenshot identifier alone does not establish freshness on an animated page.
- Verify: canvas target, zoom/device scale, pane resize, scroll/layout change, overlay insertion, navigation or cancellation between capture/approval/click, and consequential controls. No raw-CDP or arbitrary-page-JavaScript escape hatch is part of this proposal.

### Timing and recovery

**REC-01 — Wait for outcomes and preserve uncertain effects. Adapt/retain; high benefit, medium effort.**

- Upstream: Pi [recovery tests][pi-recovery-tests] and [agent tests][pi-agent-tests] distinguish provider failures, worker loss, cancellation, partial output and delivery. Its [browser documentation][pi-browser] explicitly warns that failed/timed-out calls can leave browser effects behind.
- Freedom: [adapter waits][f-page] already support bounded load/navigation/text/URL conditions and cancellation; [Pi configuration][f-session] enables bounded provider retry. Provider retry must not become automatic replay of browser mutations.
- Proposal: richer outcome-oriented wait recipes/error hints around actual failures; retain uncertainty explicitly. Review timing around navigation and dynamic controls, rather than introducing arbitrary sleeps or a global network-idle requirement. Keep screenshot failure independent of semantic observation.
- Verify: delayed rendering, long-lived network connections, navigation destroying the execution context, provider failure after a completed action, timeout after submission and Stop during wait. No duplicate submission/download after recovery.

### Agent loop

**LOOP-01 — Detect repeated actions without progress. Adapt; medium/high benefit, medium effort.**

- Upstream: Python [loop-detector tests][py-loop-tests] cover normalized action repetition and page stagnation; the [agent service][py-agent] injects a change-of-strategy nudge.
- Freedom: inspected browser tools/session/service code provides provider retry and recovery guidance; this pass did not find an equivalent browser-progress detector. This is not a claim that all possible loop handling in Pi or Freedom has been audited.
- Proposal: bounded action/outcome fingerprints with a nudge and eventually an explicit blocker. Avoid sensitive payloads in fingerprints/logging. Progress should include observed value, scroll and navigation changes; freshly generated reference strings alone are not stable action identity.
- Verify: repeated unsuccessful click/read, repeating equivalent searches, legitimate repeated scrolling, changing pagination and transient failure recovery. Choose thresholds from fixtures and manual use, not wholesale copying of upstream constants.

**LOOP-02 — Batching and completion evidence. Investigate/retain; medium benefit, medium/high effort.**

- Upstream: Python [batch guards][py-batch-tests] stop queued work after declared navigation/switch/evaluate operations or observed URL/focus changes. Pi [agent tests][pi-agent-tests] prevent mutations after accepted completion and distinguish exhausted budgets from completion.
- Freedom: [controller][f-origin] enforces ownership, approval barriers and fresh observation after resume. [Progress receipts][f-progress] distinguish actions recorded from observing the page after a change. That observation does not independently prove the user's entire task succeeded.
- Proposal: first test existing multi-tool behavior under page changes. Consider safe batching only after observation/action semantics settle. Preserve per-action approvals and partial results. Improve completion criteria/evidence where a task has a deterministic observable outcome; avoid an LLM judge as the authority for sensitive effects.
- Verify: first action navigates and the second has an old reference, same-URL SPA replacement, popup focus change, Stop/approval mid-sequence and unsuccessful application outcome despite a successful click.

### Context management

**CTX-01 — Recover observations without repeating actions. Investigate; high benefit for long tasks, medium/high effort.**

- Upstream: Pi [context handling][pi-context] retains redacted evidence archives alongside fallible summaries. A [targeted agent test][pi-agent-tests] retrieves an omitted count after compaction without repeating the source action. Python [message-state tests][py-state-tests] ensure managers do not share mutable history.
- Freedom: Pi compaction is already enabled. Freedom's [session history][f-history] and restored transcript do not by themselves establish model-accessible retrieval of exact omitted browser observations; that end-to-end path needs a focused audit.
- Proposal: determine what installed Pi already retains before adding storage. If needed, expose bounded conversation-owned observation retrieval, not arbitrary filesystem reads. Preserve observation timestamps/source identity and distinguish historical evidence from current actionable references. Define retention, redaction and deletion with existing conversation lifecycle.
- Verify: exact count omitted by summary, original user constraint contradicting summary, lost archive, two sessions with different data, repeated compaction and stale references recovered from historical evidence. More logging is not automatically better privacy.

### Browser lifecycle

**LIFE-01 — Dialogs, popups and cleanup. Adapt observation; leave out automatic consent; medium/high effort.**

- Upstream: Python's [popup watchdog][py-dialogs] automatically accepts alert/confirm/beforeunload and dismisses prompt. Harness [dialog recipes][h-dialogs] include both CDP handling and page stubbing. Pi [ownership tests][pi-ownership-tests] preserve unrelated tabs/cookies during cleanup and timeout.
- Freedom: owned-tab lifecycle and hidden popup tests already exist in [hidden-page manager tests][f-hidden-tests]; [evaluation][f-eval] checks popup behavior. This pass does not establish complete native JavaScript-dialog coverage across visible and hidden guests.
- Proposal: observe blocking dialog type/source/message and handle it through the existing interaction policy. Test popup adoption/focus and renderer loss. Retain user-owned tabs and existing Stop/takeover semantics. Do not automatically accept confirmation dialogs or replace page confirmation functions with always-true stubs.
- Verify: alert, destructive confirm, prompt, beforeunload with unsaved work, popup during approval, child window closure, crashed guest and cleanup with unrelated user tabs.

### Permissions and trust

**TRUST-01 — Reuse techniques behind Freedom's authority boundary. Retain; ongoing integration requirement.**

- Upstream: Pi [session policy documentation][pi-sessions] distinguishes navigation guards from network isolation; generated Node code has host access. Its [policy tests][pi-policy-tests] cover domain boundaries, popups and secret redaction, which are useful cases to study but not substitutes for Freedom's policy.
- Freedom: canonical operations, task-tab custody, approval revalidation, file pickers, wallet boundaries and distributed protocols are product requirements. A raw browser target ID or page-provided label cannot confer authority.
- Decision: no wholesale Pi/harness replacement or raw-JS/CDP tool at this stage. New browser capabilities remain in the adapter/controller/contract; agent tool descriptions remain clients of that contract. No dependency adoption selected yet.
- Verify throughout: navigation/target replacement during approval, secret/password omission, hostile page instructions, cross-session isolation, hidden/raw URLs, upload/download cancellation and existing wallet gates. Named-secret insertion is a separate future product decision, not implied by form improvements.

### Diagnostics and evaluation

**EVAL-01 — Fixture-driven progress and attributable traces. Adapt; high benefit, medium effort.**

- Upstream: browser and recovery regression tests encode useful failure cases; [recording documentation][pi-sessions] notes that recordings can fail separately from the task and text redaction does not redact pixels.
- Freedom: unit tests and [Electron evaluation fixtures][f-eval] already provide a suitable home. Adapter unit tests mock the isolated-world return value, so snapshot algorithm correctness also requires real DOM execution.
- Proposal: attach an acceptance case to each selected finding, with exact candidate, fixture, runtime, model when used, expected outcome and observed result. Use synthetic local pages and bounded traces by default. Record semantic outcome, unexpected mutations, action count and latency; avoid turning this into the deferred comparative benchmark.
- Verify: positive outcome plus stale/denied/cancelled path for each new operation. Keep evidence of unavailable capability separate from task success. Model-driven smoke complements deterministic browser tests; neither alone establishes broad real-web reliability.

## Selected history lessons

These inspected fixes explain useful regression cases, not defects attributed to Freedom:

| Upstream change | Lesson to carry into Freedom |
| --- | --- |
| Python [occluded text fix][py-paint-fix] | A visibility flag has to survive all the way into model-facing serialization; test the final observation. |
| Python [independent message state][py-state-fix] | Concurrent conversations must not share mutable state through convenience defaults. |
| Python [nested history redaction][py-redaction-fix] | Exercise redaction across nested lists/objects and persisted history, not just immediate tool text. |
| Pi [bounded provider recovery][pi-retry-fix] | Retry selected failed inference under original budgets without executing tools from the failed response. |
| Harness [extension command routing][h-routing-fix] | CDP browser-session and page-session routing differ; generic routing rules need exceptions and tests. |

## Implementation sequence and acceptance gates

| Slice | Findings | Concrete deliverable and exit condition |
| --- | --- | --- |
| 1. Semantic correctness | OBS-01, EVAL-01 | Ordinary labels and control state visible in real Chromium snapshots; precedence, password and stale-reference cases pass. |
| 2. Observation coverage | OBS-02, selected OBS-03 | Honest truncation plus bounded retrieval/search; a target beyond existing caps becomes reachable without unbounded output or stale identity reuse. |
| 3. Actions and dynamic forms | ACT-01, ACT-02, REC-01 | Scroll/find and representative form flows work, report actual outcomes, and retain permission/cancellation behavior. |
| 4. Frame support | ACT-03 | Bounded adapter prototype with owned descendant-frame routing and origin attribution; cross-origin actions only after its negative cases pass. |
| 5. Visual fallback | ACT-04 | Experimental target binding and approval path qualified against scale/layout/staleness races; keep unqualified behavior off the accepted feature path. |
| Follow-through | LOOP-01/02, CTX-01, LIFE-01 | Deepen the relevant audit when evidence warrants implementation. These are recorded opportunities, not forgotten backlog or authorization for a harness rewrite. |

Each slice should form a reviewable commit with its fixture and validation evidence. Extend existing Electron tests where possible; do not add tests that merely mirror code. Before implementation, read the applicable repo playbooks and lint configuration. Run required lint/unit checks after code changes and meaningful real-browser checks for DOM/input changes. No package upgrade is implied; request approval if a selected approach actually needs one.

For live manual acceptance, use a small set of tasks: labelled form, long article with a fact near the end, crowded control list, nested/virtual scrolling, dynamic combobox, framed form, and eventually canvas/visual control. Record actual outcomes and regressions. Cross-project benchmarks, paid provider runs and cloud/browser installations are not prerequisites for this work.

## Open design questions for the next slices

- Can the existing isolated-world collector cover slice 1 cleanly, or is a narrow internal AX query justified? Start with fixtures; preserve browser-computed naming as a candidate rather than prematurely building a complete accessibility engine.
- Should observation continuation use retained immutable snapshots, bounded live queries, or both? Specify retention, freshness and invalidation before exposing cursors.
- How will frame-origin attribution fit current approval UI and native form-effect inspection? Cross-origin observation and cross-origin action need distinct decisions.
- Which trace/history data does installed Pi already retain, and what can the agent retrieve safely? Do not duplicate storage before answering this.
- Are no-progress hints sufficient for small models, or are clearer tool descriptions and smaller observations the larger improvement? Test against demonstrated failures.

## Validation of this audit

Source review only. Upstream tests were read, not run. No benchmark, live-provider/browser task, dependency change or source port was performed. Checked documentation links against the pinned local trees and Freedom files, and checked diff whitespace. The roadmap's historical qualification records remain historical; this document makes no claim that the current checkout's full test suite is green.

## Implementation journal

### Slice 1 — Labels and control state, 2026-09-17

Implemented OBS-01 in the existing page adapter. Native `labels` resolves explicit,
wrapping and multiple labels; ARIA naming retains precedence and shadow-root ID
lookup stays scoped. Snapshot and approval inspection share the naming helper.
Only button-like input values serve as name fallbacks; password, file and ordinary
text-input values are not used as names. Native checkbox/radio state and explicit
role-appropriate ARIA checked/pressed/selected/expanded states are now observed.
Missing/invalid optional state remains absent rather than inventing a value.

This remains a DOM naming fallback, not full accessible-name conformance. Browser
AX integration and advanced custom-element semantics remain investigation items.
No new dependency, permission, IPC channel or general code-execution tool was added.

Validation: the four new real-Electron observation cases failed on the original
implementation and passed after the changes and a test-loader correction. Visible
and hidden pages cover naming precedence, same-origin frames/open shadow roots,
password exclusion, approval labels, native/ARIA state before and after trusted
input, and stale-reference rejection. Both existing automation-kernel E2E cases
also passed (including HTTPS/Swarm/IPFS). Four focused unit suites passed 115 tests;
lint and diff whitespace checks passed. No live model was used; this is source-tree
Electron qualification, not signed-release or cross-platform qualification.

Commands: `npm run test:e2e -- test-e2e/automation-observation.spec.js test-e2e/automation-kernel.spec.js`
(the two label cases were rerun with `--grep 'associated labels'` after correcting
the test's main-process module loader); `npm test -- src/main/automation/adapters/web-contents-page-adapter.test.js src/main/automation/automation-controller.test.js src/main/automation/origin-scoped-controller.test.js src/main/agent/pi-browser-tools.test.js`;
`npm run lint`.

### Slice 2 — Live snapshot search and continuation, 2026-09-17

Extended the existing `browser_snapshot` contract with bounded `query` (control
names only), `elementOffset`, `textOffset`, `documentId` and `navigationId` inputs. The default
response remains 250 controls / 12,000 text characters. It now reports separate
text/control truncation and continuation offsets. Continuation requires the
previous document's opaque ID and navigation counter and rejects a different
document before collection, including another tab with an identical counter.
Each call is a fresh live observation: same-document content can
move, so offsets are not immutable archives or guarantees of stable pagination.
Query filtering helps reach a specific late control without replaying every page.

Collection now uses an element TreeWalker rather than materializing every element
twice with `querySelectorAll`. Our scan is capped at 20,000 elements, 64 frames and
16 levels for frames/shadow roots; retained rendered text is capped at 1,000,000
UTF-16 code units. `scanTruncated`/`textCollectionTruncated` explicitly distinguish
those limits from another retrievable response window. Text windows avoid splitting
surrogate pairs. Browser-owned `innerText` layout cost is **not** a hard-bounded
operation; individual control-name/option-value budgets and total serialized-output
limits remain follow-up work under OBS-02. Do not interpret these changes as a
complete hostile-DOM resource bound or complete accessible-name implementation.

Validation: all **9 Electron cases** in `automation-observation.spec.js` and
`automation-kernel.spec.js` passed together (21.6 seconds). They include controls
past index 250, text past character 12,000, case-insensitive search, an actual trusted
click on the discovered late control, Unicode boundaries, stale continuation and
honest limits on an oversized fixture. The two continuation cases passed again
after adding the per-document identity guard (4.1 seconds).
**5 focused unit suites / 155 tests** passed,
including canonical validation and forwarding through the policy controller; lint
and diff whitespace checks passed. No live model, installed release or other OS
was exercised. Existing approval/custody/action semantics were retained.

Commands: `npm run test:e2e -- test-e2e/automation-observation.spec.js test-e2e/automation-kernel.spec.js`;
`npm test -- src/main/automation/contract/operations.test.js src/main/automation/adapters/web-contents-page-adapter.test.js src/main/automation/automation-controller.test.js src/main/automation/origin-scoped-controller.test.js src/main/agent/pi-browser-tools.test.js`;
`npm run lint`.

### Slice 3 — Output budgets and explicit scrolling, 2026-09-17

OBS-02 follow-through now bounds emitted display fields (2,000 characters; role/tag
128), control entries (128,000 serialized UTF-8 bytes per window), select choices
(8,000 bytes per control), and frame metadata (32,000 bytes before compact identity/
viewport-only entries). Oversized URL identities are omitted at 8,192 characters;
select values are omitted at 2,000 rather than shortened into invalid choices.
`fieldsTruncated`, individual `*Truncated`/`*Omitted` flags and advancing control
continuation report the limits. Small exact options remain actionable. The output
fixture stays under 384,000 serialized bytes; this is not a hard CPU/memory deadline
for Chromium layout, DOM naming or temporary page text. Full-name query matching
can find text beyond the displayed name prefix. Huge names are not fully shown.

`browser_scroll` takes an observed reference, direction and 0.1–3 viewport pages
(default 1). Snapshots expose `frames[].viewport` references/scroll metrics and
nested elements with `scrollable` metrics. Viewport references and plain containers
identified only for scrolling are scroll-only: they cannot become broad click or
keyboard targets. Native controls retain their established interaction references.

The main-process adapter inspects a visible wheel point whose nearest scroll
container matches the requested target, checks ordinary same-origin frame geometry,
rechecks after focus, and sends Electron wheel input. It does not click, select,
set page scroll offsets, or auto-scroll a hidden target into view. Boundary requests
send no input, avoiding wheel chaining at the edge. Results distinguish `moved`,
`boundary` and `no_movement`, with actual before/after positions and a bounded
settling observation (up to one second). No movement is not proof that wheel
handlers had no other effects; only a boundary result is projected as observation.

The operation passes through the existing canonical validation, policy, task-tab
ownership, origin, resume-observation and interaction approval paths. Direction and
amount are included in approval/classification context and declined-action identity.
No dependency, IPC channel or arbitrary code/CDP tool was added. References remain
navigation-bound and point to actual DOM objects; detached targets reject.

Validation: **13 real-Electron cases passed** (31.1s), including all prior observation
and HTTPS/Swarm/IPFS cases, desktop/hidden vertical and horizontal scrolling, trusted
wheel input, nested-list isolation, lazy-loaded content, boundary/no-movement cases,
RTL, same-origin iframe scrolling, covered/detached targets and stale navigation.
After adding scroll-only enforcement, both desktop/hidden scroll cases passed again
(5.7s). **8 focused unit suites / 283 tests passed** (1.4s), including invalid inputs,
policy denial, declined approval, ownership/resume gates, post-focus invalidation,
scroll-only references and honest activity receipts. Lint and diff checks passed.
No live model, signed build or other operating system was tested.

Limits: the nine-point visible-area search is conservative and may decline a usable
container with a narrow exposed area. Transformed ancestor frames are rejected;
cross-origin frame routing and closed-shadow internals are not added. Reverse-flow
vertical scrolling and general geometry/occlusion completeness remain follow-up
work. A changed layout or continuing animation can invalidate the result after
observation; the tool instructs the model to reread, not blindly repeat.

Commands: `npm run test:e2e -- test-e2e/automation-observation.spec.js test-e2e/automation-kernel.spec.js`;
`npm test -- src/main/automation/contract/operations.test.js src/main/automation/adapters/web-contents-page-adapter.test.js src/main/automation/automation-controller.test.js src/main/automation/origin-scoped-controller.test.js src/main/automation/policy-controller.test.js src/main/agent/pi-browser-tools.test.js src/main/agent/agent-progress.test.js src/main/agent/freedom-agent-service.test.js`;
`npm run lint`. Electron wheel API reference: https://www.electronjs.org/docs/latest/api/structures/mouse-wheel-input-event


### Slice 4 — Text finding and dynamic-form waits, 2026-09-17

`browser_snapshot.textQuery` searches literal, case-insensitive rendered text
already collected from the page and accessible frames. It returns a short excerpt,
original-text UTF-16 match offsets and frame attribution. `nextMatchOffset` with the
same document/navigation IDs retrieves another match. Regex syntax is escaped;
Unicode matching does not first lowercase the source and shift its offsets. Search
never spans two frame bodies and never scrolls, focuses or highlights a page. It
retains the collection limits and explicit incomplete-observation flags. Hidden
text is excluded under the existing rendered-text collection semantics; unloaded
content still requires scrolling. This adapts the discoverability goal of upstream
`find_text` without importing its implicit scroll mutation into observation.

Form fixtures exposed a real naming failure: wrapping a label around a native
select included the select's whole option subtree in the name. Associated labels
now omit the labelled control's own subtree (also avoiding textarea contents).
Option observations and selection use Chromium's `:disabled` semantics, including
disabled optgroups. Native single-select listboxes are supported; multi-select
remains explicitly unsupported. Custom ARIA menus use observed trigger/option
references and normal click approval, rather than pretending to be native selects.

`browser_wait` gains `condition: element`, an original reference and a named state:
visible, hidden, enabled, disabled, checked, unchecked, expanded or collapsed.
Observation and waits share the same role-aware checked/expanded state extraction.
Hidden can match a removed original element; a replacement does not inherit its
reference or satisfy enabled. Navigation invalidates the wait even if the old
execution context returns a match. Existing timeout/cancellation behavior is kept;
no selector, JS predicate or arbitrary delay tool is introduced.

Validation: **17 Electron cases passed together** (40.3s). New cases cover literal
search beyond the first text window, punctuation/regex escaping, Unicode before a
match, repeat-match continuation, frame attribution, no scroll, hidden-text
exclusion, wrapping select labels, disabled groups, listboxes and delayed custom
menus in both desktop and hidden modes. The dynamic flow waits for expansion,
clicks an observed option with trusted input, waits for a delayed enabled button,
checks checkbox state, and rejects stale/replaced references. **5 focused unit
suites / 177 tests passed** (1.4s), including input validation, reference invalidation
during an element wait, and cancellation via stop-loading. Lint and diff checks
passed. The initial native fixture failed at the wrapping-label mismatch; the
custom-menu fixture was corrected to distinguish its same-named listbox and option
by role. These are real-browser deterministic fixtures, not live-model acceptance.

Commands: `npm run test:e2e -- test-e2e/automation-observation.spec.js test-e2e/automation-kernel.spec.js`;
`npm test -- src/main/automation/contract/operations.test.js src/main/automation/adapters/web-contents-page-adapter.test.js src/main/automation/automation-controller.test.js src/main/automation/origin-scoped-controller.test.js src/main/agent/pi-browser-tools.test.js`;
`npm run lint`. No dependency, IPC or module-boundary changes.


### Frame routing feasibility probe — test-only, 2026-09-17

`test-e2e/automation-frame-prototype.spec.js` uses disposable HTTPS fixtures in the
installed Electron **43.0.0**. It does not add a product adapter, IPC, model tool or
cross-origin permission. The current product snapshot correctly continues to mark
the cross-origin frame inaccessible and does not return its controls.

Observed routing facts:

- A cross-site child runs in another renderer in this fixture. Root-session
  `Page.getFrameTree` returns only the owner; `Target.setAutoAttach` supplies an
  iframe session that must be passed to child-frame commands.
- `WebFrameMain` exposes native ancestry, stable frame-tree-node identity and
  browser-reported origin, but no `executeJavaScriptInIsolatedWorld` method in this
  runtime. `frame.url` alone is not sufficient for ownership or origin attribution.
- `Page.createIsolatedWorld` in the child session, with `grantUniveralAccess: false`,
  plus `Runtime.evaluate` with its **unique context ID**, reads the actual DOM without
  seeing a page-world sentinel or a page override of `Document.querySelector`.
  The isolated child still cannot read its cross-origin parent document.
- After same-origin child navigation, the session still works but the old unique
  execution context rejects. After removal, the replacement context/session also
  rejects and native ancestry no longer contains the frame.
- Identical resource URLs can identify three distinct owned frames. One sandboxed
  iframe reports origin `null`; a same-URL iframe in another tab fails membership
  in the owner's native subtree. Never infer these facts from URL equality.

Both probe cases passed (4.6s); lint and whitespace checks passed. The initial probe
needed the normal window fixture to finish application startup before using the
harness. Later assertions cover actual isolated reads and invalidation, not only
metadata discovery. This is a one-runtime feasibility result, not a completed
cross-origin integration or a security audit of all CDP routing behavior.

Before production exposure, implement a shared, owned debugger-session lifecycle;
map each observed frame-owner DOM reference to its specific child session/context
without URL/name matching; bind frame and document identities across navigation;
and apply explicit frame-origin policy before observation or action. Opaque origins,
nested process boundaries, redirects, detach/reattach, competing debugger consumers
and existing native upload behavior need negative tests. Cross-origin coordinates
and approval attribution remain unqualified. The experimental probe sends no input
to cross-origin content and is not imported by production code.

References: [Electron WebFrameMain](https://www.electronjs.org/docs/latest/api/web-frame-main),
[Electron Debugger](https://www.electronjs.org/docs/latest/api/debugger),
[CDP Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/),
[CDP Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/).
Command: `npm run test:e2e -- test-e2e/automation-frame-prototype.spec.js`.


### Visual targeting feasibility probe — test-only, 2026-09-17

`test-e2e/automation-visual-prototype.spec.js` adds no production coordinate tool.
It calibrates known screenshot pixels against a synthetic red canvas, with actual
PNG dimensions and a bitmap colour assertion, then verifies the received trusted
click's CSS coordinates at 100% and 150% page zoom. This tests coordinate mapping;
no vision model has selected a target and no resized-provider image is involved.

The experimental binding records owner, document generation, viewport/zoom, full
PNG digest, an opaque token and the actual hit DOM element in an isolated world.
It checks the binding again after simulated changes during an approval pause and
consumes it before dispatch. Full-image equality catches painted/layout changes;
actual-element equality catches transparent overlays that can preserve every pixel.
The token cannot be reused after an attempted click.

**10 cases passed** (22.7s): two zoom mappings with trusted canvas receipts; stale
rejection after scrolling, zoom, layout shift, opaque overlay, transparent overlay,
canvas repaint, resize and navigation. Rejected cases dispatch no click. Initial
positive tests read receipts too early; native input dispatch and JS evaluation
queues are not a completion guarantee. A bounded wait for the actual fixture click
receipt corrected the probe, and both positive cases then passed before the full
matrix was run. Lint and diff checks passed on the new test code.

This is not ready for product exposure. It simulates the approval pause; it does not
exercise Freedom's real approval UI/classifier or add a capability to Pi. The final
check and input dispatch are not atomic. Hover-triggered mutations, DOM mutation
with unchanged pixels/hit identity, image resizing by providers, cross-frame geometry,
closed shadow roots, navigation during dispatch and platform-specific scaling still
need work. Full-image hashing is deliberately conservative and likely rejects
otherwise valid targets on animated pages. Any integration must keep a bounded
server-side capture store, expired/consumed-token rules, independently inspected
consequences and the existing upload/download/wallet/permission boundaries. Prefer
semantic references whenever they represent the intended target.

Command: `npm run test:e2e -- test-e2e/automation-visual-prototype.spec.js`.
Runtime: installed Electron 43.0.0 on macOS; only disposable synthetic fixtures.


### Native input revalidation and one local-model smoke, 2026-09-17–18

A focused follow-through on input freshness found that `type` and `press` could
still dispatch native input when navigation began during asynchronous target
preparation. Two regression tests reproduced success/input dispatch on the old
code when rejection was required. Both now reject before dispatch. The adapter
also checks, without restoring focus, that the original live control is still
focused after preparation (and after webContents focus for key presses). A page
that redirects focus in a microtask no longer receives text or Enter in the other
control. The final check/input boundary is not atomic; this closes the reproduced
race rather than claiming to eliminate all page-driven input races.

**19 browser cases passed** (44.9s), including real desktop/hidden focus redirection
with neither input values nor key receipts changed. **4 focused unit suites / 130
tests passed** (1.4s); lint and whitespace checks passed. These checks retain
existing trusted input behavior and scope/approval handling.

The existing local Ollama endpoint offered `qwen3:8b` (8.2B, Q4_K_M, digest
`500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41`). An opt-in,
disposable-profile test used the actual provider and normal composer to find an
exact synthetic token beyond the first 12,000-character observation window.
**One live-model case passed in 54.5s**, returning `AUTUMN-48-KITE` with successful
snapshot activity. No paid provider, public browsing, copied profile or model
installation was involved. This is one end-to-end acceptance case, not a benchmark
or reliability rate. It does not qualify cross-origin or visual model behavior.

The initial smoke incorrectly called `startAgent(null, ...)`, starting a chat-only
task with no assigned tab. Qwen asked for a URL; that was a test setup error, not a
browser failure. The corrected test starts through the composer and assigns the
current fixture page. Its filler avoids repeating the target phrase, keeping this
a retrieval test rather than a repeated-match stress test.

Commands: `FREEDOM_OLLAMA_TEST_MODEL=qwen3:8b npm run test:e2e -- test-e2e/agent-ollama-live.spec.js --grep 'beyond the first observation'`;
`npm run test:e2e -- test-e2e/automation-observation.spec.js test-e2e/automation-kernel.spec.js`;
`npm test -- src/main/automation/adapters/web-contents-page-adapter.test.js src/main/automation/automation-controller.test.js src/main/automation/origin-scoped-controller.test.js src/main/agent/pi-browser-tools.test.js`;
`npm run lint`. The local-model spec remains opt-in by environment variable.


### Read-only cross-origin frame integration, 2026-09-18

The prototype now has a bounded product path: `browser_list_frames` discovers
frames belonging to the active task tab; `browser_read_frame` reads a listed
frame using the same bounded semantic/text collector, including name filtering,
literal text search and live continuation. Pi receives opaque frame handles,
origin/URL/name metadata and read-only descriptions. Child control/viewport
references are stripped so they cannot accidentally address root-page actions.
No arbitrary script, CDP method, session ID or coordinate parameter is exposed.

The main-process page adapter owns a short-lived debugger connection to its own
WebContents. It recursively attaches only related iframe sessions (including
nested out-of-process frames), never global target lookup or URL matching. A
handle binds frame ID, loader, default execution-context unique identity and
origin; equal URLs do not imply equal frames. The body collector executes in a
fixed isolated world addressed by unique context ID, without universal access.
Its origin must match the authorized default context. Document identity is
rechecked before and after collection, and after asynchronous authorization.

**Native negative evidence changed the implementation:** Electron 43.0.0's
`Page.getFrameTree.securityOrigin` reported the HTTPS URL origin for a sandboxed
opaque frame. The first desktop and hidden tests failed because that metadata
would have granted it ordinary web-origin treatment. Discovery now takes the
effective origin from the browser's default execution-context event, with absent
or opaque context origins treated as `null`; the real sandbox fixtures are denied
before body evaluation. This distinguishes URL metadata from the document's
actual security context. Reference docs: [Runtime execution contexts](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#type-ExecutionContextDescription)
and [Electron debugger sessions](https://www.electronjs.org/docs/latest/api/debugger).

The existing task boundary checks tab ownership, supported web/distributed-web
origins and resume observation requirements. It supplies frame authorization as
host execution context, never tool input. Unscoped reads without that callback
fail closed. Freedom currently has workspace navigation scope, not a separate
per-embedded-site consent policy; this change does not claim to add one.

Discovery retains at most 64 frames/sessions and 128 handles, and emits at most
64 KiB of frame metadata. Reads inherit snapshot bounds. A five-second operation
deadline, one-second evaluation limit, serialized operations and cancellation
release the connection; stopping page loading also cancels active/queued frame
observations. Existing debuggers are neither borrowed nor detached. Protocol
errors are mapped to bounded generic errors. Retained isolated worlds reuse one
host-generated name per adapter rather than allocating a new world every read.
Embedded page activity uses its own title/origin without replacing the cached
parent-tab metadata for later actions.

**21 Electron cases passed (47.2s)**: the new desktop/hidden frame cases plus all
observation and automation-kernel cases. The new cases cover duplicate frame URLs,
nested cross-origin text, page-world prototype overrides, truncated text/search,
opaque sandbox denial, unrelated-tab ownership, absent host authorization,
existing-debugger preservation, navigation/removal invalidation and cleanup.
**8 focused unit suites / 243 tests passed (1.4s)**; lint and whitespace checks
passed. Unit cases also cover navigation during authorization/world creation/read,
origin changes, hung commands, active/queued cancellation, policy dispatch,
continuation validation and progress attribution. Early reruns also corrected a
test expectation that used lowercase rather than canonical uppercase error codes.

Commands: `npm run test:e2e -- test-e2e/automation-frame-observation.spec.js test-e2e/automation-observation.spec.js test-e2e/automation-kernel.spec.js`;
`npm test -- src/main/automation/adapters/owned-frame-observer.test.js src/main/automation/adapters/web-contents-page-adapter.test.js src/main/automation/automation-controller.test.js src/main/automation/origin-scoped-controller.test.js src/main/automation/contract/operations.test.js src/main/automation/policy-controller.test.js src/main/agent/pi-browser-tools.test.js src/main/agent/agent-progress.test.js`;
`npm run lint`.

Limits: this is read-only integration, not cross-frame click/type/scroll support
or visual-target exposure. A busy debugger makes the capability unavailable.
Collection uses live documents rather than immutable text snapshots; Chromium
layout/full temporary strings are not hard CPU/memory bounded. Frame/context
limits can make metadata incomplete; unknown origins remain denied. Qualification
is the installed macOS source-tree Electron runtime, not other platforms, signed
release builds or a real-model embedded-content reliability benchmark. No new
dependencies, user-profile access or public browsing was involved.


### Repetition recovery hints, 2026-09-18

Deeper inspection of the pinned Python `ActionLoopDetector`, its tests and agent
integration confirmed that upstream uses soft guidance, not an action veto. Its
fingerprints include page URL/text/count and normalized attempts. Freedom adapts
the idea in the Pi tool adapter; automation policy and Pi reasoning keep their
existing responsibilities. No upstream implementation was copied.

A bounded tracker now adds a model-facing hint on the fourth and eighth identical
returned observation, repeated equivalent retryable attempt, or repeated scroll
boundary/no-movement outcome. New ephemeral element/frame reference strings do
not count as progress. Literal search comparison normalizes case/whitespace while
preserving word order and punctuation. Document/URL/text/control/focus/scroll
changes and different continuation windows reset matching observations; measured
scroll movement and successful typing/selection/wait/navigation receipts also
reset the relevant streak. It does not automatically retry, terminate a task,
grant permission, change a tool's success/failure, or claim the user goal is done.

Guidance explicitly distinguishes an unchanged returned observation from evidence
about an interaction's side effects. Retry hints cover only selected retryable
browser errors; permission/cancellation/privileged operations never receive them.
The canonical envelope and UI receipt remain unchanged. Stop, close, idle gaps
and new tool sessions reset history; malformed advisory evidence fails open for
bookkeeping without changing an executed tool outcome.

Tracker retention is limited to eight pages, 512 reference digests per page and a
20-attempt window. All retained payload/observation/reference fingerprints use a
private random per-tool-session HMAC key. The tracker keeps no raw page bodies,
URLs, typed values or persistent/linkable hashes, and includes none in guidance.
This is additional tracker retention only; it does not change ordinary model
context or existing conversation persistence.

**5 focused unit suites / 174 tests passed** (including service/session/progress
integration); lint and whitespace checks passed. **One native integration case
passed in 2.9s** using actual installed Pi tool definitions, the scoped canonical
controller and five trusted Electron clicks with five independent approvals.
The fixture records each click without changing visible prose. Its first click
changes focus, correctly resetting the fingerprint; four subsequent matching
focused observations produce one hint. Stop resets the hint state. Exact native
receipts prove the tracker neither duplicated input nor skipped approval.

The initial native test expected the fourth total read to trigger; inspection
showed the first focus change was real progress in the returned observation.
The test now includes that transition rather than weakening the fingerprint.
Unit coverage includes fresh reference identities, literal searches, changed
state/navigation/focus, pagination, distinct controls/errors/typed values,
transient failure recovery, scroll boundaries/movement, session isolation,
bounded old-history eviction and unchanged error/envelope semantics.

Commands: `npm run test:e2e -- test-e2e/automation-recovery.spec.js`;
`npm test -- src/main/agent/browser-recovery-tracker.test.js src/main/agent/pi-browser-tools.test.js src/main/agent/freedom-agent-service.test.js src/main/agent/pi-session-factory.test.js src/main/agent/agent-progress.test.js`;
`npm run lint`.

Limits: thresholds are provisional fixture-backed choices, not a measured model
reliability improvement. This detects selected repetition patterns, not every
semantic cycle or all unseen side effects; animated text and changing windows
can reset it. Different observation scopes are not treated as equivalent merely
because their excerpts match. Historical/stale references never gain authority
from the tracker. Stronger stop/blocker policy and long-session context recovery
remain separate work. No paid model, public browsing, dependency or user profile
was involved in this slice.


[py-root]: https://github.com/browser-use/browser-use/tree/d8110c5ff87ccba887aaa726cdb780f2f84bef8d
[pi-root]: https://github.com/browser-use/browser-use-pi/tree/fa838f3298673950923bdaf12bd3c1b6279cd119
[h-root]: https://github.com/browser-use/browser-harness-js/tree/2d9a5ed37ed11f31b2622cd69c4b55f979cb905f
[py-dom]: https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/browser_use/dom/service.py
[py-serializer]: https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/browser_use/dom/serializer/serializer.py
[py-tools]: https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/browser_use/tools/service.py
[py-agent]: https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/browser_use/agent/service.py
[py-paint-tests]: https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/tests/ci/test_dom_paint_order_serialization.py
[py-scroll-tests]: https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/tests/ci/test_actor_mouse_scroll_anchor.py
[py-menu-tests]: https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/tests/ci/interactions/test_dropdown_aria_menus.py
[py-coordinate-tests]: https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/tests/ci/test_coordinate_clicking.py
[py-loop-tests]: https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/tests/ci/test_action_loop_detection.py
[py-batch-tests]: https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/tests/ci/test_multi_act_guards.py
[py-state-tests]: https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/tests/ci/test_message_manager_state_isolation.py
[py-dialogs]: https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/browser_use/browser/watchdogs/popups_watchdog.py
[pi-page]: https://github.com/browser-use/browser-use-pi/blob/fa838f3298673950923bdaf12bd3c1b6279cd119/src/page.ts
[pi-prompt]: https://github.com/browser-use/browser-use-pi/blob/fa838f3298673950923bdaf12bd3c1b6279cd119/src/prompt.ts
[pi-context]: https://github.com/browser-use/browser-use-pi/blob/fa838f3298673950923bdaf12bd3c1b6279cd119/src/context.ts
[pi-ax-tests]: https://github.com/browser-use/browser-use-pi/blob/fa838f3298673950923bdaf12bd3c1b6279cd119/test/accessibility-state.test.mjs
[pi-recovery-tests]: https://github.com/browser-use/browser-use-pi/blob/fa838f3298673950923bdaf12bd3c1b6279cd119/test/recovery.test.mjs
[pi-agent-tests]: https://github.com/browser-use/browser-use-pi/blob/fa838f3298673950923bdaf12bd3c1b6279cd119/test/agent.test.mjs
[pi-ownership-tests]: https://github.com/browser-use/browser-use-pi/blob/fa838f3298673950923bdaf12bd3c1b6279cd119/test/ownership.test.mjs
[pi-policy-tests]: https://github.com/browser-use/browser-use-pi/blob/fa838f3298673950923bdaf12bd3c1b6279cd119/test/policy.test.mjs
[pi-browser]: https://github.com/browser-use/browser-use-pi/blob/fa838f3298673950923bdaf12bd3c1b6279cd119/docs/browser.md
[pi-sessions]: https://github.com/browser-use/browser-use-pi/blob/fa838f3298673950923bdaf12bd3c1b6279cd119/docs/sessions.md
[pi-bench]: https://github.com/browser-use/browser-use-pi/blob/fa838f3298673950923bdaf12bd3c1b6279cd119/docs/benchmarks.md
[h-scroll]: https://github.com/browser-use/browser-harness-js/blob/2d9a5ed37ed11f31b2622cd69c4b55f979cb905f/interaction-skills/scrolling.md
[h-frames]: https://github.com/browser-use/browser-harness-js/blob/2d9a5ed37ed11f31b2622cd69c4b55f979cb905f/interaction-skills/cross-origin-iframes.md
[h-dialogs]: https://github.com/browser-use/browser-harness-js/blob/2d9a5ed37ed11f31b2622cd69c4b55f979cb905f/interaction-skills/dialogs.md
[py-paint-fix]: https://github.com/browser-use/browser-use/commit/c84149c27f3eb3d9f8384252d696c298d3624491
[py-state-fix]: https://github.com/browser-use/browser-use/commit/50e2dd184dd04a018feb85fe9c2c0c41d5483111
[py-redaction-fix]: https://github.com/browser-use/browser-use/commit/63d13371fb4618b62306f834245967e42bd0250e
[pi-retry-fix]: https://github.com/browser-use/browser-use-pi/commit/416b9906f0dbb5784ea4aa162345453842c260c3
[h-routing-fix]: https://github.com/browser-use/browser-harness-js/commit/2d9a5ed37ed11f31b2622cd69c4b55f979cb905f
[f-page]: ../src/main/automation/adapters/web-contents-page-adapter.js
[f-contract]: ../src/main/automation/contract/operations.js
[f-tools]: ../src/main/agent/pi-browser-tools.js
[f-origin]: ../src/main/automation/origin-scoped-controller.js
[f-session]: ../src/main/agent/pi-session-factory.js
[f-history]: ../src/main/agent/session-history-store.js
[f-progress]: ../src/main/agent/agent-progress.js
[f-eval]: ../test-e2e/agent-evaluation.spec.js
[f-kernel-tests]: ../test-e2e/automation-kernel.spec.js
[f-hidden-tests]: ../src/main/automation/hidden-page-manager.test.js
