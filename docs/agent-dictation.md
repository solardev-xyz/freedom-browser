# Agent dictation (experimental)

The microphone in the composer turns speech into editable text. Click to start,
click again to finish, then review the text and send it normally. Escape or Cancel
discards a recording. Dictation also works when composing guidance for a running
Agent task.

The microphone starts immediately with a remembered dictation service. On first
use it selects the active provider when supported, otherwise the first suitable
connected API-key service, and remembers that choice. OpenAI, OpenRouter, Venice
and NEAR AI are supported. With no suitable connection it opens setup, including
the optional local download. Settings → AI and the arrow beside the microphone
always expose the service and language preferences. The conversation model stays
unchanged. Subscription connections do not establish transcription
access and are not offered as speech services. Meta, xAI, custom endpoints and
live partial transcripts are outside this first draft.

## Cloud transcription

Audio is recorded in memory, then sent after Stop to the chosen service. The
request contains only the recording, speech-model settings and language hint.
Chat history, project files and attachments are not included. Usage is billed to
the selected service. There is no automatic fallback to a different destination.

The selected chat model's end-to-end encryption and hardware checks do not cover
these audio uploads. The chooser and recording indicator name the actual audio
destination. TEE-only connections are unavailable for dictation in this draft.
OpenRouter dictation requires zero-retention routing by default; an explicitly
ZDR-only connection cannot be weakened through the dictation preference.

The initial models are `gpt-transcribe` for OpenAI and
`openai/whisper-large-v3` for the other three services. These are separate from
the Agent model catalogue. Reference documentation:

- [OpenAI transcription](https://developers.openai.com/api/docs/guides/transcription)
- [OpenRouter transcription and retention routing](https://openrouter.ai/docs/guides/overview/multimodal/stt)
- [Venice transcription](https://docs.venice.ai/api-reference/endpoint/audio/transcriptions)
- [NEAR specialized endpoints](https://docs.near.ai/cloud/guides/specialized-endpoints)

## On this device

Choose **On this device**, then **Download & use on this device**. Freedom downloads
about 230 MB once, verifies pinned SHA-256 hashes and installs files in the active
profile's Agent data directory. No Ollama, terminal setup or Python installation
is needed. Downloading never happens on browser startup or while AI is off.

The engine is sherpa-onnx 1.13.8 with the multilingual Whisper Base model using
quantized ONNX weights. This was selected for the draft because upstream provides
native desktop binaries; it avoids requiring a local whisper.cpp compiler build.
No npm dependency was added. Apache-2.0/MIT notices accompany the downloaded
installation. See [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) and
[Whisper](https://github.com/openai/whisper).

Audio stays on this device during local transcription. A private temporary WAV
is removed on completion or cancellation; raw audio is not saved in conversation
history. Sending the resulting prompt subsequently shares its text with the chat
provider in the ordinary way.

Runtime downloads are mapped for macOS arm64/x64, Linux x64/arm64 and Windows x64.
Unsupported architectures are marked unavailable. Native installation and
inference have been exercised on macOS arm64; Windows/Linux local inference and
signed-package behavior still need qualification before release.

## Draft behavior and qualification

- Recordings are capped at two minutes. Text appears after transcription,
  rather than incrementally while speaking
- Recording and transcription block Send. Draft text, cursor selection and
  attachments are preserved; the transcript replaces the original selection
- Closing Agent, changing conversation, disabling AI, cancelling or losing the
  microphone releases capture and prevents a late transcript entering another draft
- Cloud permission denial, provider errors and no-speech recordings leave the
  draft unchanged. No cloud service is silently selected after a failure
- A remembered service that becomes unavailable opens setup rather than silently
  switching the audio destination. TEE-only connections are excluded from automatic selection
- Chromium capture uses an AudioWorklet, with resampling outside the renderer
  thread. Native inference runs in a separate process

Automated tests exercise ownership, audio validation, retention routing, safe
error responses, cancellation, native-download integrity, first-use choice,
actual Chromium AudioWorklet capture with generated audio, cloud upload to a
local fixture, editable insertion, both themes and narrow windows. A local native
install/inference smoke used the upstream English sample without sending audio
to a provider. Actual microphone hardware/TCC prompts, English/German accuracy
and the four live cloud services remain maintainer smoke tests.
