# Local dictation pre-merge review — 2026-10-21

Claude reviewed `experiment/agent-dictation` against
`feature/freedom-automation-kernel`, prioritizing the whisper.cpp replacement,
capture and draft insertion, cancellation, downloads, platform builds and packaging.
The review ran through the existing Herdr agent in this workspace. It used source
inspection, disposable fixtures, synthetic noise and upstream's public `jfk.wav`;
no personal microphone recordings, account credentials or live provider calls.

## Findings and resolutions

| Finding | Resolution |
| --- | --- |
| Noise passing the speech gate could insert `[BLANK_AUDIO]`, `[Musik]` and other non-speech annotations into the draft. | Remove the exact blank-audio sentinel and treat short annotation-only square-bracket, parenthesis and asterisk forms as silence. Preserve prose containing those characters. Avoid upstream token suppression, which converted a noise fixture into plausible invented speech. |
| Absolute Windows profile paths cross an ANSI-argv/UTF-8 boundary in the upstream CLI, breaking non-ASCII names. | Pass relative ASCII paths for the model and `recording.wav`; the working directory remains supplied through Node's Unicode-safe process API. Test with a `Jürgen 测试` profile. |
| The child-process abort callback could settle before native exit and temporary-audio cleanup. | Await child `close` before resolving transcription or cleanup. Own cancellation sends SIGKILL, leaves the execution timeout active and removes the abort listener on close. Retry transient cleanup locks three times; persistent cleanup failure remains an error. |
| Unsupported targets, including Windows ARM64, prevented browser startup/builds instead of leaving local dictation unavailable. | Skip only unsupported runtime targets before tooling/downloads. Supported targets still fail on build errors; cross-OS builds remain refused. |
| Development build-hook edits did not trigger push qualification. | Include `prepare-native-supervisors.js` in the native workflow's push paths. |

The local-menu Settings routing fix is committed as `132134b6`, the initial exit
barrier as `16e8e752`, and the final repairs above as `b8f345c6`.

## Review verdict and validation

Claude re-reviewed the repairs and reported **no remaining actionable source
defects**. The final unit/lint and native conditions have passed. Its focused
dictation/build/service tests passed; separate production-process probes confirmed
forced cancellation even when a process ignores SIGTERM. The annotation filter
also passed the reviewer's malformed-input/backtracking checks.

- At `b8f345c6`, lint and the complete unit suite pass: **10,685 passed / 129 skipped**.
- Real native macOS arm64 smoke passes model installation, public-sample speech,
  Unicode profile paths, synthetic noise, cancellation of a running process,
  invalid-audio rejection and temporary-file cleanup.
- [Run 39610853742](https://github.com/solardev-xyz/freedom-browser/actions/runs/39610853742)
  at `16e8e752` passes all five targets, including running-child cancellation.
- Final expanded native qualification at `b8f345c6` passes all five targets in
  [run 39612841790](https://github.com/solardev-xyz/freedom-browser/actions/runs/39612841790).
  This adds the Unicode profile and noise fixture to every target, including
  Windows x64 and Intel Mac.
- Earlier ten Electron dictation scenarios and the macOS arm64 ASAR-resource smoke
  remain evidence for the preceding implementation; this review did not repeat
  those UI tests or claim signed-package qualification.

The earlier `68a48038` native run checked an already-aborted signal. It must not
be cited as proof that cancellation awaited a running process.

## Recorded non-blocking follow-ups

- Make a failed startup audio cleanup visible in service availability before recording.
- Distinguish inference timeout from explicit cancellation; improve disk-full download errors.
- Assert bundled engine/manifest presence in installed-package release smoke tests.
- Tidy redundant build-variant declarations, copied library aliases and obsolete
  UI `blockedLabel` handling. Preserve old installations/builds unless their removal
  is explicitly authorized.
- Qualify real microphone permissions, device loss, latency and English/German
  accuracy, plus signed installations and older CPUs/distributions.
- Consider a private warm worker, GPU/ARM CPU tuning and OS-enforced isolation.
  Slower devices may currently exceed the bounded phrase queue; failure keeps
  completed text.
- Recognizable non-speech annotations are filtered; ordinary-word hallucinations
  from noise remain a model-quality limitation. Evaluate dedicated voice activity
  detection if physical-microphone testing warrants it.

These are follow-ups, not unresolved findings from the final source review.
Live-provider audio qualification remains separate from local inference.
