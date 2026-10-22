# Freedom Agent visual evidence

## October 10, 2026

Disposable Electron fixture on macOS; no live provider credentials or user
conversation contents. The two captures show running/completed helper cards in
the floating conversation. Finite CSS transitions are finished before capture;
otherwise a screenshot taken immediately after a theme switch records the old
surface fill with the new text color.

- [Dark theme](helpers-dark.png)
- [Light theme](helpers-light.png)

Source: `test-e2e/agent-sidebar.spec.js`, “delegated reports are expandable,
inert and coherent in both themes and layouts”. This and the project approval
presentation case passed on October 10. Broader Agent/settings qualification:
110/110 passed. These are current-state captures, not historical before images.

## Custom provider compatibility check

- [Dark theme](compatibility-dark.png)
- [Light theme](compatibility-light.png)

Source: `test-e2e/custom-provider.spec.js`, captured on the main-synchronized code
baseline `e944cc19`. The local fixture reports a successful check for `smart`;
there are no live endpoint credentials, provider responses or user files in these
captures. The scenario also covers opt-in inference, partial tool failure, retry,
continuing anyway, and changing models while a check is pending. These are current
state captures of the new optional step, not before/after comparisons.


## October 20 review repairs

Disposable macOS Electron fixtures, with finite animations finished and the
first-send ghost removed before capture. The messages, model label and download
are synthetic. No live credentials, user conversations or real downloads appear.

| Presentation | Dark | Light |
| --- | --- | --- |
| 500px floating conversation, Find and downloads | [Dark](review-floating-dark.png) | [Light](review-floating-light.png) |
| 600px Agent-first with its temporary page pane open | [Dark](review-compact-dark.png) | [Light](review-compact-light.png) |

Source: `test-e2e/agent-review-layout.spec.js`, the floating corner-sharing and
compact overlay/menu/fullscreen cases. The page pane covers the conversation
while open at this width; the workspace titlebar toggle returns to the full-width
conversation. These are after-state illustrations. Geometry, click-through,
actual pointer/keyboard routing and restoration are asserted by the tests;
images alone do not establish those behaviors or cross-platform qualification.


## October 22 dictation composer

- [Dark theme](dictation-spectrum-dark.png)
- [Light theme](dictation-spectrum-light.png)

Source: `test-e2e/agent-dictation.spec.js`, “microphone spectrum responds to audio,
quiets during silence and respects reduced motion”. Disposable macOS Electron
profile, synthetic 300Hz audio and local transcription fixtures; no physical
microphone, live service credentials or user conversation content. The full-width
spectrum shares the existing capture graph and has no separate Finish button.
These are current-state illustrations, not historical before images. Keyboard,
sound/silence, reduced-motion and cleanup behavior is asserted separately by
unit/Electron tests; these captures do not qualify another platform or provider.
