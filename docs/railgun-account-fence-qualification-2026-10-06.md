# Account writer fence: disposable native qualification

The standalone SQLite fence passed its first two-process qualification on macOS arm64 at commit [`6d39f4750998e225185b82a0a798d60ba02a8b22`](https://github.com/solardev-xyz/freedom-browser/commit/6d39f4750998e225185b82a0a798d60ba02a8b22). This is a prerequisite for a future account-wide writer lifecycle; enrollment and account writers do not yet use it.

**The deliberate unsafe control also succeeded: opening and closing another descriptor to the live fence database in the holding process allowed the contender to acquire it.** Retaining a SQLite connection alone is therefore insufficient. Integration must prohibit other code, libraries, diagnostics, or hash checks from opening that database inode while it is held. Normal identity and journal observations use stat only. The process-wide path/inode registry prevents another cooperating primitive instance from opening it; it cannot prevent arbitrary code from bypassing that protocol.

## What ran

Exactly two original Electron-as-Node child processes used public disposable SQLite and synthetic JSON state. The pinned runtime was Electron 44.5.1, ABI 149, Darwin arm64, with better-sqlite3 13.0.3. The [input configuration](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-account-fence-2026-10-06/config.json) preserves six source hashes and 19 selected runtime/dependency file hashes; local paths are explicitly normalized.

| Boundary                                                  | Observed result                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actual initialization COMMIT, before the subsequent BEGIN | B refused with the specific BUSY error while A was paused on an explicit gate.                                                                    |
| Before public JSON rename                                 | B remained BUSY; the unpublished update was not visible. After release, B acquired and advanced the same public state from generation 1 to 2.     |
| Close with an original callback pending                   | Revocation was immediate; actual close remained pending and B stayed BUSY until the original Promise settled.                                     |
| Unobservable original Promise                             | The fence stayed retained and B stayed BUSY until A exited.                                                                                       |
| Intentional termination before rename                     | A was deliberately terminated; B acquired only after the original exit/close observation, saw unchanged generation 1, and published generation 2. |
| Same-process descriptor-close diagnostic                  | B acquired despite A retaining its connection. This demonstrates the integration restriction above.                                               |

A fixture-only observer preserved the exact original COMMIT receiver, arguments, result/error and method descriptor while adding the gate. Present, regular, single-link, distinct-inode **zero-length journals were required and observed** both immediately after that COMMIT and after A's termination before cold reacquisition. The primitive generally permits an absent or safe empty journal, but these two assertions did not accept absence. A stale phrase in the frozen expectation metadata's `dynamicFields` list suggests otherwise; the exact expectation arrays, executable assertions, controls and recorded events all require zero length. The historical freeze is preserved unchanged.

A was PID 5454 and received intentional SIGTERM. B was PID 5455 and exited naturally with code 0. Neither needed cleanup TERM/KILL escalation. The root agent observed the original driver exit naturally with code 0 in 0.5406195 seconds. The author of this archive checked saved evidence and committed source hashes without repeating the native run.

## Evidence and limits

The [exact report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-account-fence-2026-10-06/report.json), [process records](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-account-fence-2026-10-06/processes.json), [A events](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-account-fence-2026-10-06/A-events.json), and [B events](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-account-fence-2026-10-06/B-events.json) retain the original bytes. [Provenance](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-account-fence-2026-10-06/provenance.json) maps original and published hashes, source checks, process attribution and normalization; the [index](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-account-fence-2026-10-06/index.json) hashes every other archive file. Empty logs are preserved but do not establish process identity by themselves. `preparation.json` correctly says native execution had not occurred at preparation time.

The root checks passed 77 pure tests across three suites, strict lint and formatting. Source inventories and modeled refusal controls are not execution coverage or OS-lock proof. This native result covers only the selected build and cooperative fence protocol. It does not establish account/enrollment integration, engine behavior, signing or submission, physical utility-process drainage, rollback protection, other platforms, or resistance to arbitrary same-process or OS interference. No SQLite databases, profile contents, runtime binaries, keys or private data are published here.

## Reproduction

Use the committed six source files and matching installed dependencies. The published config is historical evidence with `$REPOSITORY` and `$DISPOSABLE_OUTPUT` placeholders; its bytes do not have the original config digest and it is not directly executable. Prepare a separate config with canonical absolute input paths, exact measured source/runtime pins, the fixed runtime values, explicit approval, and a nonexistent absolute output outside all inputs. Never include a live fence database in an input hash inventory. Then retain the new config bytes and their SHA-256 and invoke:

```sh
node /absolute/checkout/scripts/qualify-railgun-account-fence.js /absolute/config.json CONFIG_SHA256
```

This creates only disposable public state and deliberately terminates its own A process. Preserve the original driver exit and resulting logs; a new run is separate evidence. The driver verifies selected inputs before launch and after both original children close, and refuses success after cleanup escalation or any failed assertion. The archived pins do not constitute a complete OS dependency inventory or a self-contained distribution of the required binaries.
