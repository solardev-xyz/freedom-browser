# AI entry points and dictation review — 2026-10-20

Scope: `e71c5f62..112d016c`, followed by the repair diff on
`experiment/agent-dictation`. Covers opt-in AI Settings, provider subpages,
start-page invitation, example prompts and dictation/service management.
Reviewer: existing Claude agent through Herdr, pane `w1:pB`. Implementation and
independent verification: Codex. Neither agent used real microphone capture,
paid inference, user profiles, publication or wallet transactions for this review.

## First pass and disposition

Claude found three medium and nine low issues. Findings were checked against
source; cancellation/install and queued-upload cases also had reviewer probes
using fake stores/fetch, without network or capture.

| ID | Finding | Repair / evidence |
| --- | --- | --- |
| M1 | Approval requests discarded already dictated guidance | Approval interruption stops capture, preserves completed phrases and names the interruption; explicit Cancel/Escape still restore the original draft. Regression test covers late events. Idle setup/downloads are not cancelled by an approval. |
| M2 | One-click examples implicitly shared the active browser page | Example submissions explicitly omit page context, while staged user attachments still pass through normal submission. UI tests check both and single submission. Ordinary manually submitted prompts retain existing page-context behavior. |
| M3 | Language changes could replace a disconnected saved service with the suggested provider | Main accepts preference-only updates; Settings sends only the edited field. Saved unavailable destination remains saved and microphone opens setup. Main and renderer regression tests cover this. |
| L1 | Choosing any preference cancelled every installation/recording | Preference changes do not cancel installations or unchanged sessions. Affected recording stops with completed text preserved. Test holds a download open across first-use/save and checks its signal. |
| L2 | Stop flush failure left queued audio uploads running | Session teardown always aborts its controller. Eight-queued-phrase regression verifies no subsequent upload/late transcript after failed flush. |
| L3 | Download completion could automatically start microphone capture much later | First-use local setup reports ready and requires another microphone click after installation. Regression test resolves a delayed install and checks zero begin/capture calls. |
| L4 | Dictation disabled Stop/Resume along with Send | Only submission is disabled by capture; explicit Stop/Resume interrupts dictation safely before acting. |
| L5 | Each 100 ms PCM frame read/decrypted provider state and checked local files | Per-frame connection reads removed. Credentials/policy are checked at session/phrase boundaries; provider-change notification revokes cloud sessions. Test checks no provider-selection/model-file reads for frames and immediate revocation on notification. |
| L6 | Local WAV survived crashes in the global temp directory | Use profile-owned phrase scratch, clean in normal teardown, sweep only known generated directories on startup. Cleanup failure does not prevent browser startup and refuses local inference. Tests cover stale cleanup. |
| L7 | Audio retention flags differed from chat | **Superseded by primary-source correction:** OpenRouter audio does not implement per-request retention routing. Block OpenRouter capture while retention is required; allow only explicit standard-routing opt-out, preserving connection-level ZDR. Test verifies no capture/upload before opt-out. |
| L8 | Unused whole-recording IPC exposed a second privileged path | Removed channel, preload method, handler and legacy whole-recording service path. Tests exercise the actual append/finish pipeline and assert old channel absence. |
| L9 | Voice preferences were unsearchable before visiting their pages | Stable route metadata indexes Language and OpenRouter retention without first visiting Voice. Live control rows supersede metadata; highlighting never targets hidden metadata. Electron regression starts from a fresh Settings page. |

Microphone tooltip/accessibility label names the effective destination and whether
audio stays local or is sent to the service. Settings marks the automatic ready
choice in use. This keeps the approved immediate first-use interaction while
making the audio destination discoverable before capture. Private/TEE-only
connections are conservatively unavailable when the separate audio endpoint's
policy cannot be established.

## Important provider qualification correction

OpenRouter's [official transcription guide](https://openrouter.ai/blog/tutorials/transcription-on-openrouter/)
says chat-style per-request routing/data-policy fields do not apply to
`/audio/transcriptions`. Adding `zdr`, `data_collection` or `require_parameters`
would not establish audio protection. The repair therefore refuses the unsupported
policy before microphone capture; it does not claim a successful HTTP response
proves retention. Maintainer OpenRouter smoke confirmed transcription before this
correction, not retention enforcement.

