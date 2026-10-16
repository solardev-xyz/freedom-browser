# Freedom Agent visual evidence — October 10, 2026

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
