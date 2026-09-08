# Native macOS cleanup: current-product qualification, 2026-09-08

Status: incomplete. The first bounded product group stopped on an independent monitor registration failure; it is not a passing qualification. The production implementation remains committed as `d9f13f14fd64f7be00b7ae157b793846850802e7`.

## Authorization and source identity

The user explicitly approved sending the prepared source to the disposable-Mac agents. This resolves the source-transfer approval block recorded in the September 7 evidence; that earlier entry remains historical. Direct Herdr coordination and bounded remote tests are authorized. No new third-party software was acquired, no potentially disruptive fixtures ran on the primary Mac, and the feature branch was not pushed.

The source patch from remote base `11a863ecad4c02ed139040243d0ed657b7a1443b` to the implementation covered `src`, `scripts`, `config` and `package.json`: 167,193 bytes, SHA-256 `5ec032102585df4798d5a14e8c1b3bbc497521481468f475db29b3f46db119d5`. The remote verified these four Git subtree/blob identities after applying it. This proves source-subtree equivalence, not full commit identity: research history was not transferred.

The remote setup report is retained under `/private/tmp/freedom-final-candidate-he26qp5x` on macmini. The original development checkout and sibling checkout remained clean. The remote used installed Apple clang/SDK, Electron 43.0.0 (embedded Node 24.17.0), and CLT Python 3.9. Arm64 helper SHA-256 is `f7cb7da6b40562def145bee3576567403225fb99ae8d56a488d2ecf22b176671`; C source SHA-256 is `01d67c27e99220ebb37e3d1e07e962703ceab10b832cadd053abc7fd0b458cce`. The source-equivalent binary differs from the primary build; do not substitute their hashes.

## Test-only lifecycle evidence support

Commit `dd96ec87` adds a validated 1–15 second independent alarm to the running app-exit payload (default 15), with monotonic and wall-clock bounds around alarm installation. It records fixture intent before setup, native supervisor identity immediately after real spawn, and the raw executor receipt before the controller maps it. Mapped terminal results remain separate. Observation neither changes the executor result nor adds signal authority. It is gated by the existing test mode; idle preparation does not write evidence. The legacy detached fixture is unchanged and is outside this bounded run plan.

Thirteen mock tests cover malformed bounds, reused tokens, composition, failure cleanup, receipt preservation, bounded capture and delayed execution. Ordinary primary-Mac validation passed 4,116 tests / 238 suites, with 54 tests / 7 suites skipped; lint passed. No Python payload, native Quit, crash or detached fixture was executed by these tests.

The two-file support patch is 19,382 bytes, SHA-256 `2228e6463ead282e65f61e5bb87f0a0be65abc6f35c9c2691b295b62a0eede9d`. Its `src` tree is `66706738328edf4ffaaec818bfae9d6531ba1fb7`; other transferred subtrees are unchanged. It was supplied to the separate disposable-Mac Claude agent for source-only app-loss driver preparation. The first product-group attempt below used the production candidate without this test-only patch.

## Explicit first-attempt report

The following is the disposable-Mac agent's explicit reply for request `macmini/req-acaf67a62fc0c06f7a766cfdb9df2b09`, retained with its raw receipts and artifact inventory. No counts below are extrapolated to later groups or later source revisions.

Disposition: HARNESS IMPLEMENTED; FIRST GROUP STOPPED ON MONITOR FAILURE; NO RETRY. Production candidate was not changed. Phase 2 is not complete and phase 3 remains pending/excluded.

Evidence/source root: /private/tmp/freedom-bounded-phase2-4o1zph2v
Qualification-source directory: /private/tmp/freedom-bounded-phase2-4o1zph2v/qualification
Verified production remains /private/tmp/freedom-final-candidate-he26qp5x/candidate.

