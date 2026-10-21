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
directly for language, retention preferences and local downloads. AI settings
has a separate Models & providers page, with individual connection pages.
Voice dictation lists local and connected services as cards, marking the service
in use. Open a service for its model, billing, audio privacy and a “Use for
dictation” action. “Add service” lists the supported API providers and links to
their connection settings. Language is shared across services; OpenRouter's
retention control stays on its detail page. Local download/progress/cancellation
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
its actual audio destination. Connection policies are checked against the exact
speech model/endpoint, not the selected chat model. As checked on 2026-10-21,
[Venice classifies Whisper Large V3 as Private](https://docs.venice.ai/models/speech-to-text),
and [NEAR documents its Whisper endpoint as TEE-hosted](https://docs.near.ai/cloud/guides/specialized-endpoints).
Therefore Venice's Private setting and NEAR's TEE setting allow these speech
models. These are provider claims, not independent attestation of audio requests.
Venice's TEE-only setting still blocks its non-TEE Whisper model. A generic
“not independently verified” label is not a reason to reject a model that meets
the same provider-classification policy used for chat.

**OpenRouter's transcription endpoint does not enforce per-request retention
routing**, unlike its chat API. With the default “Require zero data retention”
preference, OpenRouter dictation is unavailable and no audio is uploaded. Users
can explicitly turn that preference off on its Voice detail page to use standard
routing. A connection-level ZDR requirement remains locked and cannot be weakened
there. Merely adding `zdr`, `data_collection` or `require_parameters` to an audio
request would not establish retention protection. See OpenRouter's explicit
[transcription routing limitation](https://openrouter.ai/blog/tutorials/transcription-on-openrouter/).

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
about 230 MB once, verifies pinned SHA-256 hashes and installs files in the active
profile's Agent data directory. No Ollama, terminal setup or Python installation
is needed. After a download, click the microphone again to start; completion never automatically enables capture. Downloading never happens on browser startup or while AI is off.

The engine is sherpa-onnx 1.13.8 with the multilingual Whisper Base model using
quantized ONNX weights. This was selected for the draft because upstream provides
native desktop binaries; it avoids requiring a local whisper.cpp compiler build.
No npm dependency was added. Apache-2.0/MIT notices accompany the downloaded
installation. See [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) and
[Whisper](https://github.com/openai/whisper).

Audio stays on this device during local transcription. A private temporary WAV
lives in the profile-owned scratch directory and is removed on completion or cancellation; abandoned phrase directories are swept on startup; raw audio is not saved in conversation
history. Sending the resulting prompt subsequently shares its text with the chat
provider in the ordinary way.

Local Whisper uses the same pause/six-second segmentation as the file-based cloud
services. It currently starts native inference for each phrase. On the development
Mac, two four-second English sample segments completed in 486 ms and 379 ms,
including startup; this is not a cross-device or accuracy guarantee. A persistent
private worker remains a follow-up: the upstream prebuilt WebSocket server binds
all interfaces and provides no authentication, so Freedom does not start it.

Runtime downloads are mapped for macOS arm64/x64, Linux x64/arm64 and Windows x64.
Unsupported architectures are marked unavailable. Native installation and
inference have been exercised on macOS arm64; Windows/Linux local inference and
signed-package behavior still need qualification before release.

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
  silently switching the audio destination. Each blocked service explains the setting
  responsible; its menu row opens that service’s Voice settings
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
