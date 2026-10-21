# Agent dictation (experimental)

The microphone in the composer turns speech into editable text. Click to start,
click again to finish, then review the text and send it normally. Escape or Cancel
discards a recording. Dictation also works when composing guidance for a running
Agent task.

The microphone starts immediately with a remembered dictation service. On first
use it selects the active provider when supported, otherwise the first suitable
connected API-key service, and remembers that choice. OpenAI, OpenRouter, Venice
and NEAR AI are supported. With no saved choice or suitable ready connection it opens setup, including
the optional local download. If a saved service is blocked or disconnected, the
microphone instead opens the compact service menu with an explanation. Selecting
a ready alternative there starts dictation; selecting from the chevron alone
only changes the saved service. The arrow beside the microphone opens a compact
service menu with the active choice checked; switching service does not start
recording. **Voice dictation settings…** opens Settings → AI → Voice dictation
directly for language, audio privacy information and local downloads. AI settings
has a separate Models & providers page, with individual connection pages.
Voice dictation lists local and connected services as cards, marking the service
in use. Open a service for its model, billing, audio privacy and a “Use for
dictation” action. “Add service” lists the supported API providers and links to
their connection settings. Language is shared across services; OpenRouter's
separate audio disclosure stays on its detail page. Local download/progress/cancellation
live on the local detail page and require an explicit download action.
Breadcrumb links and browser Back/Forward navigate between these pages. An
uninstalled local choice also opens those settings instead of starting a download
from the menu. The conversation model stays
unchanged. Subscription connections do not establish transcription
access and are not offered as speech services. Meta, xAI and custom transcription
endpoints are outside this first draft.

## Cloud transcription

Audio is sent to the chosen service **while you speak**, and text appears in the
composer before Stop. OpenAI uses its live transcription WebSocket API with
provisional text and corrected final transcripts. OpenRouter, Venice and NEAR
receive short audio segments at pauses (about 600 ms of quiet), or at six seconds
of uninterrupted speech. These are phrase updates, not word-by-word streaming;
their delay depends on the provider. Earlier phrases are never re-uploaded.

Requests contain only audio, speech-model settings and the language hint.
Chat history, project files and attachments are not included. Usage is billed to
the selected service. There is no automatic fallback to a different destination.
Cancel stops further uploads and restores the original draft, but cannot recall
audio already sent. A service failure keeps completed phrases so they can be
edited or sent manually, and drops any unfinished provisional tail. An approval request or a service/language change stops dictation while keeping completed text. Unrelated preference saves do not cancel model downloads or unaffected recordings.