Results and first unexpected failure
- Ran processes (fast) once under independent watchdog. Runner exit1; watchdog exit1; 15.643214834 seconds including cleanup.
- Nine product assertions passed: M0, M1, M2, M3, M4, M5, M5-completed, M10-consumed, M11-retained. Three cleanup assertions passed. No failed product assertion preceded the stop. Summary passed12/failed0 contains scenarioError, so this is an aborted group, NOT a passing group.
- During launch12 (the finite 400000-byte flood payload, before M12), the monitor returned "Known argv unavailable". S had already passed canonical executable/owned-profile/parent/UID/start checks, genuine audit-token acquisition, and NOTE_EXIT registration. The error therefore occurred in the subsequent C argv read, before C registration/ACK and before G. The harness closed only its owned control FD, rejected its scenario deadline promise, and entered existing service/preview/controller disposal. Independent W sent SIGTERM only to its direct unreaped Electron-as-Node qualification runner; that runner's handler requested cleanup. This was emergency harness cleanup, not a GUI/browser-loss scenario.
- The seven S processes exited0. The failed-to-register C received pre-release cancellation: spawned=true, releaseIssued=false, groupVerified=false, rootExitObserved=true, rootReaped=true, actual signal15, cleanupUncertain=false. No flood payload was released. The active ordinary heartbeat was cancelled with actual signal15 and a truthful uncertain final-group-KILL diagnostic.
- No runtime capability/production assertion was patched to make the result green. No source was corrected or fixture rerun after this failure. reconciliation, previews, process-controls and optional Seatbelt checks were skipped as requested. No GUI, native Quit, main loss, intentional supervisor loss, packaging, or detached fixture ran.

Diagnosis and minimal suggested correction (NOT applied)
The watchdog currently tries to inspect C immediately after it appears under S, while C can still be transitioning from sandbox-exec to the trusted --gate image. Six prior registrations succeeded, but one KERN_PROCARGS2 read returned nonzero. An exec-transition race is plausible; it is not proven, because this first monitor unfortunately did not retain that syscall's raw return/errno or C PID on this failure path. Do not infer EPERM/ESRCH/EINVAL or a persistent platform denial from the generic error. S acquisition succeeded, so this was not an unavailable S audit-token API.
Keep the pre-return S registration/cleanup authority handshake, but split C registration into a second phase triggered by the trusted native READY record. The observation listener must run before the product's status listener can process READY/send G. Register and recheck the then-blocked gate C (with bounded waits), ACK, and only then allow the real product listener to consume READY. This avoids demanding stable argv while C is execing and preserves all product authority and assertions. Also retain syscall rc, errno, phase and already-read C identity on every failed read, publishing the identity before a later observation can fail. No production C/JS change is indicated by this result.

Harness adaptations implemented only in the qualification copy
1. Existing harness check() throws on a failed scenario assertion; cleanup checks still record independently during cleanup. Existing real service/controller/Pi tool factory/executor/store/preview-controller composition and assertion conditions are retained.
2. Long shell sleep/fork loops and stdin waits became inline `exec python3 -u -c` finite no-fork payloads. Tick prefixes, heartbeat files, stdin exit3/exit0 behavior, cwd identity, reversal/delayed-completion output and Stop/disposal assertions remain. The fifth-command rejected-launch check compares the exact adapted command instead of the old literal prefix. That preserves its no-execution assertion.
3. Python SIGALRM expires by group-start+100s, never later than100s after payload launch; expiry emits FREEDOM_QUAL_EXPIRED and exit124. Tick count <=1000, stdin total <=64KiB; fixed400000-byte flood remains the original truncation positive control. Idle/delay payloads do not fork. Netloop has finite100 iterations plus independent alarm, loopback only.
4. Existing preview/server Node source gets <=100s expiry and64KiB stdout/stderr cap. Existing HTTP size-bound assertions (finite17MiB stream to test16MiB response cap) remain, distinct from retained command output. Server commands exec the approved Node runtime. All owned server binds use127.0.0.1; processes host listener cleanup is registered before awaiting listen.
5. Harness executableAccessOptions.hostEnvironment supplies a fixed installed-runtime PATH instead of running personal login-shell startup files. Actual executable resolver, canonicalization, permission approval and policy remain production implementations. Installed preview Node candidate is Homebrew22.22.0; Electron runner/helper runtime is43.0.0/Node24.17.0. Preview runtime approval was NOT reached in the aborted group. System Python is installed CLT3.9. No dependency installation or shim.
6. launch-guard.js delegates unchanged to real child_process calls after conservative reservation. It journals launch intent/ownership before setup, observes actual native FD4 JSON, retains full raw executor receipts before controller mapping strips diagnostics, and closes the launch gate on failure/deadline. No fake executor/receipt, no public PID control API, no product edit.
7. Independent watchdog.py retains direct unreaped-runner signal authority; registers known S/C NOTE_EXIT before release; holds genuine S audit token only in memory for emergency identity-bound cleanup. No S audit signal was needed or sent. Tokens were never written/transmitted. This test-only installed/private SDK API use is NOT a shipping guarantee. No process-name/group or rediscovered numeric-PID cleanup.
8. Atomic registration/ACK publication and exception-safe watchdog fallback were corrected BEFORE first execution. The initial ESLint invocation reported files outside its base and did not check them; retained setup-attempt-01.json. Copying the unchanged eslint config into the isolated source fixed that setup issue; subsequent ESLint runs checked adapted source and passed0, no lint warnings. Python watchdog and generated payload AST parsing passed without executing payloads. All setup attempts retained.

