# Browser-agent improvements: Browser Use reference audit

Date: 2026-09-17
Status: first-pass source audit complete; implementation and live qualification pending
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