Current [OpenAI live transcription documentation](https://developers.openai.com/api/docs/guides/realtime-transcription)
confirms the model/session structure used by the live adapter. Documentation
verification and fake WebSocket event tests do not replace a paid live-service
smoke. No such request was run during this overnight review.

## Validation and remaining qualification

- `npm run lint`: clean.
- Full unit run after repair: 473 suites / 10,652 tests passed; 129 tests skipped.
- Electron: 18 relevant tests passed across dictation, AI onboarding and example
  prompts using disposable profiles, fake providers and generated audio. Covers
  both themes, narrow views, browser history, first-visit Settings search,
  retention capture gate, live/phrase transcripts, cancellation and draft safety.
- Screenshots of Voice overview/detail inspected in both themes. This does not
  update the canonical Linux screenshot baselines.
- Windows install fixture verifies dependent DLL placement beside the executable
  without replacing archive-provided bin DLLs. It does not qualify actual Windows
  inference, code signing, packaging or microphone hardware.

Material remaining work: real microphone/TCC denial and device-loss flows; live
OpenAI/Venice/NEAR transcription access and quality; local runtime/package checks
on macOS x64, Linux x64/arm64 and Windows x64; Linux tar/bzip2 prerequisites and
extraction limits on slower machines; Settings screenshot-tour/baseline refresh.
These stay tracked in AI4 and are not represented as completed by this review.

The first full unit attempt hit sandbox-denied localhost fixtures and was stopped;
the required run outside those socket restrictions passed. An Electron regression
first exposed missing first-visit search indexing, which was repaired; a later
assertion was corrected to recognize the automatically selected service. The
final 18-test run passed. Unrelated existing test-process listener warnings remain.

## Follow-up review

Claude completed a second pass, then a final focused pass through Herdr. Its final
verdict: **R1–R5 fixed; no remaining actionable defects in the current diff.** The
last pass was source review, not a claim that Claude reran our tests.

The second pass caught five remaining details, all addressed:

- R1: Windows install tolerates a missing lib directory and pre-existing bin DLLs;
  fake archive verifies dependent placement and preserves archive bin copies.
- R2: only service/language changes (and OpenRouter-specific retention) stop
  affected capture. A memory-only connection fingerprint compares kind, key and
  policy, so model/favourite/test-prompt changes no longer interrupt dictation.
- R3: startup sweep errors cannot escape runtime construction; local inference
  refuses unsafe/unavailable scratch instead. Test covers a non-directory path.
- R4: blocked first-use setup explains the policy and links straight to the
  relevant Voice service page; generated-audio Electron test checks the route.
- R5: hover/focus refreshes the destination label; a microphone click also updates
  it from fresh state before capture. Regression covers local-to-cloud change.

Live transcript ordering also falls back to commit-acknowledgement order when
OpenAI omits predecessor metadata, while respecting explicit predecessor IDs.
A two-turn regression verifies final replies arriving out of order.

Nonblocking limitation recorded by Claude: a failed local scratch sweep is refused
at inference time, but installed files can still make the service appear ready.
This could be surfaced earlier in local service status as future polish. It does
not weaken the storage/capture boundary or block browser startup.

Claude also checked the domain research plan: considered its typed wallet boundary,
private commit-secret handling, uncertain-dispatch reconciliation and fork-only
qualification sound. Its documentation nits were applied: dated handoff and an
explicit requirement for host-rendered semantic wallet approvals.


## 2026-10-21 maintainer-smoke follow-up

The private/TEE gate accepted in the overnight review was overly broad: it
rejected every private/TEE connection without checking its transcription model.
Primary documentation lists Venice Whisper as Private and NEAR Whisper as
TEE-hosted. The 2026-10-21 correction permits those matching provider-classification
policies, explicitly retaining the distinction from independently verified audio.
Venice Whisper still cannot satisfy TEE-only; OpenRouter still cannot satisfy
its retention requirement. “Unavailable” was replaced by the specific policy
block label. A remembered blocked service opens the compact menu rather than
repeating onboarding, and changing its audio destination requires explicit choice.
The first-pass acceptance above is historical and does not establish that the
former blanket gate was justified.

Validation of this correction: lint clean; full unit suite 473 suites / 10,657
tests passed; all 10 dictation Electron tests passed with fake providers and
generated audio. The mixed-policy case preserves all three connection policies,
requires explicit alternative selection, completes a phrase, and checks both
themes and narrow layout. No live-provider inference was used for this regression.