Budget, actual accounting, ownership and cleanup
Written prelaunch SAFETY-PLAN.md reserves each group198 roles (runner1 + operational174 + cleanup23), plus watchdog1 =793 total <=800. Native S chains reserve3 (S+C+one ordinary-child allowance), with7 if workspace_inspect is ever reached for up to5 fixed Git descendants. Every direct asynchronous/synchronous child-process launch including read-only group probes is charged. Live reservation gate24. No old budget reset.
Only processes started. It consumed29 conservative role reservations including W, and peak reserved live roles was8 including W/runner. Actual accounting:13 direct child launches of the runner (7 S +6 capability/runtime/read-only probes),7 C births confirmed by native FINAL spawned/rootReaped fields,1 ordinary finite mkdir child implied by the successful source command, plus W+runner2 =23 roles. The mkdir PID was not independently traced; this is an explicitly source-inferred child, not an invented observed identity. The six unused ordinary-child allowances remain conservative. No Git child launch occurred before this stop.
W independently registered7 S and6 C, and received NOTE_EXIT for all13 registered identities plus the runner. The final C failed before independent C registration; its exit/reap is attested by its native FINAL, not falsely described as independently registered. All7 native roots report reaped. Each launched direct child has an exit/error settlement record, and W reaped runner only after permanently disabling numeric signals. No payload independent expiry occurred; no cancellation assertion relied on expiry.
Raw cleanup: {"type":"cleanup","scenario":"processes","rootRemoved":true,"survivors":"","cleanupErrors":[]}.
A separate post-cleanup read-only `ps -axo pid=,ppid=,command=` scan for the unique new root and exact payload expiry marker found no matches excluding the diagnostic process itself. It never authorized any signal. First restricted ps query returned PermissionError errno1; authorized read-only escalation succeeded, retained in post-cleanup-process-snapshot.json. This was not a fixture rerun.
No owned qualification survivors were found. The one loopback listener lived in the now-exited runner and was closed by registered scenario cleanup. Newly created workspace root was removed by existing finally cleanup; source/logs/manifests remain outside it. No old evidence/fixture files were removed.
Deadlines were95s scenario, <=100s payload expiry,102s watchdog cleanup request,110s emergency cutoff, <119.4s per group; actual15.64s. Later groups never consumed execution time/births. Retained group output stayed below2MiB.

Exact execution/setup commands and logs
Actual single fixture orchestration command (working directory irrelevant; source derives own ROOT):
  python3 /private/tmp/freedom-bounded-phase2-4o1zph2v/watchdog.py
W launched exactly:
  /Users/flobot/Git/freedom-dev/freedom-browser/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /private/tmp/freedom-bounded-phase2-4o1zph2v/qualification/scripts/qualify-agent-workspace.js processes
cwd qualification; ELECTRON_RUN_AS_NODE=1, HOME/TMPDIR newly owned fixtures/processes, fixed PATH/runtime PATH, per-group log directory and expiry deadline. No ambient credentials copied into runner environment. Full invocation/intent in logs/processes/intent.json; every actual child launch command, status and reserved cost in launches.jsonl. The phase-2 S binary is the prior repository-built optimized arm64 candidate; no native compilation/rebuild in this request. setup-attempt-01/02/03.json retain exact lint/generation/AST commands and diagnostics; /opt/homebrew/bin/node --version returnedv22.22.0. Electron setup startup emitted the already observed task_name_for_pid warning, preserved honestly, while watchdog genuine S token acquisition succeeded.