The selected chat model's end-to-end encryption and hardware checks do not cover
these audio uploads. The microphone tooltip/accessibility label, chooser and recording indicator name
its actual audio destination. Connections supply credentials and billing; their
chat routing/model policies do not filter or change this separate audio service.
As checked on 2026-10-21,
[Venice classifies Whisper Large V3 as Private](https://docs.venice.ai/models/speech-to-text),
and [NEAR documents its Whisper endpoint as TEE-hosted](https://docs.near.ai/cloud/guides/specialized-endpoints).
These are provider claims, not independent verification of audio requests. The
conversation privacy shield explicitly excludes dictation audio.

### OpenRouter's first-use audio choice

OpenRouter is available for dictation even when chat requires zero retention.
Its transcription endpoint uses standard routing and cannot apply the
[per-request data policies supported by chat](https://openrouter.ai/blog/tutorials/transcription-on-openrouter/).
Voice settings therefore show **Audio privacy** as factual information, without a
retention toggle. Chat zero-retention requirements remain unchanged.

Before OpenRouter's first recording, the microphone displays **Use OpenRouter for
dictation?** with its audio destination, standard-routing limitation and billing.
**Use OpenRouter** records a profile-local audio acknowledgement, then starts
capture. **Choose another service**, **Cancel** and Escape capture/upload nothing.
After acceptance, future microphone clicks start directly. The Voice detail page
can also record this acknowledgement with **Use with standard routing**, without
starting capture. Switching through the chevron alone never records acceptance or
starts the microphone.

Main enforces the acknowledgement before granting capture and before uploads;
renderer state or a stale dialog cannot bypass it. Acknowledgement survives
restart in `dictation.json`, independently from chat connection/session policy.
Legacy `requireZeroRetention` values are not treated as audio consent; existing
users receive the one-time explanation. Merely selecting OpenRouter or returning
its public preference state to `choose` cannot grant consent. Chat privacy/model
changes do not interrupt audio; removing/changing the actual credential does.

The composer models are `gpt-live-transcribe` for OpenAI and
`openai/whisper-large-v3` for the other three services. These are separate from
the Agent model catalogue. Reference documentation:

- [OpenAI transcription](https://developers.openai.com/api/docs/guides/transcription)
- [OpenAI live transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [OpenRouter transcription and retention routing](https://openrouter.ai/docs/guides/overview/multimodal/stt)
- [Venice transcription](https://docs.venice.ai/api-reference/endpoint/audio/transcriptions)
- [NEAR specialized endpoints](https://docs.near.ai/cloud/guides/specialized-endpoints)

## On this device

Choose **On this device**, then **Download & use on this device**. Freedom downloads
about 150 MB once: multilingual Whisper Base, in the format published by the
whisper.cpp project. The model revision and SHA-256 are fixed in
`src/shared/dictation-runtime.js`, and the installer verifies the hash before
atomically making it available. Files live in the active profile's Agent data
directory. After downloading, click the microphone to start: completing a download
never enables capture automatically. No Ollama, Python, or compiler is needed by
users. Model downloads never happen at app startup or while AI is off.

The engine is [whisper.cpp](https://github.com/ggml-org/whisper.cpp) 1.9.5, built
from source revision `d1be6fde11ac6e0407606b4e42fe72d34add8037`, with a separately
pinned source-archive SHA-256. `scripts/build-dictation-runtime.js` builds the
offline CLI and bundles it under `resources/dictation-runtime/`.
It does not download executables on the user's machine. Builds disable CURL,
server examples and host-specific CPU instructions. On x64, upstream CPU feature
detection selects a bundled SIMD backend (including AVX2) with a baseline fallback;
ARM64 uses a single linked CPU backend. Only those source-built libraries ship.
The child receives no backend/library-path environment overrides and runs from
a private audio directory, away from user project files. This integration uses
CPU inference (Accelerate on macOS). No new npm
dependency was added. MIT/MIT-0 notices for the engine, utilities, and Whisper
ship beside the helper and the downloaded model.

The model is downloaded from the [ggerganov/whisper.cpp model repository](https://huggingface.co/ggerganov/whisper.cpp),
which upstream's own model downloader uses, at revision
`5359861c739e955e79d9a303bcbc70fb988958b1`. It is the project's conversion of
OpenAI's model, not a direct download of the original OpenAI checkpoint. Existing
sherpa-onnx draft files are preserved but no longer executed; a new model download
is required after switching engines. The saved local service/language stays selected.

Local inference is designed to need no network service, and Freedom sends no
local recording to a transcription API. The CLI is currently an ordinary child
process, not an OS-sandboxed worker; local-only behavior still trusts the built
source. A private temporary WAV lives in the profile-owned scratch directory and
is removed on success, failure, or cancellation; abandoned phrase directories are
swept at startup. Raw audio is not saved in conversation history. Sending the
resulting prompt shares its text with the chat provider normally.

Whisper uses pause/six-second segmentation. Freedom starts a CLI process for each
phrase and reads plain text from stdout; no localhost server is started. Keeping
the model loaded in a private persistent worker remains a performance follow-up.

Build targets are macOS arm64/x64, Linux arm64/x64 and Windows x64. Other targets
are unavailable. Native qualification uses public audio through the real model
installer and CLI adapter, including cancellation, invalid audio and cleanup.
The workflow `.github/workflows/agent-dictation-native.yml` repeats that check on
all five targets. Physical microphone quality/permissions and signed-package
qualification are separate from these finite native checks.

Developers need CMake 3.16+ and a C++ toolchain (MSVC on Windows). Run
`npm run build:dictation`; `npm start` and packaging prepare the same artifact
and reuse it when the source/recipe/notices/binary hashes match. `CMAKE` can name
an explicit CMake executable. Cross-OS builds are refused; macOS can build either
supported architecture. Artifacts live under `out/dictation-runtime/<os>-<arch>/`;
packaged apps use only their bundled helper, with no development fallback.

## Draft behavior and qualification

- Recordings are capped at two minutes. Text appears during recording; Stop
  flushes the remaining audio and waits for its final text
- Recording and transcription block Send. Draft text, cursor selection and
  attachments are preserved; the transcript replaces the original selection
- Closing Agent, changing conversation, disabling AI, cancelling or losing the
  microphone releases capture and prevents a late transcript entering another draft
- Microphone denial and no-speech recordings leave the draft unchanged. A provider
  failure preserves completed phrases. No other service is selected after failure
- A remembered service that becomes unavailable opens the compact menu rather than
  silently switching the audio destination. Each service presents its own audio capability/disclosure; chat privacy
  settings are not used as audio availability restrictions
- Chromium capture uses an AudioWorklet, with resampling outside the renderer
  thread. Native inference runs in a separate process

Automated tests exercise ownership, audio validation, retention routing, safe
error responses, cancellation, native-download integrity, first-use choice,
actual Chromium AudioWorklet capture with generated audio, cloud upload to a
local fixture, live WebSocket deltas/final ordering, pre-Stop phrase updates,
editable insertion, both themes and narrow windows. A local native
install/inference smoke used the upstream English sample without sending audio
to a provider. Actual microphone hardware/TCC prompts, English/German accuracy
and the four live cloud services remain maintainer smoke tests.

## 2026-10-20 review qualification

Claude reviewed AI1–AI4 through Herdr at `112d016c`. Repairs cover approval-time
text preservation; example prompts starting without implicitly sharing the active
page; preference-only saves preserving an unavailable remembered service;
installation/recording cancellation isolation; aborting queued uploads after a
Stop failure; no microphone auto-start after a download; available Stop/Resume;
removing synchronous credential/model-file work from each PCM frame; private
scratch cleanup; removal of the unused whole-recording IPC; and stable Settings
search entries. OpenRouter retention behavior was corrected against current
primary documentation rather than assuming chat routing flags work for audio.

OpenAI's current documentation confirms `gpt-live-transcribe`, 24 kHz PCM and the
session shape used here; that documentation check is not a live microphone/provider
qualification. OpenRouter's maintainer smoke predates the corrected retention gate.
Venice/NEAR live audio, packaged local runtimes outside macOS arm64, real microphone
permission denial/device loss, and the Linux Settings screenshot-tour update remain
explicit qualification work. No paid-provider queries or real capture were run
while the maintainer was away.

## 2026-10-21 availability regression correction

The overnight review introduced an overbroad private/TEE gate. It incorrectly
marked documented Private Venice speech and TEE NEAR speech unavailable, alongside
the separately valid OpenRouter retention block. The adapter now evaluates the
speech model's documented classification and keeps the distinction between a
provider claim and independent verification explicit. No chat privacy settings or
saved audio destinations are changed by this fix. OpenRouter retains its existing
retention requirement, with “Blocked by retention setting” instead of a generic
service failure. The mixed three-provider combination is covered by service tests
and disposable-profile Electron tests, including explicit alternative selection,
record/finish, both themes and preserved connection policies.

## 2026-10-21 approved privacy scope redesign

Following maintainer discussion, the provider-wide privacy inheritance described
in the earlier review is superseded. Chat policy belongs to chat requests; audio
has its own capability/disclosure and a first-use acknowledgement where needed.
OpenRouter is available with standard audio routing even for a ZDR chat connection.
No chat policy is weakened and no audio is uploaded before its separate choice.
The former disabled Voice retention switch and chooser checkbox are removed.

Validation: lint passes; the full unit suite passes (10,661 tests), and all 10
dictation Electron scenarios pass. Disposable-profile checks cover consent before
capture, cancel/alternative selection, remembered consent, Settings acknowledgement
without capture, and unchanged chat policies. The consent and Audio privacy screens
were visually checked in both themes. Audio and provider responses in these tests
are synthetic; live-provider and physical-microphone qualification remains separate.

## 2026-10-21 whisper.cpp replacement

At the maintainer's request, the sherpa-onnx draft runtime and ONNX model are
superseded by a bundled, source-built whisper.cpp CLI and separately downloaded
Whisper Base model. Earlier sherpa timings and qualification apply only to the
historical draft, not this replacement. The cloud dictation paths are unchanged.

Replacement validation: lint and all 10,672 unit tests pass; all 10 dictation
Electron scenarios pass. Native installer/transcription/cancellation/invalid-audio
cleanup pass on macOS arm64 and Linux arm64 (Docker). macOS x64 compiles; this
Mac lacks Rosetta, so its executable was not run here. Five-target CI results
are recorded separately after completion. Real microphone and signed-package
checks remain distinct from the synthetic/audio-file checks.

The first five-target workflow passed functionally, but exposed slow scalar x64
inference. That build is superseded by upstream CPU dispatch with bundled baseline
and SIMD backends. Qualification and timings for the corrected build follow.
