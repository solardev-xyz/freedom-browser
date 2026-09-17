# Automatic Myotis recovery UX

Captured in Freedom's Electron test harness on macOS, 2026-09-14. The after
images exercise real renderer code with simulated recovery status for Ethereum
and Gnosis. They demonstrate presentation and interaction, not live checkpoint
verification. Before images reuse the preceding v0.1.9 integration captures
from `../myotis-v019/after-{dark,light}.png`.

| State | Dark | Light |
| --- | --- | --- |
| Previous consent UI | [Before](before-dark.png) | [Before](before-light.png) |
| Automatic checkpoint update | [Updating](after-checking-dark.png) | [Updating](after-checking-light.png) |
| Recovery failed; retry or switch off | [Paused](after-blocked-dark.png) | [Paused](after-blocked-light.png) |
| Notice while Nodes is closed | [Notice](after-notice-dark.png) | [Notice](after-notice-light.png) |
| Startup settings guidance | [Settings](after-settings-dark.png) | [Settings](after-settings-light.png) |

The notice opens the Nodes menu and is dismissible without removing the
persistent inline explanation and Retry sync button. Repeated status updates
for the same failure do not reopen a dismissed notice. Automatic successful
recovery produces no notice. Both switches remain on and usable while recovery
is working or paused, even when no native child is running.

The existing theme-parity contrast probe measured the new recovery explanations
and Retry sync buttons at 7.02:1 in dark and 8.40:1 in light. The attached JSON
contains the measured results. The warning edge uses the existing warning token;
text uses the normal text token to preserve light-theme contrast.

The focused Electron walkthrough passed in both themes, including opening Nodes
from a failure notice and checking both startup help messages. The existing
Linux-only screenshot baseline command skipped on macOS. The broader chrome
theme-parity command reached Nodes, then failed on an unrelated stale Radicle
contrast-baseline entry and its Linux Control+F recipe timing out on macOS.