Unchanged source proof
`git diff --quiet -- src config package.json scripts` exited0 in candidate; `git write-tree` still1210f3b898edf855959b48a00b9e5779b34a8645. Source identities remain:
config 4b92ebead9cd66346da12a06f1aab8d63b6ec16b
package.json 7ad2dce912ea545551c9343b26884da175800e0f
scripts 18743216110ed329e19dac8994ad6d75f08a3194
src a4fb6ff3d63374f983fc7ba9d191d511d87feeeb
Native C SHA25601d67c27e99220ebb37e3d1e07e962703ceab10b832cadd053abc7fd0b458cce; arm64 binary SHA256f7cb7da6b40562def145bee3576567403225fb99ae8d56a488d2ecf22b176671. This is source-subtree equivalence to supplied d9f13f14, not full commit identity.
Both original checkouts remain clean: /Users/flobot/Git/freedom-dev/freedom-browser at11a863ecad4c02ed139040243d0ed657b7a1443b (codex/agent-workspace-macos-qualification); /Users/flobot/Git/freedom-browser at38b07f33bae548f167114ea615770e4871525ea4 (feature/swarm-publishing-updated). Exact command outputs in production-and-checkout-proof.json. No production src/main/test-harness.js edit.

Artifact inventory
All paths below relative to evidence root:
- SAFETY-PLAN.md: prelaunch table/ownership/deadlines.
- qualification/scripts/agent-qualification/{harness.js,launch-guard.js,finite-fixtures.js,platform-adapter.js,scenarios/*.js}: retained source; only selected four scenarios used/planned.
- watchdog.py, adapt.py, final-harness.patch, final-adaptations.json: exact authored source/diff/hash mapping.
- setup-attempt-01.json, setup-attempt-02.json, setup-attempt-03.json: all setup verification attempts.
- execution-budget.json, counts.json, results.json: persistent reservations, actual accounting, stopped outcome.
- logs/processes/{intent.json,runner-owned.json,launches.jsonl,stdout.jsonl,register-*.json,registered-*.json,watchdog-result.json,post-cleanup-process-snapshot.json}: raw commands, identities, receipts, errors and cleanup.
- raw-native-receipts.json: all7 candidate FINALs.
- production-and-checkout-proof.json: unchanged candidate and clean original trees.
- manifest.json: complete relative artifact inventory with bytes/SHA256, source archive identity and per-file original/adapted hashes.
- sources.json, sources.json.gz, sources.base64: exact source records, no executable bytes.

Raw native FINAL receipts for this candidate (all7):
[
  {
    "id": 6,
    "v": 1,
    "type": "final",
    "reason": "completed",
    "spawned": true,
    "releaseIssued": true,
    "rootExitObserved": true,
    "rootReaped": true,
    "groupVerified": true,
    "cleanupUncertain": true,
    "exitCode": 0,
    "signal": null,
    "finalKillAttempted": true,
    "signalErrors": [
      {
        "phase": "kill",
        "errno": 1
      }
    ],
    "setupError": null
  },
  {
    "id": 7,
    "v": 1,
    "type": "final",
    "reason": "completed",
    "spawned": true,
    "releaseIssued": true,
    "rootExitObserved": true,
    "rootReaped": true,
    "groupVerified": true,
    "cleanupUncertain": true,
    "exitCode": 0,
    "signal": null,
    "finalKillAttempted": true,
    "signalErrors": [
      {
        "phase": "kill",
        "errno": 1
      }
    ],
    "setupError": null
  },
  {
    "id": 9,
    "v": 1,
    "type": "final",
    "reason": "completed",
    "spawned": true,
    "releaseIssued": true,
    "rootExitObserved": true,
    "rootReaped": true,
    "groupVerified": true,
    "cleanupUncertain": true,
    "exitCode": 3,
    "signal": null,
    "finalKillAttempted": true,
    "signalErrors": [
      {
        "phase": "kill",
        "errno": 1
      }
    ],
    "setupError": null
  },
  {
    "id": 10,
    "v": 1,
    "type": "final",
    "reason": "completed",
    "spawned": true,
    "releaseIssued": true,
    "rootExitObserved": true,
    "rootReaped": true,
    "groupVerified": true,
    "cleanupUncertain": true,
    "exitCode": 0,
    "signal": null,
    "finalKillAttempted": true,
    "signalErrors": [
      {
        "phase": "kill",
        "errno": 1
      }
    ],
    "setupError": null
  },
  {
    "id": 11,
    "v": 1,
    "type": "final",
    "reason": "completed",
    "spawned": true,
    "releaseIssued": true,
    "rootExitObserved": true,
    "rootReaped": true,
    "groupVerified": true,
    "cleanupUncertain": true,
    "exitCode": 0,
    "signal": null,
    "finalKillAttempted": true,
    "signalErrors": [
      {
        "phase": "kill",
        "errno": 1
      }
    ],
    "setupError": null
  },
  {
    "id": 8,
    "v": 1,
    "type": "final",
    "reason": "cancelled",
    "spawned": true,
    "releaseIssued": true,
    "rootExitObserved": true,
    "rootReaped": true,
    "groupVerified": true,
    "cleanupUncertain": true,
    "exitCode": null,
    "signal": 15,
    "finalKillAttempted": true,
    "signalErrors": [
      {
        "phase": "kill",
        "errno": 1
      }
    ],
    "setupError": null
  },
  {
    "id": 12,
    "v": 1,
    "type": "final",
    "reason": "cancelled",
    "spawned": true,
    "releaseIssued": false,
    "rootExitObserved": true,
    "rootReaped": true,
    "groupVerified": false,
    "cleanupUncertain": false,
    "exitCode": null,
    "signal": 15,
    "finalKillAttempted": true,
    "signalErrors": [],
    "setupError": null
  }
]

Original/adapted source hash mapping:
[
  {
    "path": "scripts/agent-qualification/harness.js",
    "originalBytes": 26911,
    "originalSHA256": "9af12fff257314d82f9a241612a9f2dc60828ca78703a31378a6fd1feeb1a33c",
    "adaptedBytes": 27738,
    "adaptedSHA256": "eb3ef98023787edc8035dd9258fc1f1f3f03628ee4bf50002636190fa4c73f26"
  },
  {
    "path": "scripts/agent-qualification/scenarios/processes.js",
    "originalBytes": 34188,
    "originalSHA256": "fa4a4fecc21fd64e9346227ffedaa54555feba4e5d8b2780ad02afb60072de8d",
    "adaptedBytes": 34206,
    "adaptedSHA256": "5f77c365d6f23a05a1087906971f2ef1fc28ff7cadc9e58c7e479f15a24685e3"
  },
  {
    "path": "scripts/agent-qualification/scenarios/reconciliation.js",
    "originalBytes": 22069,
    "originalSHA256": "9ee4b255e4de09a8eec2d80f2ce0331790af65c6f5a5dae8f86bb61447f33203",
    "adaptedBytes": 22242,
    "adaptedSHA256": "0aa0fa39a6b34846eb9f96e638621c72cc530f097652f8d239a07c014ea3db49"
  },
  {
    "path": "scripts/agent-qualification/scenarios/previews.js",
    "originalBytes": 46594,
    "originalSHA256": "6ea03a68a14de68feb00f90f62f6694cbe38297466b3fe9bcd9c76b1007e0883",
    "adaptedBytes": 46790,
    "adaptedSHA256": "68a626e1861b21d1e729b7fc9a2af667b4a21b765536d705a5829f14bbdb9ace"
  },
  {
    "path": "scripts/agent-qualification/scenarios/process-controls.js",
    "originalBytes": 30845,
    "originalSHA256": "f4a55b71d2227a6ec17362d731a6ddcb4164a02052d27d10d06c1eb69b1686ce",
    "adaptedBytes": 30931,
    "adaptedSHA256": "e285b53a8b1ada043b47c583e5bed2bfd5d7e18416d04d02068ce7aa8edeed4e"
  }
]

Full artifact inventory (path, bytes, SHA256):
[
  {
    "path": "SAFETY-PLAN.md",
    "bytes": 5599,
    "sha256": "7d2b28b9be47d9009288f0355e3035f956b124764d5b4ad74034eebe107e8847"
  },
  {
    "path": "adapt.py",
    "bytes": 6476,
    "sha256": "beebce89d2f7ef3e794b06991673959ab5953cd89e7bc348bb2a60ae83a9d596"
  },
  {
    "path": "adaptations.json",
    "bytes": 1106,
    "sha256": "9f6214c45259bd6a49ac85ddba8539536223bc6dd079b2915fb3404b28c5f88b"
  },
  {
    "path": "counts.json",
    "bytes": 860,
    "sha256": "c48efaafbe5b918d1b4762731164fd1acf7d10721351193e0bc35f4177d527d9"
  },
  {
    "path": "execution-budget.json",
    "bytes": 250,
    "sha256": "d420dcfe77661ca8c0fb3a7319431262cf80c6585d2a598710c13966a56d33c6"
  },
  {
    "path": "final-adaptations.json",
    "bytes": 1541,
    "sha256": "47b845cffa4487d62ad091e7770b43548312eab98b4e281c96f6b8a1faf10094"
  },
  {
    "path": "final-harness.patch",
    "bytes": 20003,
    "sha256": "3c4798e7833f120b1a1379b1b2b8506f3f2f1dc602528eabbb77d528e667973f"
  },
  {
    "path": "fixtures/processes/Library/Logs/freedom-browser/main.log",
    "bytes": 2650,
    "sha256": "c793d2463364249548064582c2affadb7b07776e1956f885dc7ae0b50d03465c"
  },
  {
    "path": "harness.patch",
    "bytes": 20003,
    "sha256": "d9b8b4d470835598168a741e357f6190e6721cf9127bf2868c2beda6de20197d"
  },
  {
    "path": "logs/processes/intent.json",
    "bytes": 434,
    "sha256": "c5f38361ec20092c400d8993c568ea272c2da194195d53253021c885f9ed8194"
  },
  {
    "path": "logs/processes/launches.jsonl",
    "bytes": 34540,
    "sha256": "e721666ea68c032a8ced721767d0a1f3f82c804c0f0fd10f08eb9351de1be8f1"
  },
  {
    "path": "logs/processes/post-cleanup-process-snapshot.json",
    "bytes": 332,
    "sha256": "fffb91997bbf0fab4d81e84b481d6ac172ab04e1044392957aae84c2a5bea453"
  },
  {
    "path": "logs/processes/register-10.json",
    "bytes": 268,
    "sha256": "4681bda6bdb7aa250502d58c8cbdf35a6b4484ee90292a7b2c5d894a61c5e1f3"
  },
  {
    "path": "logs/processes/register-11.json",
    "bytes": 268,
    "sha256": "24696c44a4d453fd7392d8f7b5cc06c768871b0006604440fbdc9af871651720"
  },
  {
    "path": "logs/processes/register-12.json",
    "bytes": 268,
    "sha256": "04eb4ceb872b0bef165d59d89592b9add5209c12069f015fb57c4ba80d4cd6af"
  },
  {
    "path": "logs/processes/register-6.json",
    "bytes": 267,
    "sha256": "9e607349e843e6fd0c1d58018dcc4b38b3f0b44f64eedd75917f0b29757366ed"
  },
  {
    "path": "logs/processes/register-7.json",
    "bytes": 267,
    "sha256": "8b6e78c772acbd7d9210d5b1afe39b29ef5325ca2a5977a9158c2263511bdaf1"
  },
  {
    "path": "logs/processes/register-8.json",
    "bytes": 267,
    "sha256": "b4243c4da3e27208c32d42e6f9a5d16ac0347953d51033ded2faab882c652591"
  },
  {
    "path": "logs/processes/register-9.json",
    "bytes": 267,
    "sha256": "6046abee44ec05279ae262537ab368c46f72d54ab46bf267024e34b196fd91b7"
  },
  {
    "path": "logs/processes/registered-10.json",
    "bytes": 454,
    "sha256": "0c687f027378036d12953736343b1bacc893c6e2babbe43640fbab498db66e89"
  },
  {
    "path": "logs/processes/registered-11.json",
    "bytes": 454,
    "sha256": "ed43ce5097449af751d3d931f98b4bfe9fd68a76224c598385022667adddb75a"
  },
  {
    "path": "logs/processes/registered-12.json",
    "bytes": 55,
    "sha256": "beb7bda9b1d2bcfda165d5f5cde85b41fe001e9fd195ee12cc24628389d57538"
  },
  {
    "path": "logs/processes/registered-6.json",
    "bytes": 452,
    "sha256": "04247daf9ee884312861cb456c3721643b955059844c47faa2edee571c9d3cc4"
  },
  {
    "path": "logs/processes/registered-7.json",
    "bytes": 452,
    "sha256": "b5c04ccb3254750b7f71023d85680089c7dab6d9e8e359963ecf907eec46de36"
  },
  {
    "path": "logs/processes/registered-8.json",
    "bytes": 452,
    "sha256": "6621b638da19ce1a76ab642ccf7c316ea13d7dcbe77f8a9a0c6cbc9db9c42113"
  },
  {
    "path": "logs/processes/registered-9.json",
    "bytes": 452,
    "sha256": "723145ea36098c3831e848a4e8cd358b24a4eb11180407ba078dc2489147aab0"
  },
  {
    "path": "logs/processes/runner-owned.json",
    "bytes": 118,
    "sha256": "f7641129e187cd1edd85b69cb540bbcaf429ecb21643468ef84b17d3d929c862"
  },
  {
    "path": "logs/processes/stdout.jsonl",
    "bytes": 21456,
    "sha256": "29e3406cfaf064d205e72d91a57cd379bad7cc2747a546947b227f019a6c03d5"
  },
  {
    "path": "logs/processes/watchdog-result.json",
    "bytes": 3218,
    "sha256": "cbcceb7a1d83ed24e9a16d03c14a36e7c329ff23f4cc3aab67e8d9ac3cf47051"
  },
  {
    "path": "owned.json",
    "bytes": 238,
    "sha256": "db177d1706feb064d9ab82466a9cb4432d8fdb739723a15459b3b3c16e3e9546"
  },
  {
    "path": "production-and-checkout-proof.json",
    "bytes": 2387,
    "sha256": "e09cafd641a9ef78de051dd185882962f277c36e314d57334e97699fe96dda2f"
  },
  {
    "path": "qualification/eslint.config.js",
    "bytes": 1655,
    "sha256": "236f4dd3e674e7772f9dacae7fe90bc99a1549f5ef006735c0f8d96120c9e7fd"
  },
  {
    "path": "qualification/scripts/agent-qualification/README.md",
    "bytes": 14907,
    "sha256": "a664bc8bad4a420e0a334600cd9f648b096a3552d5e5c3f9194f58bc51160279"
  },
  {
    "path": "qualification/scripts/agent-qualification/finite-fixtures.js",
    "bytes": 3361,
    "sha256": "c39acaad5ff7cf0c445fbff58a4cacb743d641fab9cf3ff7d40fcd07da6a3d5c"
  },
  {
    "path": "qualification/scripts/agent-qualification/harness.js",
    "bytes": 27738,
    "sha256": "eb3ef98023787edc8035dd9258fc1f1f3f03628ee4bf50002636190fa4c73f26"
  },
  {
    "path": "qualification/scripts/agent-qualification/launch-guard.js",
    "bytes": 5786,
    "sha256": "2b296116b918a358a039fa72fc38266cdaf9b102b582581382790c347aa57d09"
  },
  {
    "path": "qualification/scripts/agent-qualification/platform-adapter.js",
    "bytes": 7197,
    "sha256": "b05141080646e312db15fcceaf51fe1368db65318bc87fe1511b85a515493198"
  },
  {
    "path": "qualification/scripts/agent-qualification/platform-adapter.test.js",
    "bytes": 4239,
    "sha256": "6117d88bf2c505efa14b7163c6196cca64c5ec6a1bda05867299331fea2655bf"
  },
  {
    "path": "qualification/scripts/agent-qualification/scenarios/history.js",
    "bytes": 7371,
    "sha256": "bca879ef20fee9d2e410e3bb663439525ad020a7870ebb711da10f340204059d"
  },
  {
    "path": "qualification/scripts/agent-qualification/scenarios/macos-boundary.js",
    "bytes": 9421,
    "sha256": "02c73ba9301c261d36f8a28e73f69421a672e8a2a4550331d027c8ed678d24e7"
  },
  {
    "path": "qualification/scripts/agent-qualification/scenarios/macos-destructive.js",
    "bytes": 6971,
    "sha256": "ee909fb4aac7dad5383ab74b140bfbf31f950d2c9f1b8267bbcdcbaba0e03182"
  },
  {
    "path": "qualification/scripts/agent-qualification/scenarios/network.js",
    "bytes": 37543,
    "sha256": "d222bf8a73750116f1086ddcdbdf041e4a49772b381f4bc8b7a9893fd448637e"
  },
  {
    "path": "qualification/scripts/agent-qualification/scenarios/previews.js",
    "bytes": 46790,
    "sha256": "68a626e1861b21d1e729b7fc9a2af667b4a21b765536d705a5829f14bbdb9ace"
  },
  {
    "path": "qualification/scripts/agent-qualification/scenarios/process-controls.js",
    "bytes": 30931,
    "sha256": "e285b53a8b1ada043b47c583e5bed2bfd5d7e18416d04d02068ce7aa8edeed4e"
  },
  {
    "path": "qualification/scripts/agent-qualification/scenarios/processes.js",
    "bytes": 34206,
    "sha256": "5f77c365d6f23a05a1087906971f2ef1fc28ff7cadc9e58c7e479f15a24685e3"
  },
  {
    "path": "qualification/scripts/agent-qualification/scenarios/reconciliation.js",
    "bytes": 22242,
    "sha256": "0aa0fa39a6b34846eb9f96e638621c72cc530f097652f8d239a07c014ea3db49"
  },
  {
    "path": "qualification/scripts/agent-qualification/scenarios/self-test-fault.js",
    "bytes": 1927,
    "sha256": "b76bd74d7b0183e26c309653c023e288afd998f94cd3392ed95d93f8f155958f"
  },
  {
    "path": "qualification/scripts/qualify-agent-workspace.js",
    "bytes": 8192,
    "sha256": "7e1d879e1cef48d4d62ba7666df293fee29fc10f0152868467a77dbf41f395fd"
  },
  {
    "path": "raw-native-receipts.json",
    "bytes": 2913,
    "sha256": "3a39c9658bbf071639ed4d026f1f31720d9a47a8f53e08d1040ba7c4270c8706"
  },
  {
    "path": "results.json",
    "bytes": 3978,
    "sha256": "cc96dded71e0f4bf4172521366aec00b926be21583607758faab3a19f785bcb4"
  },
  {
    "path": "setup-attempt-01.json",
    "bytes": 4343,
    "sha256": "9fae6704547de4d68bcb9205da0fedcc47b3b800685b5ad94cd1af64a2174e2e"
  },
  {
    "path": "setup-attempt-02.json",
    "bytes": 1445,
    "sha256": "128a6992b66ec68c19b58de5b63ae7b60112dce2d2ee0eb250d31cef6b0a9f88"
  },
  {
    "path": "setup-attempt-03.json",
    "bytes": 822,
    "sha256": "cdd4f047fee1d00f53ab0fd5a37a26a6293471ab97180cdae9203eb5d1937ddd"
  },
  {
    "path": "sources.base64",
    "bytes": 80433,
    "sha256": "30f42c091a13d62befd9c723f926c2fba2e728017968ece72782f9a84ee66c29"
  },
  {
    "path": "sources.json",
    "bytes": 241113,
    "sha256": "80fb1d20ddfb6e416ec3918a80f505dbcc84f4e938f82675b8b6f6475fca9eed"
  },
  {
    "path": "sources.json.gz",
    "bytes": 60323,
    "sha256": "25b46c492748e3efccea272ccfac24c3d95e627dfc8250a0e5185e31f74fcd0f"
  },
  {
    "path": "watchdog.py",
    "bytes": 11948,
    "sha256": "b26d12bfcd11a33271fb5190da4b2ab787d5510113bc94551ec9b00da02e4ea6"
  }
]


## Source review and disposition

The returned gzip source archive decoded to 241,113 bytes of JSON source records, SHA-256 `80fb1d20ddfb6e416ec3918a80f505dbcc84f4e938f82675b8b6f6475fca9eed`. The main agent verified the archive digest and each contained source file's byte count/digest, then read the launch guard and watchdog. The archive contains no executable bytes. Its remote retained paths are included in the inventory above. These are the exact failed monitor sources, not a corrected or qualified harness.

The suggested two-phase registration correction is confined to the qualification observer: register supervisor ownership first, then register the blocked command gate after actual native readiness but before the product can consume that readiness and release the command. Failed registration must withhold readiness, close the owned control endpoint, and fail the group. Syscall errors must preserve return values, errno, phase and already-read identities. The initial generic error does not prove a particular macOS denial or an exec race.

One corrected four-group attempt is authorized, with a revised cumulative campaign ceiling of 1,000 conservatively reserved process roles including the first attempt's 29, at most 24 live roles, and at most 600 seconds of fixture execution across attempts. The earlier 800 ceiling is not silently reset: the new four-group reservation is 793, bringing the combined upper bound to 822. The earlier attempt and cleanup evidence must remain intact. Stop on the first new failure; no automatic third attempt. Results remain pending at this entry.

No evidence changes `best_effort / original_process_group / survivorsPossible=true / completeDescendantTermination=false`. Native Quit, actual browser loss, deliberate supervisor loss, detached descendants, aggregate limits and signed release qualification are not established by this partial product run.
