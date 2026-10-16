# Disposable-Mac retained-root native prototype

Explicit reply to `macmini/req-6d2d121862ee7ddaf4d1260e2107c88e`, received 2026-09-07. The main agent independently verified the returned C/Python source against reported byte counts and SHA-256 hashes, excluding the extra separator newline before each closing code fence. No code in this report was compiled or executed on the primary Mac. This is synthetic native evidence, not product qualification.

Bounded retained-root native prototype completed: all four cases passed on this disposable Mac. The original_process_group / best_effort contract remains unchanged; survivorsPossible=true and completeDescendantTermination=false. Both Freedom checkouts remain clean and at their original revisions. No further fixture launch is needed or performed.

Evidence directory: /private/tmp/freedom-retained-root-probe-y9rnyohd
Prior assessment retained: /private/tmp/herdr-peer-macos-ownership-8f9qydsp.md
Prior design review retained: /private/tmp/herdr-peer-native-supervisor-review-oamfaazr.md

Host: Mac.fritz.box, Darwin arm64, macOS 15.6 (24G84), uid 501. Apple clang 17.0.0 (clang-1700.0.13.5), arm64-apple-darwin24.6.0, installed CommandLineTools SDK MacOSX.sdk. Exact final identity/status queries are included below. No fetch or adoption of primary commit edd6a0d8 occurred.

Execution and bounds

The prelaunch SAFETY-PLAN and persisted birth reservations allowed 17 planned births, maximum 32 over attempts. Exactly one successful compile and four case attempts occurred, with no failed fixture attempt, retry, timeout, alarm expiry, or fallback cleanup signal. Actual births were 5+4+4+4=17; maximum five live fixture roles, or six including independent Python driver W. Every native role resets its mask/dispositions and immediately arms ITIMER_REAL to the remaining shared seven-second absolute monotonic deadline on entry after fork; no controlled exec occurs in this slice. W continuously drains lifecycle records and enforces 12-second communicate timeout, with at most two seconds cleanup reserve; no subsequent launch is permitted after the overall 105-second launch cutoff within the 120-second budget. Actual full four-case execution window was 0.593 seconds. Compiler/tool processes and the already-running agent are not synthetic fixture births.

16 owned direct instances have actual wait/reap receipts: W reaped four B; each B reaped its S and E; each S reaped C. The single D in normal exited according to a NOTE_EXIT registration established while D was blocked, before its release. C exits first, so D adoption/reaping belongs to the OS; no direct D wait receipt or OS reap timestamp is claimed. These receipts account for every fixture and confirm none remain live without PID scans or numeric rediscovery. Sentinel E responded after S cleanup in every case, then exited on its own q command and was reaped.

The root ownership record precedes injected failure. S keeps C as its unreaped direct child while signaling: original PGID=-PID(C) only after the trusted gate reports PID=PGID=SID and S is outside that group; before verification it targets only direct unreaped C. No signal by process name, tree scan, audit token, libproc, ES, separate anchor or launchd job is used. The last signal precedes permanent signal-latch disable, then waitpid reaps C, then a deliberate guard call is blocked without a syscall. No signal retry survives reap.

Results

* normal, 0.399 s, 5 births, 15 native assertions: C exited 0 while D retained stdout/stderr. waitid(WEXITED|WNOHANG|WNOWAIT) returned 0 and reported C exit while output_eof=false. Final group SIGKILL returned 0; registered D NOTE_EXIT arrived; C was reaped afterward. Non-draining B output generated actual backpressure, handled by bounded forwarding batches and dropped bytes. This isolates lifetime from output-writer lifetime.
* before, 0.040 s, 4 births, 10 assertions: B closed its sole control writer at READY without sending GO. S closed the sole C gate writer; C reported gate EOF and exited 77, with no payload_begin. Final group SIGKILL returned -1/errno 1 (EPERM). C was already waitable, no D existed, and cleanup/reap succeeded. This error is retained, not counted as a successful kill.
* running, 0.111 s, 4 births, 12 assertions: B closed output after payload readiness (actual EPIPE handled), then its control writer after 60 ms. S detected EOF and sent group TERM rc=0; C exited from signal 15. Final group KILL returned -1/EPERM after C became waitable; no D existed. Reap and post-reap guard passed without browser JS cleanup.
* partial, 0.029 s, 4 births, 9 assertions: deterministic injected setup failure after root birth/ownership and exit registration, before gate readiness. S closed gate, sent direct unreaped C TERM rc=0, observed signal-15 exit, then final direct C KILL rc=0 before reap. No payload started, and no group signal was attempted before group verification.

All 46 native assertions and each case's 15 driver checks passed. EPERM above is an actual Darwin result when only the already-exited root remained in these cases; the tests do not establish a general errno interpretation or a safe per-member PID fallback. Report raw return codes in product diagnostics.

Process and FD topology

W -> B -> S -> C; B also owns unrelated sentinel E; normal only C -> D (same session/group as C). B stays alive as an oracle while explicitly closing control; this is a synthetic browser-liveness EOF test, not a real browser crash or Quit.

W starts B with close_fds=True, stdin=/dev/null, stdout=trace pipe, stderr=the same trace pipe. There are no opportunistic inherited application descriptors. B duplicates trace to fd3; all created pipes are CLOEXEC. Each native role closes the explicit known-descriptor set except its allowlist. fd numbers below are actual observed allocations (closed standard slots are intentionally reused in S):

* B control-owner: 0 /dev/null, 1/2/3 trace writers to W, 5 E-command writer, 6 E-response reader, 9 sole B-control writer, 10 S-status reader, 12 S-output reader. Closes 12 before 9 in running; before closes 9 without GO. It reaps S, probes E, sends q, reaps E, then exits closing remaining FDs.
* E: 3 trusted trace, 4 command reader, 7 response writer; no B-control, C gate, or payload descriptors. All close on E exit.
* S after root creation: 1 sole C-gate writer, 2 C-ready reader, 3 trusted trace, 5 C-output reader, 7 kqueue, 8 B-control reader, 11 S-status writer to B, 13 forwarded-output writer to B. S closed C-side gate/ready/output endpoints immediately after fork. C never owns B-control writer. S closes C gate on cancellation or terminal cleanup; process exit closes remaining descriptors after root reap.
* C native gate: 0 gate reader, 1/2 payload output writers, 3 trace writer, 4 trusted ready/status writer; no B-control or S-status/forwarding descriptors. setsid precedes READY. Before payload, C closes gate/status and trace; in normal it creates D release pipe (reader 5, writer 6), closes reader in C, waits for S observer ACK, releases D, closes writer, reports P, closes status/gate/trace and exits after 120 ms.
* D blocked: 1/2 payload output, 3 trace, 5 D-release reader. On release it closes 5, emits final native trace, closes 3, leaving only 1/2 for payload until termination. No lifecycle descriptor is retained by its noisy payload.

The trusted fixed native messages R/D/P are on C-ready and S-status pipes, not parsed from stdout. The untrusted-like payload writes a forged S/reap JSON line exclusively to payload output; driver lifecycle records never contain it. All output writers (C and D) are separate from liveness/control writers; stdout EOF is never the root-exit condition. SIGPIPE is ignored for these native roles; S's forwarding writes are nonblocking, with EPIPE/EAGAIN accounting and finite 16-chunk drain batches to avoid starving control. This prototype may drop output under backpressure; it does not qualify product output delivery semantics. Its small trusted trace writes remain blocking to a continuously draining W, so production logging must additionally avoid allowing browser/log backpressure to wedge S.

EOF and failure boundaries

Pre-release EOF aborts only when observed before release. A GO byte buffered before a simultaneous writer close can legitimately be read and release C before the following read observes EOF; subsequent EOF triggers cleanup. No claim of atomically revoking a prior GO is made. The before case sends no GO. During setup, S owns C before the injected failure, so cleanup does not depend on successfully returning a launch object. If B died during setup, FD closure can notify S, but arbitrary timing and real process death were not swept in this slice. S crash was explicitly excluded: gates may abort an unreleased root on S EOF, but a released real workload has no general supervisor-crash cleanup guarantee. Synthetic fixture self-expiry is only a safety backstop, not a proposed production kill contract.

Attainable integration implication and remaining limits

This supports a small trusted public-API S that owns and observes the unreaped original root, separates output from lifetime, reacts to browser control EOF, final-signals the original group, then irrevocably retires signal authority before reap. It does not prove arbitrary descendant containment, permission revocation, safety under actual PID reuse, detached setsid/setpgid escapes, supervisor failure, adversarial fork load, exec inheritance or sandbox-exec/hardened-runtime behavior. C here is a self-authored native fixture, not sandbox-exec; neither controlled exec nor actual Seatbelt execution was included. WNOWAIT and NOTE_EXIT worked on this host for these known instances. The ordinary cooperative D identity announcement is only an experiment oracle, never a proposal to trust arbitrary payloads for production signal authority.

Next implementation decisions remain the native-helper build/distribution/signing boundary, exact Electron launch ownership/IPC handshake, explicit exec FD allowlist and default payload signal restoration, bounded nonblocking diagnostic/output policy, and how stop timeout/error observations are surfaced. No new third-party dependency or private API is needed for this candidate slice. No packaging, product implementation, service registration or subsequent probe is undertaken here. Linux behavior remains untouched.

Evidence follows: exact compiler command, identity, hashes, per-case result/ordering receipts and full native logs, then exact source and safety plan. All files, including compiler output and dSYM, remain in the newly owned directory. No old evidence or project file was removed. The empty compiler log means no diagnostics under -Wall -Wextra -Werror. One post-run read-only tooling typo (/usr/bin/cat unavailable; /bin/cat then used) did not launch a fixture or affect test evidence.

Compiler command
```text
/usr/bin/clang -std=c11 -Wall -Wextra -Werror -O0 -g -isysroot /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk /private/tmp/freedom-retained-root-probe-y9rnyohd/prototype.c -o /private/tmp/freedom-retained-root-probe-y9rnyohd/prototype
```

Identity/status
```json
{
  "host_toolchain": [
    {
      "command": [
        "/bin/hostname"
      ],
      "rc": 0,
      "stdout": "Mac.fritz.box\n",
      "stderr": ""
    },
    {
      "command": [
        "/usr/bin/uname",
        "-sm"
      ],
      "rc": 0,
      "stdout": "Darwin arm64\n",
      "stderr": ""
    },
    {
      "command": [
        "/usr/bin/sw_vers"
      ],
      "rc": 0,
      "stdout": "ProductName:\t\tmacOS\nProductVersion:\t\t15.6\nBuildVersion:\t\t24G84\n",
      "stderr": ""
    },
    {
      "command": [
        "/usr/bin/clang",
        "--version"
      ],
      "rc": 0,
      "stdout": "Apple clang version 17.0.0 (clang-1700.0.13.5)\nTarget: arm64-apple-darwin24.6.0\nThread model: posix\nInstalledDir: /Library/Developer/CommandLineTools/usr/bin\n",
      "stderr": ""
    },
    {
      "command": [
        "/usr/bin/xcrun",
        "--show-sdk-path"
      ],
      "rc": 0,
      "stdout": "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk\n",
      "stderr": ""
    }
  ],
  "repos": [
    {
      "path": "/Users/flobot/Git/freedom-dev/freedom-browser",
      "root": "/Users/flobot/Git/freedom-dev/freedom-browser\n",
      "root_rc": 0,
      "branch": "codex/agent-workspace-macos-qualification\n",
      "branch_rc": 0,
      "head": "11a863ecad4c02ed139040243d0ed657b7a1443b\n",
      "head_rc": 0,
      "status_short": "",
      "status_short_rc": 0
    },
    {
      "path": "/Users/flobot/Git/freedom-browser",
      "root": "/Users/flobot/Git/freedom-browser\n",
      "root_rc": 0,
      "branch": "feature/swarm-publishing-updated\n",
      "branch_rc": 0,
      "head": "38b07f33bae548f167114ea615770e4871525ea4\n",
      "head_rc": 0,
      "status_short": "",
      "status_short_rc": 0
    }
  ]
}
```

Artifact hashes and byte counts (before manifest/report generation)
```json
[
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/SAFETY-PLAN.txt",
    "bytes": 1238,
    "sha256": "9630d3cad56a5afb7d0edbd934e89857827bdfce616e7f37ba28b9bd00d2601d"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-01-normal-browser-owned.json",
    "bytes": 138,
    "sha256": "7140b3f99861d9bb0b773a546f5200b20b22db5c2c6a25b001238feeb820ec61"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-01-normal-intent.json",
    "bytes": 403,
    "sha256": "4faa8b8a725cb3af7ce20fd3912a8c879b4b27ff8bbb15e8148a6e929b0393f9"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-01-normal-result.json",
    "bytes": 3023,
    "sha256": "4304da9ee35bd2a1b8437fe035cab17370686e664cd9c1720d2355a8a2889312"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-01-normal.jsonl",
    "bytes": 4644,
    "sha256": "21c26fe94410a6a77d759ca04d3f6623788e2c93763a124ef89a4deecc6314b2"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-02-before-browser-owned.json",
    "bytes": 138,
    "sha256": "bafb1449863bff0170c51a64f2d4694088f4632c382fcd7c25d56c9368bbedd2"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-02-before-intent.json",
    "bytes": 403,
    "sha256": "2495ec918be7f48d38ac48fd25c1c14c6f817ba45d5ffaba362c636816313391"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-02-before-result.json",
    "bytes": 2788,
    "sha256": "323bc6014add3894bf1c0b3dad871bdd61e87d537f6c6ac31a133c646d437845"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-02-before.jsonl",
    "bytes": 3520,
    "sha256": "003f487b8796a504047f6a6187a3fc9e851d579c8e23dbea1d093f258fea717a"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-03-running-browser-owned.json",
    "bytes": 138,
    "sha256": "8877f9b6dc9fe5d4695d1a3a49e777e98a725b34a3645347dfa1e028744b1d58"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-03-running-intent.json",
    "bytes": 404,
    "sha256": "e168f061446941b6838109512e8e16aca2f55c76f9ab10643c121cb3da2ed1e0"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-03-running-result.json",
    "bytes": 3032,
    "sha256": "2077384112d865dfd5a7a3e142012d4423d00499a3e0db5f577707442109c89e"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-03-running.jsonl",
    "bytes": 4233,
    "sha256": "8d2a067defe00dcf98f0f4eb8add28e0c120bf326bf8a8699a4fddf00c23602c"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-04-partial-browser-owned.json",
    "bytes": 138,
    "sha256": "a8486ce28dafd9529eea359d9bf0c222204934a20c92cf1a3cf4b8a167fc10f6"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-04-partial-intent.json",
    "bytes": 404,
    "sha256": "82c755581efc1391387719e62c09a8fc6505a598093b378cdf6cbb3d8277eed3"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-04-partial-result.json",
    "bytes": 3039,
    "sha256": "3536c8143b46bcd6bdf9909dcf1fcd426091fa1a8694edfeadfa384ebc7fbd2f"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-04-partial.jsonl",
    "bytes": 3222,
    "sha256": "e536946387263de3bee0ba5f409ddb0b4c32ccb9613aa0b13a2833c062ceaa3f"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/birth-budget.json",
    "bytes": 423,
    "sha256": "65735fb45c2276796d089952262e261779fc7ecc9a0fff01c59589cf5a4301b9"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/compile-result.json",
    "bytes": 476,
    "sha256": "fda601214a6a257980914fcc0f46c579c438c27701d71d6e25703ce8015a9b0c"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/compiler-command.txt",
    "bytes": 240,
    "sha256": "e024112b603993c77f0fb3a62b89acb6e7fff29d19121feeb0190885b9204633"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/compiler.log",
    "bytes": 0,
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/driver.py",
    "bytes": 7305,
    "sha256": "ed5c596193d83ba3d9933bbe1f1bc1c43de1922574e2f100c3c895ca34df7d13"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/identity-after.json",
    "bytes": 1751,
    "sha256": "38504cd52330cced02373d7d464f49b10f7fe88fce124a29c7350698e6d97534"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/prototype",
    "bytes": 54552,
    "sha256": "9d55bb4ecb452c56323a7cb9a0cef32882c47ae2f51b77bdb80f8d831e4bb5bd"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/prototype.c",
    "bytes": 19792,
    "sha256": "cc4533936d66c65c7fa61824bcddfc366326bc102a94429f9fa3d7a73b70aa5f"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/prototype.dSYM/Contents/Info.plist",
    "bytes": 638,
    "sha256": "5ef00721bd1b269dca0f160932f4c2e6f72734942d3e8db493d024e2d34f0d95"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/prototype.dSYM/Contents/Resources/DWARF/prototype",
    "bytes": 22652,
    "sha256": "f9e58304e70ffa0c2e5bb3083785527567396702ec24ca46af75889713742393"
  },
  {
    "path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/prototype.dSYM/Contents/Resources/Relocations/aarch64/prototype.yml",
    "bytes": 145,
    "sha256": "0391b7869d4c35d8e8fb3df3171bf7872d3a22d10a48700a094da8e11483c7db"
  }
]
```

Case receipt normal
```json
{
  "attempt": 1,
  "case": "normal",
  "maximum_births": 5,
  "returncode": 0,
  "duration_seconds": 0.39852316699999996,
  "timeout": false,
  "actual_births": 5,
  "driver_browser_reap": {
    "pid": 60627,
    "returncode": 0
  },
  "assertion_count": 15,
  "failed_assertions": [],
  "checks": {
    "all_assertions_passed": true,
    "no_trace_parse_errors": true,
    "driver_reaped_browser_exit_zero": true,
    "supervisor_summary_success": true,
    "browser_summary_success": true,
    "supervisor_exited_zero": true,
    "owned_direct_children_all_reaped": true,
    "descendant_known_instance_exited": true,
    "signals_all_precede_root_reap": true,
    "signal_latch_disabled_before_reap": true,
    "post_reap_signal_guard_blocks_syscall": true,
    "untrusted_output_not_parsed_as_lifecycle": true,
    "case_under_15_seconds": true,
    "no_timeout": true,
    "births_within_reservation": true
  },
  "passed": true,
  "no_live_owned_fixtures_confirmed": true,
  "direct_reaps": [
    {
      "role": "S",
      "event": "reap",
      "seq": 18,
      "ms": 94598702,
      "child": "C",
      "pid": 60630,
      "exit": 0,
      "signal": 0
    },
    {
      "role": "B",
      "event": "reap",
      "seq": 8,
      "ms": 94598708,
      "child": "S",
      "pid": 60629,
      "exit": 0,
      "signal": 0
    },
    {
      "role": "B",
      "event": "reap",
      "seq": 11,
      "ms": 94598714,
      "child": "E",
      "pid": 60628,
      "exit": 0,
      "signal": 0
    }
  ],
  "descendant_reap_accounting": "D exit observed through registered NOTE_EXIT; after C normal exit D is reparented. No direct D wait/reap is claimed.",
  "signal_reap_trace": [
    {
      "role": "S",
      "event": "root_waitable_unreaped",
      "seq": 11,
      "ms": 94598690,
      "waitid_rc": 0,
      "status": 0,
      "code": 1,
      "output_eof": false
    },
    {
      "role": "S",
      "event": "signal",
      "seq": 13,
      "ms": 94598690,
      "scope": "original_group",
      "signo": 9,
      "phase": "final_before_reap",
      "rc": 0,
      "errno": 0,
      "before_reap": true
    },
    {
      "role": "S",
      "event": "descendant_NOTE_EXIT",
      "seq": 14,
      "ms": 94598696,
      "registered_before_release": true
    },
    {
      "role": "S",
      "event": "signals_permanently_disabled",
      "seq": 17,
      "ms": 94598702,
      "syscall_count": 1
    },
    {
      "role": "S",
      "event": "reap",
      "seq": 18,
      "ms": 94598702,
      "child": "C",
      "pid": 60630,
      "exit": 0,
      "signal": 0
    },
    {
      "role": "S",
      "event": "signal_guard_blocked",
      "seq": 20,
      "ms": 94598702,
      "phase": "deliberate_post_reap_guard_check",
      "root_reaped": true
    }
  ],
  "log_path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-01-normal.jsonl",
  "log_sha256": "21c26fe94410a6a77d759ca04d3f6623788e2c93763a124ef89a4deecc6314b2",
  "total_reserved_births": 5,
  "overall_wall_seconds": 0.400821916
}
```

Case receipt before
```json
{
  "attempt": 2,
  "case": "before",
  "maximum_births": 4,
  "returncode": 0,
  "duration_seconds": 0.04013245799999998,
  "timeout": false,
  "actual_births": 4,
  "driver_browser_reap": {
    "pid": 60632,
    "returncode": 0
  },
  "assertion_count": 10,
  "failed_assertions": [],
  "checks": {
    "all_assertions_passed": true,
    "no_trace_parse_errors": true,
    "driver_reaped_browser_exit_zero": true,
    "supervisor_summary_success": true,
    "browser_summary_success": true,
    "supervisor_exited_zero": true,
    "owned_direct_children_all_reaped": true,
    "descendant_known_instance_exited": true,
    "signals_all_precede_root_reap": true,
    "signal_latch_disabled_before_reap": true,
    "post_reap_signal_guard_blocks_syscall": true,
    "untrusted_output_not_parsed_as_lifecycle": true,
    "case_under_15_seconds": true,
    "no_timeout": true,
    "births_within_reservation": true
  },
  "passed": true,
  "no_live_owned_fixtures_confirmed": true,
  "direct_reaps": [
    {
      "role": "S",
      "event": "reap",
      "seq": 12,
      "ms": 94598746,
      "child": "C",
      "pid": 60635,
      "exit": 77,
      "signal": 0
    },
    {
      "role": "B",
      "event": "reap",
      "seq": 8,
      "ms": 94598753,
      "child": "S",
      "pid": 60634,
      "exit": 0,
      "signal": 0
    },
    {
      "role": "B",
      "event": "reap",
      "seq": 11,
      "ms": 94598759,
      "child": "E",
      "pid": 60633,
      "exit": 0,
      "signal": 0
    }
  ],
  "descendant_reap_accounting": "No descendant created",
  "signal_reap_trace": [
    {
      "role": "S",
      "event": "root_waitable_unreaped",
      "seq": 8,
      "ms": 94598746,
      "waitid_rc": 0,
      "status": 77,
      "code": 1,
      "output_eof": false
    },
    {
      "role": "S",
      "event": "signal",
      "seq": 9,
      "ms": 94598746,
      "scope": "original_group",
      "signo": 9,
      "phase": "final_before_reap",
      "rc": -1,
      "errno": 1,
      "before_reap": true
    },
    {
      "role": "S",
      "event": "signals_permanently_disabled",
      "seq": 11,
      "ms": 94598746,
      "syscall_count": 1
    },
    {
      "role": "S",
      "event": "reap",
      "seq": 12,
      "ms": 94598746,
      "child": "C",
      "pid": 60635,
      "exit": 77,
      "signal": 0
    },
    {
      "role": "S",
      "event": "signal_guard_blocked",
      "seq": 14,
      "ms": 94598746,
      "phase": "deliberate_post_reap_guard_check",
      "root_reaped": true
    }
  ],
  "log_path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-02-before.jsonl",
  "log_sha256": "003f487b8796a504047f6a6187a3fc9e851d579c8e23dbea1d093f258fea717a",
  "total_reserved_births": 9,
  "overall_wall_seconds": 0.44510558299999997
}
```

Case receipt running
```json
{
  "attempt": 3,
  "case": "running",
  "maximum_births": 4,
  "returncode": 0,
  "duration_seconds": 0.11109195799999999,
  "timeout": false,
  "actual_births": 4,
  "driver_browser_reap": {
    "pid": 60636,
    "returncode": 0
  },
  "assertion_count": 12,
  "failed_assertions": [],
  "checks": {
    "all_assertions_passed": true,
    "no_trace_parse_errors": true,
    "driver_reaped_browser_exit_zero": true,
    "supervisor_summary_success": true,
    "browser_summary_success": true,
    "supervisor_exited_zero": true,
    "owned_direct_children_all_reaped": true,
    "descendant_known_instance_exited": true,
    "signals_all_precede_root_reap": true,
    "signal_latch_disabled_before_reap": true,
    "post_reap_signal_guard_blocks_syscall": true,
    "untrusted_output_not_parsed_as_lifecycle": true,
    "case_under_15_seconds": true,
    "no_timeout": true,
    "births_within_reservation": true
  },
  "passed": true,
  "no_live_owned_fixtures_confirmed": true,
  "direct_reaps": [
    {
      "role": "S",
      "event": "reap",
      "seq": 16,
      "ms": 94598862,
      "child": "C",
      "pid": 60639,
      "exit": -1,
      "signal": 15
    },
    {
      "role": "B",
      "event": "reap",
      "seq": 10,
      "ms": 94598868,
      "child": "S",
      "pid": 60638,
      "exit": 0,
      "signal": 0
    },
    {
      "role": "B",
      "event": "reap",
      "seq": 13,
      "ms": 94598873,
      "child": "E",
      "pid": 60637,
      "exit": 0,
      "signal": 0
    }
  ],
  "descendant_reap_accounting": "No descendant created",
  "signal_reap_trace": [
    {
      "role": "S",
      "event": "signal",
      "seq": 10,
      "ms": 94598856,
      "scope": "original_group",
      "signo": 15,
      "phase": "browser_EOF",
      "rc": 0,
      "errno": 0,
      "before_reap": true
    },
    {
      "role": "S",
      "event": "root_waitable_unreaped",
      "seq": 12,
      "ms": 94598862,
      "waitid_rc": 0,
      "status": 15,
      "code": 2,
      "output_eof": false
    },
    {
      "role": "S",
      "event": "signal",
      "seq": 13,
      "ms": 94598862,
      "scope": "original_group",
      "signo": 9,
      "phase": "final_before_reap",
      "rc": -1,
      "errno": 1,
      "before_reap": true
    },
    {
      "role": "S",
      "event": "signals_permanently_disabled",
      "seq": 15,
      "ms": 94598862,
      "syscall_count": 2
    },
    {
      "role": "S",
      "event": "reap",
      "seq": 16,
      "ms": 94598862,
      "child": "C",
      "pid": 60639,
      "exit": -1,
      "signal": 15
    },
    {
      "role": "S",
      "event": "signal_guard_blocked",
      "seq": 18,
      "ms": 94598862,
      "phase": "deliberate_post_reap_guard_check",
      "root_reaped": true
    }
  ],
  "log_path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-03-running.jsonl",
  "log_sha256": "8d2a067defe00dcf98f0f4eb8add28e0c120bf326bf8a8699a4fddf00c23602c",
  "total_reserved_births": 13,
  "overall_wall_seconds": 0.5599217080000001
}
```

Case receipt partial
```json
{
  "attempt": 4,
  "case": "partial",
  "maximum_births": 4,
  "returncode": 0,
  "duration_seconds": 0.0291925420000001,
  "timeout": false,
  "actual_births": 4,
  "driver_browser_reap": {
    "pid": 60640,
    "returncode": 0
  },
  "assertion_count": 9,
  "failed_assertions": [],
  "checks": {
    "all_assertions_passed": true,
    "no_trace_parse_errors": true,
    "driver_reaped_browser_exit_zero": true,
    "supervisor_summary_success": true,
    "browser_summary_success": true,
    "supervisor_exited_zero": true,
    "owned_direct_children_all_reaped": true,
    "descendant_known_instance_exited": true,
    "signals_all_precede_root_reap": true,
    "signal_latch_disabled_before_reap": true,
    "post_reap_signal_guard_blocks_syscall": true,
    "untrusted_output_not_parsed_as_lifecycle": true,
    "case_under_15_seconds": true,
    "no_timeout": true,
    "births_within_reservation": true
  },
  "passed": true,
  "no_live_owned_fixtures_confirmed": true,
  "direct_reaps": [
    {
      "role": "S",
      "event": "reap",
      "seq": 11,
      "ms": 94598894,
      "child": "C",
      "pid": 60643,
      "exit": -1,
      "signal": 15
    },
    {
      "role": "B",
      "event": "reap",
      "seq": 7,
      "ms": 94598900,
      "child": "S",
      "pid": 60642,
      "exit": 0,
      "signal": 0
    },
    {
      "role": "B",
      "event": "reap",
      "seq": 10,
      "ms": 94598907,
      "child": "E",
      "pid": 60641,
      "exit": 0,
      "signal": 0
    }
  ],
  "descendant_reap_accounting": "No descendant created",
  "signal_reap_trace": [
    {
      "role": "S",
      "event": "signal",
      "seq": 5,
      "ms": 94598888,
      "scope": "unreaped_direct_root",
      "signo": 15,
      "phase": "partial_setup",
      "rc": 0,
      "errno": 0,
      "before_reap": true
    },
    {
      "role": "S",
      "event": "root_waitable_unreaped",
      "seq": 7,
      "ms": 94598894,
      "waitid_rc": 0,
      "status": 15,
      "code": 2,
      "output_eof": false
    },
    {
      "role": "S",
      "event": "signal",
      "seq": 8,
      "ms": 94598894,
      "scope": "unreaped_direct_root",
      "signo": 9,
      "phase": "final_before_reap",
      "rc": 0,
      "errno": 0,
      "before_reap": true
    },
    {
      "role": "S",
      "event": "signals_permanently_disabled",
      "seq": 10,
      "ms": 94598894,
      "syscall_count": 2
    },
    {
      "role": "S",
      "event": "reap",
      "seq": 11,
      "ms": 94598894,
      "child": "C",
      "pid": 60643,
      "exit": -1,
      "signal": 15
    },
    {
      "role": "S",
      "event": "signal_guard_blocked",
      "seq": 13,
      "ms": 94598894,
      "phase": "deliberate_post_reap_guard_check",
      "root_reaped": true
    }
  ],
  "log_path": "/private/tmp/freedom-retained-root-probe-y9rnyohd/attempt-04-partial.jsonl",
  "log_sha256": "e536946387263de3bee0ba5f409ddb0b4c32ccb9613aa0b13a2833c062ceaa3f",
  "total_reserved_births": 17,
  "overall_wall_seconds": 0.5929570000000001
}
```

Raw log attempt-01-normal.jsonl
```jsonl
{"role":"B","event":"case_start","seq":1,"ms":94598546,"mode":"normal","pid":60627,"uid":501,"absolute_deadline_ms":94605546}
{"role":"B","event":"owned","seq":2,"ms":94598546,"child":"E","pid":60628}
{"role":"B","event":"owned","seq":3,"ms":94598547,"child":"S","pid":60629}
{"role":"E","event":"fd_inventory","seq":1,"ms":94598547,"phase":"sentinel","open_known_fds":[3,4,7]}
{"role":"B","event":"assertion","seq":4,"ms":94598547,"name":"sentinel_ready","passed":true}
{"role":"B","event":"fd_inventory","seq":5,"ms":94598547,"phase":"browser_control_owner","open_known_fds":[0,1,2,3,5,6,9,10,12]}
{"role":"S","event":"owned","seq":1,"ms":94598547,"child":"C","pid":60630,"recorded_before_failure_injection":true}
{"role":"S","event":"assertion","seq":2,"ms":94598547,"name":"root_exit_observer_registered_before_release","passed":true}
{"role":"S","event":"fd_inventory","seq":3,"ms":94598547,"phase":"supervisor_owns_root","open_known_fds":[1,2,3,5,7,8,11,13]}
{"role":"C","event":"fd_inventory","seq":1,"ms":94598548,"phase":"root_gate","open_known_fds":[0,1,2,3,4]}
{"role":"S","event":"assertion","seq":4,"ms":94598553,"name":"root_is_distinct_session_and_group_leader","passed":true}
{"role":"S","event":"gate_ready","seq":5,"ms":94598553,"pid":60630,"pgid":60630,"sid":60630}
{"role":"B","event":"assertion","seq":6,"ms":94598553,"name":"browser_release_sent","passed":true}
{"role":"S","event":"assertion","seq":6,"ms":94598559,"name":"gate_release_written","passed":true}
{"role":"S","event":"gate_release","seq":7,"ms":94598559,"observer_registered":true}
{"role":"C","event":"payload_begin","seq":2,"ms":94598559,"pid":60630}
{"role":"C","event":"owned","seq":3,"ms":94598559,"child":"D","pid":60631}
{"role":"D","event":"fd_inventory","seq":1,"ms":94598560,"phase":"descendant_blocked","open_known_fds":[1,2,3,5]}
{"role":"S","event":"assertion","seq":8,"ms":94598564,"name":"descendant_exit_registered_while_blocked","passed":true}
{"role":"C","event":"root_will_exit_with_writer","seq":4,"ms":94598564,"descendant":60631}
{"role":"D","event":"fd_inventory","seq":2,"ms":94598564,"phase":"descendant_payload_before_trace_close","open_known_fds":[1,2,3]}
{"role":"D","event":"descendant_released","seq":3,"ms":94598564,"pid":60631,"pgid":60630}
{"role":"S","event":"payload_ready","seq":9,"ms":94598570}
{"role":"S","event":"root_NOTE_EXIT","seq":10,"ms":94598690}
{"role":"S","event":"root_waitable_unreaped","seq":11,"ms":94598690,"waitid_rc":0,"status":0,"code":1,"output_eof":false}
{"role":"S","event":"assertion","seq":12,"ms":94598690,"name":"root_exit_precedes_output_EOF","passed":true}
{"role":"S","event":"signal","seq":13,"ms":94598690,"scope":"original_group","signo":9,"phase":"final_before_reap","rc":0,"errno":0,"before_reap":true}
{"role":"S","event":"descendant_NOTE_EXIT","seq":14,"ms":94598696,"registered_before_release":true}
{"role":"S","event":"assertion","seq":15,"ms":94598702,"name":"root_observed_waitable_without_reaping","passed":true}
{"role":"S","event":"assertion","seq":16,"ms":94598702,"name":"registered_descendant_exit_confirmed","passed":true}
{"role":"S","event":"signals_permanently_disabled","seq":17,"ms":94598702,"syscall_count":1}
{"role":"S","event":"reap","seq":18,"ms":94598702,"child":"C","pid":60630,"exit":0,"signal":0}
{"role":"S","event":"assertion","seq":19,"ms":94598702,"name":"root_reaped","passed":true}
{"role":"S","event":"signal_guard_blocked","seq":20,"ms":94598702,"phase":"deliberate_post_reap_guard_check","root_reaped":true}
{"role":"S","event":"assertion","seq":21,"ms":94598702,"name":"no_signal_syscall_after_reap","passed":true}
{"role":"S","event":"assertion","seq":22,"ms":94598702,"name":"browser_backpressure_handled","passed":true}
{"role":"S","event":"supervisor_summary","seq":23,"ms":94598702,"failures":0,"root_reaped":true,"descendant_registered":true,"descendant_exit":true,"drained":1507328,"dropped":1441792,"EPIPE":0,"backpressure":352,"signal_syscalls":1}
{"role":"B","event":"assertion","seq":7,"ms":94598702,"name":"supervisor_completion_received","passed":true}
{"role":"B","event":"reap","seq":8,"ms":94598708,"child":"S","pid":60629,"exit":0,"signal":0}
{"role":"B","event":"assertion","seq":9,"ms":94598708,"name":"sentinel_ping_sent_after_worker_cleanup","passed":true}
{"role":"B","event":"assertion","seq":10,"ms":94598708,"name":"sentinel_unaffected","passed":true}
{"role":"E","event":"sentinel_exit","seq":2,"ms":94598708}
{"role":"B","event":"reap","seq":11,"ms":94598714,"child":"E","pid":60628,"exit":0,"signal":0}
{"role":"B","event":"case_end","seq":12,"ms":94598714,"failures":0,"supervisor_reaped":true,"sentinel_reaped":true}
```

Raw log attempt-02-before.jsonl
```jsonl
{"role":"B","event":"case_start","seq":1,"ms":94598728,"mode":"before","pid":60632,"uid":501,"absolute_deadline_ms":94605728}
{"role":"B","event":"owned","seq":2,"ms":94598729,"child":"E","pid":60633}
{"role":"B","event":"owned","seq":3,"ms":94598729,"child":"S","pid":60634}
{"role":"E","event":"fd_inventory","seq":1,"ms":94598729,"phase":"sentinel","open_known_fds":[3,4,7]}
{"role":"B","event":"assertion","seq":4,"ms":94598729,"name":"sentinel_ready","passed":true}
{"role":"B","event":"fd_inventory","seq":5,"ms":94598729,"phase":"browser_control_owner","open_known_fds":[0,1,2,3,5,6,9,10,12]}
{"role":"S","event":"owned","seq":1,"ms":94598730,"child":"C","pid":60635,"recorded_before_failure_injection":true}
{"role":"S","event":"assertion","seq":2,"ms":94598730,"name":"root_exit_observer_registered_before_release","passed":true}
{"role":"S","event":"fd_inventory","seq":3,"ms":94598730,"phase":"supervisor_owns_root","open_known_fds":[1,2,3,5,7,8,11,13]}
{"role":"C","event":"fd_inventory","seq":1,"ms":94598730,"phase":"root_gate","open_known_fds":[0,1,2,3,4]}
{"role":"S","event":"assertion","seq":4,"ms":94598735,"name":"root_is_distinct_session_and_group_leader","passed":true}
{"role":"S","event":"gate_ready","seq":5,"ms":94598735,"pid":60635,"pgid":60635,"sid":60635}
{"role":"B","event":"synthetic_browser_close_control","seq":6,"ms":94598735,"before_release":true}
{"role":"S","event":"browser_control_EOF","seq":6,"ms":94598741,"released":false}
{"role":"C","event":"gate_aborted","seq":2,"ms":94598741,"read_result":-1}
{"role":"S","event":"root_NOTE_EXIT","seq":7,"ms":94598746}
{"role":"S","event":"root_waitable_unreaped","seq":8,"ms":94598746,"waitid_rc":0,"status":77,"code":1,"output_eof":false}
{"role":"S","event":"signal","seq":9,"ms":94598746,"scope":"original_group","signo":9,"phase":"final_before_reap","rc":-1,"errno":1,"before_reap":true}
{"role":"S","event":"assertion","seq":10,"ms":94598746,"name":"root_observed_waitable_without_reaping","passed":true}
{"role":"S","event":"signals_permanently_disabled","seq":11,"ms":94598746,"syscall_count":1}
{"role":"S","event":"reap","seq":12,"ms":94598746,"child":"C","pid":60635,"exit":77,"signal":0}
{"role":"S","event":"assertion","seq":13,"ms":94598746,"name":"root_reaped","passed":true}
{"role":"S","event":"signal_guard_blocked","seq":14,"ms":94598746,"phase":"deliberate_post_reap_guard_check","root_reaped":true}
{"role":"S","event":"assertion","seq":15,"ms":94598746,"name":"no_signal_syscall_after_reap","passed":true}
{"role":"S","event":"assertion","seq":16,"ms":94598746,"name":"no_payload_started","passed":true}
{"role":"S","event":"supervisor_summary","seq":17,"ms":94598746,"failures":0,"root_reaped":true,"descendant_registered":false,"descendant_exit":false,"drained":0,"dropped":0,"EPIPE":0,"backpressure":0,"signal_syscalls":1}
{"role":"B","event":"assertion","seq":7,"ms":94598746,"name":"supervisor_completion_received","passed":true}
{"role":"B","event":"reap","seq":8,"ms":94598753,"child":"S","pid":60634,"exit":0,"signal":0}
{"role":"B","event":"assertion","seq":9,"ms":94598753,"name":"sentinel_ping_sent_after_worker_cleanup","passed":true}
{"role":"B","event":"assertion","seq":10,"ms":94598753,"name":"sentinel_unaffected","passed":true}
{"role":"E","event":"sentinel_exit","seq":2,"ms":94598753}
{"role":"B","event":"reap","seq":11,"ms":94598759,"child":"E","pid":60633,"exit":0,"signal":0}
{"role":"B","event":"case_end","seq":12,"ms":94598759,"failures":0,"supervisor_reaped":true,"sentinel_reaped":true}
```

Raw log attempt-03-running.jsonl
```jsonl
{"role":"B","event":"case_start","seq":1,"ms":94598770,"mode":"running","pid":60636,"uid":501,"absolute_deadline_ms":94605770}
{"role":"B","event":"owned","seq":2,"ms":94598770,"child":"E","pid":60637}
{"role":"B","event":"owned","seq":3,"ms":94598771,"child":"S","pid":60638}
{"role":"E","event":"fd_inventory","seq":1,"ms":94598771,"phase":"sentinel","open_known_fds":[3,4,7]}
{"role":"B","event":"assertion","seq":4,"ms":94598771,"name":"sentinel_ready","passed":true}
{"role":"B","event":"fd_inventory","seq":5,"ms":94598771,"phase":"browser_control_owner","open_known_fds":[0,1,2,3,5,6,9,10,12]}
{"role":"S","event":"owned","seq":1,"ms":94598771,"child":"C","pid":60639,"recorded_before_failure_injection":true}
{"role":"S","event":"assertion","seq":2,"ms":94598771,"name":"root_exit_observer_registered_before_release","passed":true}
{"role":"S","event":"fd_inventory","seq":3,"ms":94598771,"phase":"supervisor_owns_root","open_known_fds":[1,2,3,5,7,8,11,13]}
{"role":"C","event":"fd_inventory","seq":1,"ms":94598771,"phase":"root_gate","open_known_fds":[0,1,2,3,4]}
{"role":"S","event":"assertion","seq":4,"ms":94598777,"name":"root_is_distinct_session_and_group_leader","passed":true}
{"role":"S","event":"gate_ready","seq":5,"ms":94598777,"pid":60639,"pgid":60639,"sid":60639}
{"role":"B","event":"assertion","seq":6,"ms":94598777,"name":"browser_release_sent","passed":true}
{"role":"S","event":"assertion","seq":6,"ms":94598782,"name":"gate_release_written","passed":true}
{"role":"S","event":"gate_release","seq":7,"ms":94598782,"observer_registered":true}
{"role":"C","event":"payload_begin","seq":2,"ms":94598782,"pid":60639}
{"role":"C","event":"fd_inventory","seq":3,"ms":94598782,"phase":"root_payload_before_trace_close","open_known_fds":[1,2,3]}
{"role":"S","event":"payload_ready","seq":8,"ms":94598788}
{"role":"B","event":"synthetic_browser_close_output","seq":7,"ms":94598788}
{"role":"B","event":"synthetic_browser_close_control","seq":8,"ms":94598854,"before_release":false}
{"role":"S","event":"browser_control_EOF","seq":9,"ms":94598856,"released":true}
{"role":"S","event":"signal","seq":10,"ms":94598856,"scope":"original_group","signo":15,"phase":"browser_EOF","rc":0,"errno":0,"before_reap":true}
{"role":"S","event":"root_NOTE_EXIT","seq":11,"ms":94598862}
{"role":"S","event":"root_waitable_unreaped","seq":12,"ms":94598862,"waitid_rc":0,"status":15,"code":2,"output_eof":false}
{"role":"S","event":"signal","seq":13,"ms":94598862,"scope":"original_group","signo":9,"phase":"final_before_reap","rc":-1,"errno":1,"before_reap":true}
{"role":"S","event":"assertion","seq":14,"ms":94598862,"name":"root_observed_waitable_without_reaping","passed":true}
{"role":"S","event":"signals_permanently_disabled","seq":15,"ms":94598862,"syscall_count":2}
{"role":"S","event":"reap","seq":16,"ms":94598862,"child":"C","pid":60639,"exit":-1,"signal":15}
{"role":"S","event":"assertion","seq":17,"ms":94598862,"name":"root_reaped","passed":true}
{"role":"S","event":"signal_guard_blocked","seq":18,"ms":94598862,"phase":"deliberate_post_reap_guard_check","root_reaped":true}
{"role":"S","event":"assertion","seq":19,"ms":94598862,"name":"no_signal_syscall_after_reap","passed":true}
{"role":"S","event":"assertion","seq":20,"ms":94598862,"name":"browser_output_EPIPE_handled","passed":true}
{"role":"S","event":"supervisor_summary","seq":21,"ms":94598862,"failures":0,"root_reaped":true,"descendant_registered":false,"descendant_exit":false,"drained":917504,"dropped":851968,"EPIPE":1,"backpressure":0,"signal_syscalls":2}
{"role":"B","event":"assertion","seq":9,"ms":94598862,"name":"supervisor_completion_received","passed":true}
{"role":"B","event":"reap","seq":10,"ms":94598868,"child":"S","pid":60638,"exit":0,"signal":0}
{"role":"B","event":"assertion","seq":11,"ms":94598868,"name":"sentinel_ping_sent_after_worker_cleanup","passed":true}
{"role":"B","event":"assertion","seq":12,"ms":94598868,"name":"sentinel_unaffected","passed":true}
{"role":"E","event":"sentinel_exit","seq":2,"ms":94598868}
{"role":"B","event":"reap","seq":13,"ms":94598873,"child":"E","pid":60637,"exit":0,"signal":0}
{"role":"B","event":"case_end","seq":14,"ms":94598873,"failures":0,"supervisor_reaped":true,"sentinel_reaped":true}
```

Raw log attempt-04-partial.jsonl
```jsonl
{"role":"B","event":"case_start","seq":1,"ms":94598887,"mode":"partial","pid":60640,"uid":501,"absolute_deadline_ms":94605887}
{"role":"B","event":"owned","seq":2,"ms":94598888,"child":"E","pid":60641}
{"role":"E","event":"fd_inventory","seq":1,"ms":94598888,"phase":"sentinel","open_known_fds":[3,4,7]}
{"role":"B","event":"owned","seq":3,"ms":94598888,"child":"S","pid":60642}
{"role":"B","event":"assertion","seq":4,"ms":94598888,"name":"sentinel_ready","passed":true}
{"role":"B","event":"fd_inventory","seq":5,"ms":94598888,"phase":"browser_control_owner","open_known_fds":[0,1,2,3,5,6,9,10,12]}
{"role":"S","event":"owned","seq":1,"ms":94598888,"child":"C","pid":60643,"recorded_before_failure_injection":true}
{"role":"S","event":"assertion","seq":2,"ms":94598888,"name":"root_exit_observer_registered_before_release","passed":true}
{"role":"S","event":"fd_inventory","seq":3,"ms":94598888,"phase":"supervisor_owns_root","open_known_fds":[1,2,3,5,7,8,11,13]}
{"role":"S","event":"injected_failure","seq":4,"ms":94598888,"phase":"after_root_creation_and_ownership_before_ready"}
{"role":"S","event":"signal","seq":5,"ms":94598888,"scope":"unreaped_direct_root","signo":15,"phase":"partial_setup","rc":0,"errno":0,"before_reap":true}
{"role":"S","event":"root_NOTE_EXIT","seq":6,"ms":94598894}
{"role":"S","event":"root_waitable_unreaped","seq":7,"ms":94598894,"waitid_rc":0,"status":15,"code":2,"output_eof":false}
{"role":"S","event":"signal","seq":8,"ms":94598894,"scope":"unreaped_direct_root","signo":9,"phase":"final_before_reap","rc":0,"errno":0,"before_reap":true}
{"role":"S","event":"assertion","seq":9,"ms":94598894,"name":"root_observed_waitable_without_reaping","passed":true}
{"role":"S","event":"signals_permanently_disabled","seq":10,"ms":94598894,"syscall_count":2}
{"role":"S","event":"reap","seq":11,"ms":94598894,"child":"C","pid":60643,"exit":-1,"signal":15}
{"role":"S","event":"assertion","seq":12,"ms":94598894,"name":"root_reaped","passed":true}
{"role":"S","event":"signal_guard_blocked","seq":13,"ms":94598894,"phase":"deliberate_post_reap_guard_check","root_reaped":true}
{"role":"S","event":"assertion","seq":14,"ms":94598894,"name":"no_signal_syscall_after_reap","passed":true}
{"role":"S","event":"assertion","seq":15,"ms":94598894,"name":"no_payload_started","passed":true}
{"role":"S","event":"supervisor_summary","seq":16,"ms":94598894,"failures":0,"root_reaped":true,"descendant_registered":false,"descendant_exit":false,"drained":0,"dropped":0,"EPIPE":0,"backpressure":0,"signal_syscalls":2}
{"role":"B","event":"assertion","seq":6,"ms":94598894,"name":"supervisor_completion_received","passed":true}
{"role":"B","event":"reap","seq":7,"ms":94598900,"child":"S","pid":60642,"exit":0,"signal":0}
{"role":"B","event":"assertion","seq":8,"ms":94598900,"name":"sentinel_ping_sent_after_worker_cleanup","passed":true}
{"role":"B","event":"assertion","seq":9,"ms":94598900,"name":"sentinel_unaffected","passed":true}
{"role":"E","event":"sentinel_exit","seq":2,"ms":94598900}
{"role":"B","event":"reap","seq":10,"ms":94598907,"child":"E","pid":60641,"exit":0,"signal":0}
{"role":"B","event":"case_end","seq":11,"ms":94598907,"failures":0,"supervisor_reaped":true,"sentinel_reaped":true}
```

Exact source prototype.c
```c
#include <sys/types.h>
#include <sys/event.h>
#include <sys/wait.h>
#include <sys/time.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* Self-authored finite fixture, not a product launcher or Seatbelt qualification. */
static int trace_fd = -1, known[64], known_count;
static long long deadline_ms;
static const char *role = "B", *mode;
static unsigned seq;
static int failures;
static long long now_ms(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static void note(const char *event, const char *fmt, ...) {
    char fields[1500], line[1900];
    va_list ap; va_start(ap, fmt); vsnprintf(fields, sizeof(fields), fmt, ap); va_end(ap);
    int n = snprintf(line, sizeof(line), "{\"role\":\"%s\",\"event\":\"%s\",\"seq\":%u,\"ms\":%lld%s%s}\n",
                     role, event, ++seq, now_ms(), *fields ? "," : "", fields);
    if (n <= 0 || n >= (int)sizeof(line)) _exit(99);
    /* Each bounded record is one pipe write, smaller than PIPE_BUF. */
    if (write(trace_fd, line, (size_t)n) != n) _exit(98);
}
static void check(const char *name, bool pass) {
    note("assertion", "\"name\":\"%s\",\"passed\":%s", name, pass ? "true" : "false");
    if (!pass) failures++;
}
static int remember(int fd) {
    if (fd < 0 || known_count >= 64) _exit(97);
    known[known_count++] = fd;
    return fd;
}
static void make_pipe(int p[2]) {
    if (pipe(p) != 0) _exit(96);
    remember(p[0]); remember(p[1]);
    if (fcntl(p[0], F_SETFD, FD_CLOEXEC) || fcntl(p[1], F_SETFD, FD_CLOEXEC)) _exit(95);
}
static void nonblock(int fd) {
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) _exit(94);
}
static bool is_kept(int fd, const int *keep, size_t count) {
    for (size_t i = 0; i < count; i++) if (fd == keep[i]) return true;
    return false;
}
static void close_except(const int *keep, size_t count) {
    for (int i = 0; i < known_count; i++)
        if (!is_kept(known[i], keep, count)) close(known[i]);
}
static void inventory(const char *phase) {
    char buf[600]; size_t off = 0; bool first = true;
    for (int i = 0; i < known_count; i++) {
        bool duplicate = false;
        for (int j = 0; j < i; j++) if (known[j] == known[i]) duplicate = true;
        if (!duplicate && fcntl(known[i], F_GETFD) >= 0) {
            off += (size_t)snprintf(buf + off, sizeof(buf) - off, "%s%d", first ? "" : ",", known[i]);
            first = false;
        }
    }
    note("fd_inventory", "\"phase\":\"%s\",\"open_known_fds\":[%s]", phase, buf);
}
static void arm_expiry(void) {
    struct sigaction sa; memset(&sa, 0, sizeof(sa));
    sa.sa_handler = SIG_DFL; sigemptyset(&sa.sa_mask);
    sigaction(SIGALRM, &sa, NULL); sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL); sigaction(SIGCHLD, &sa, NULL);
    sigset_t empty; sigemptyset(&empty); sigprocmask(SIG_SETMASK, &empty, NULL);
    signal(SIGPIPE, SIG_IGN);
    long long remaining = deadline_ms - now_ms();
    if (remaining <= 0 || remaining > 8000) _exit(93);
    struct itimerval it; memset(&it, 0, sizeof(it));
    it.it_value.tv_sec = remaining / 1000; it.it_value.tv_usec = (remaining % 1000) * 1000;
    if (setitimer(ITIMER_REAL, &it, NULL) != 0) _exit(92);
}
static void nap(int ms) {
    struct timespec t = { .tv_sec = ms / 1000, .tv_nsec = (ms % 1000) * 1000000L };
    nanosleep(&t, NULL);
}
static bool put(int fd, char c) { return write(fd, &c, 1) == 1; }
static int get_byte(int fd, int timeout) {
    struct pollfd p = { .fd = fd, .events = POLLIN };
    int n = poll(&p, 1, timeout);
    if (n == 0) return -2;
    if (n < 0) return -3;
    char c; n = (int)read(fd, &c, 1);
    return n == 1 ? (unsigned char)c : -1;
}
static bool reap_direct(pid_t *pid, const char *label, int timeout) {
    long long end = now_ms() + timeout;
    for (; now_ms() < end;) {
        int status = 0; pid_t r = waitpid(*pid, &status, WNOHANG);
        if (r == *pid) {
            note("reap", "\"child\":\"%s\",\"pid\":%d,\"exit\":%d,\"signal\":%d", label, *pid,
                 WIFEXITED(status) ? WEXITSTATUS(status) : -1, WIFSIGNALED(status) ? WTERMSIG(status) : 0);
            *pid = -1; return true;
        }
        if (r < 0 && errno != EINTR) {
            note("ownership_lost", "\"child\":\"%s\",\"errno\":%d", label, errno);
            *pid = -1; return false;
        }
        nap(5);
    }
    return false;
}
static void finish_direct(pid_t *pid, const char *label) {
    if (*pid <= 0) return;
    if (reap_direct(pid, label, 100)) return;
    if (*pid > 0) {
        int rc = kill(*pid, SIGKILL), e = rc < 0 ? errno : 0;
        note("direct_cleanup_signal", "\"child\":\"%s\",\"pid\":%d,\"rc\":%d,\"errno\":%d", label, *pid, rc, e);
        check("owned_direct_child_cleanup_reaped", reap_direct(pid, label, 500));
    }
}
struct message { int type; pid_t pid, pgid, sid; };
static void send_message(int fd, int type) {
    struct message m = { .type = type, .pid = getpid(), .pgid = getpgrp(), .sid = getsid(0) };
    if (write(fd, &m, sizeof(m)) != (ssize_t)sizeof(m)) _exit(91);
}
static void sentinel(int command, int response) {
    role = "E"; seq = 0; arm_expiry();
    int keep[] = { trace_fd, command, response }; close_except(keep, 3);
    inventory("sentinel");
    put(response, 'R');
    while (now_ms() < deadline_ms) {
        int c = get_byte(command, 100);
        if (c == 'p') put(response, 'P');
        else if (c == 'q' || c == -1) { note("sentinel_exit", ""); _exit(0); }
    }
    _exit(90);
}
static void noisy_payload(void) {
    const char spoof[] = "{\"role\":\"S\",\"event\":\"reap\",\"child\":\"FORGED_PAYLOAD_RECORD\"}\n";
    (void)write(STDOUT_FILENO, spoof, sizeof(spoof) - 1);
    char block[4096]; memset(block, 'x', sizeof(block));
    for (int i = 0; i < 512 && now_ms() < deadline_ms; i++) {
        ssize_t n = write(STDOUT_FILENO, block, sizeof(block));
        if (n < 0 && errno == EINTR) { i--; continue; }
        if (n < 0) break;
    }
    while (now_ms() < deadline_ms) nap(50); /* Hold output open until cleanup/expiry. */
    _exit(89);
}
static void descendant(int release) {
    role = "D"; seq = 0; arm_expiry();
    int keep[] = { trace_fd, release, STDOUT_FILENO, STDERR_FILENO }; close_except(keep, 4);
    inventory("descendant_blocked");
    if (get_byte(release, 1500) != 'G') _exit(78);
    close(release);
    inventory("descendant_payload_before_trace_close");
    note("descendant_released", "\"pid\":%d,\"pgid\":%d", getpid(), getpgrp());
    close(trace_fd); /* Only stdout/stderr remain in payload, no lifecycle writers. */
    noisy_payload();
}
static void root_child(int release, int status, int output) {
    role = "C"; seq = 0; arm_expiry();
    if (dup2(output, STDOUT_FILENO) < 0 || dup2(output, STDERR_FILENO) < 0) _exit(88);
    int keep[] = { trace_fd, release, status, STDOUT_FILENO, STDERR_FILENO }; close_except(keep, 5);
    if (setsid() != getpid()) _exit(87);
    inventory("root_gate"); send_message(status, 'R');
    int go = get_byte(release, 1500);
    if (go != 'G') { note("gate_aborted", "\"read_result\":%d", go); _exit(77); }
    note("payload_begin", "\"pid\":%d", getpid());
    if (strcmp(mode, "normal") == 0) {
        int dg[2]; make_pipe(dg);
        pid_t d = fork();
        if (d == 0) { close(dg[1]); descendant(dg[0]); _exit(86); }
        if (d < 0) _exit(85);
        note("owned", "\"child\":\"D\",\"pid\":%d", d); /* Before any failure/release. */
        close(dg[0]);
        struct message m = { .type = 'D', .pid = d, .pgid = getpgrp(), .sid = getsid(0) };
        if (write(status, &m, sizeof(m)) != (ssize_t)sizeof(m)) _exit(84);
        if (get_byte(release, 1000) != 'A') { close(dg[1]); _exit(83); }
        put(dg[1], 'G'); close(dg[1]);
        send_message(status, 'P'); close(status); close(release);
        note("root_will_exit_with_writer", "\"descendant\":%d", d);
        close(trace_fd); nap(120); _exit(0); /* D retains output, and is NOT reaped here. */
    }
    send_message(status, 'P'); close(status); close(release);
    inventory("root_payload_before_trace_close"); close(trace_fd);
    noisy_payload();
}
struct supervisor {
    pid_t root, descendant;
    int ctrl, status, forward, gate, ready, output, kq;
    bool group_verified, signal_enabled, root_waitable, root_reaped, descendant_registered;
    bool descendant_exited, released, cancelled, output_eof, saw_payload, forward_closed;
    unsigned signals, blocked_signals;
    size_t drained, dropped;
    int epipe, backpressure;
};
static void actual_signal(struct supervisor *s, int signo, const char *phase) {
    if (!s->signal_enabled || s->root <= 0 || s->root_reaped) {
        s->blocked_signals++;
        note("signal_guard_blocked", "\"phase\":\"%s\",\"root_reaped\":%s", phase, s->root_reaped ? "true" : "false");
        return;
    }
    pid_t target = s->group_verified ? -s->root : s->root;
    int rc = kill(target, signo), e = rc < 0 ? errno : 0;
    s->signals++;
    note("signal", "\"scope\":\"%s\",\"signo\":%d,\"phase\":\"%s\",\"rc\":%d,\"errno\":%d,\"before_reap\":true",
         s->group_verified ? "original_group" : "unreaped_direct_root", signo, phase, rc, e);
}
static bool register_exit(int kq, pid_t pid) {
    struct kevent e; EV_SET(&e, (uintptr_t)pid, EVFILT_PROC, EV_ADD | EV_ENABLE, NOTE_EXIT, 0, NULL);
    return kevent(kq, &e, 1, NULL, 0, NULL) == 0;
}
static void drain_output(struct supervisor *s) {
    char buf[4096];
    for (int i = 0; i < 16; i++) { /* Fair bounded batch: cancellation cannot starve. */
        ssize_t n = read(s->output, buf, sizeof(buf));
        if (n == 0) { s->output_eof = true; return; }
        if (n < 0) return;
        s->drained += (size_t)n;
        if (s->forward_closed) { s->dropped += (size_t)n; continue; }
        ssize_t w = write(s->forward, buf, (size_t)n);
        if (w < 0) {
            if (errno == EPIPE) { s->epipe++; s->forward_closed = true; }
            else if (errno == EAGAIN || errno == EWOULDBLOCK) s->backpressure++;
            else failures++;
            s->dropped += (size_t)n;
        } else if (w < n) { s->dropped += (size_t)(n - w); s->backpressure++; }
    }
}
static void observe(struct supervisor *s) {
    struct kevent e[4]; struct timespec zero = {0, 0};
    int n = kevent(s->kq, NULL, 0, e, 4, &zero);
    for (int i = 0; i < n; i++) {
        if (e[i].filter == EVFILT_PROC && (e[i].fflags & NOTE_EXIT)) {
            if (e[i].ident == (uintptr_t)s->descendant) {
                s->descendant_exited = true; note("descendant_NOTE_EXIT", "\"registered_before_release\":true");
            } else if (e[i].ident == (uintptr_t)s->root) note("root_NOTE_EXIT", "");
        }
    }
    if (!s->root_waitable && s->root > 0) {
        siginfo_t info; memset(&info, 0, sizeof(info));
        int rc = waitid(P_PID, (id_t)s->root, &info, WEXITED | WNOHANG | WNOWAIT);
        if (rc == 0 && info.si_pid == s->root) {
            s->root_waitable = true;
            note("root_waitable_unreaped", "\"waitid_rc\":0,\"status\":%d,\"code\":%d,\"output_eof\":%s",
                 info.si_status, info.si_code, s->output_eof ? "true" : "false");
        } else if (rc < 0 && errno != EINTR) {
            note("waitid_error", "\"errno\":%d", errno); failures++;
            if (errno == ECHILD) s->signal_enabled = false;
        }
    }
}
static void supervisor(int ctrl, int status, int forward) {
    role = "S"; seq = 0; failures = 0; arm_expiry();
    int keep[] = { trace_fd, ctrl, status, forward }; close_except(keep, 4);
    nonblock(ctrl); nonblock(forward);
    int gate[2], ready[2], out[2]; make_pipe(gate); make_pipe(ready); make_pipe(out);
    struct supervisor s; memset(&s, 0, sizeof(s));
    s.ctrl = ctrl; s.status = status; s.forward = forward; s.descendant = -1;
    s.gate = gate[1]; s.ready = ready[0]; s.output = out[0];
    s.kq = remember(kqueue());
    s.root = fork();
    if (s.root == 0) { root_child(gate[0], ready[1], out[1]); _exit(82); }
    if (s.root < 0) _exit(81);
    s.signal_enabled = true;
    note("owned", "\"child\":\"C\",\"pid\":%d,\"recorded_before_failure_injection\":true", s.root);
    close(gate[0]); close(ready[1]); close(out[1]);
    nonblock(s.ready); nonblock(s.output);
    check("root_exit_observer_registered_before_release", register_exit(s.kq, s.root));
    inventory("supervisor_owns_root");
    bool partial = strcmp(mode, "partial") == 0;
    long long cleanup_at = 0;
    if (partial) {
        note("injected_failure", "\"phase\":\"after_root_creation_and_ownership_before_ready\"");
        s.cancelled = true; close(s.gate); s.gate = -1;
        actual_signal(&s, SIGTERM, "partial_setup"); cleanup_at = now_ms() + 120;
    }
    long long work_end = deadline_ms - 2200;
    while (now_ms() < work_end) {
        observe(&s); drain_output(&s);
        if (s.root_waitable) break;
        if (s.cancelled && now_ms() >= cleanup_at) break;
        if (!s.cancelled) {
            char commands[8]; ssize_t n = read(s.ctrl, commands, sizeof(commands));
            if (n == 0) {
                note("browser_control_EOF", "\"released\":%s", s.released ? "true" : "false");
                s.cancelled = true;
                if (s.gate >= 0) { close(s.gate); s.gate = -1; }
                if (s.released) actual_signal(&s, SIGTERM, "browser_EOF");
                cleanup_at = now_ms() + 120;
            } else if (n > 0) {
                for (ssize_t i = 0; i < n; i++) {
                    if (commands[i] == 'G' && s.group_verified && !s.released) {
                        check("gate_release_written", put(s.gate, 'G')); s.released = true;
                        note("gate_release", "\"observer_registered\":true");
                    }
                }
            }
        }
        struct message m;
        ssize_t n = read(s.ready, &m, sizeof(m));
        if (n == (ssize_t)sizeof(m)) {
            if (m.type == 'R' && !s.cancelled) {
                s.group_verified = m.pid == s.root && m.pgid == s.root && m.sid == s.root && getpgrp() != s.root;
                check("root_is_distinct_session_and_group_leader", s.group_verified);
                if (!s.group_verified) { s.cancelled = true; cleanup_at = now_ms(); }
                else { note("gate_ready", "\"pid\":%d,\"pgid\":%d,\"sid\":%d", m.pid, m.pgid, m.sid); put(status, 'R'); }
            } else if (m.type == 'D' && strcmp(mode, "normal") == 0 && s.released && !s.cancelled) {
                s.descendant = m.pid;
                s.descendant_registered = m.pgid == s.root && m.sid == s.root && register_exit(s.kq, m.pid);
                check("descendant_exit_registered_while_blocked", s.descendant_registered);
                if (s.descendant_registered) put(s.gate, 'A');
            } else if (m.type == 'P') { s.saw_payload = true; note("payload_ready", ""); put(status, 'P'); }
        }
        nap(5);
    }
    if (!s.root_waitable && !s.cancelled) { s.cancelled = true; note("native_deadline", ""); actual_signal(&s, SIGTERM, "native_deadline"); }
    if (s.gate >= 0) { close(s.gate); s.gate = -1; }
    if (strcmp(mode, "normal") == 0) check("root_exit_precedes_output_EOF", s.root_waitable && !s.output_eof);
    actual_signal(&s, SIGKILL, "final_before_reap");
    long long settle_end = now_ms() + 800;
    while (now_ms() < settle_end && (!s.root_waitable || (s.descendant_registered && !s.descendant_exited))) {
        observe(&s); drain_output(&s); nap(5);
    }
    check("root_observed_waitable_without_reaping", s.root_waitable);
    if (s.descendant_registered) check("registered_descendant_exit_confirmed", s.descendant_exited);
    s.signal_enabled = false; /* Permanent latch BEFORE the one reap; no retry timer survives. */
    note("signals_permanently_disabled", "\"syscall_count\":%u", s.signals);
    if (s.root_waitable) s.root_reaped = reap_direct(&s.root, "C", 100);
    check("root_reaped", s.root_reaped);
    unsigned prior = s.signals; actual_signal(&s, SIGKILL, "deliberate_post_reap_guard_check");
    check("no_signal_syscall_after_reap", s.root_reaped && s.signals == prior && s.blocked_signals == 1);
    if (!strcmp(mode, "before") || partial) check("no_payload_started", !s.released && !s.saw_payload);
    if (!strcmp(mode, "normal")) check("browser_backpressure_handled", s.backpressure > 0);
    if (!strcmp(mode, "running")) check("browser_output_EPIPE_handled", s.epipe > 0);
    note("supervisor_summary", "\"failures\":%d,\"root_reaped\":%s,\"descendant_registered\":%s,\"descendant_exit\":%s,\"drained\":%zu,\"dropped\":%zu,\"EPIPE\":%d,\"backpressure\":%d,\"signal_syscalls\":%u",
         failures, s.root_reaped ? "true" : "false", s.descendant_registered ? "true" : "false", s.descendant_exited ? "true" : "false",
         s.drained, s.dropped, s.epipe, s.backpressure, s.signals);
    put(status, 'F');
    _exit(failures ? 1 : 0);
}
int main(int argc, char **argv) {
    if (argc != 2 || getuid() == 0 || geteuid() == 0) return 2;
    mode = argv[1];
    if (strcmp(mode, "normal") && strcmp(mode, "before") && strcmp(mode, "running") && strcmp(mode, "partial")) return 2;
    remember(0); remember(1); remember(2); trace_fd = remember(dup(STDOUT_FILENO));
    deadline_ms = now_ms() + 7000; arm_expiry();
    note("case_start", "\"mode\":\"%s\",\"pid\":%d,\"uid\":%d,\"absolute_deadline_ms\":%lld", mode, getpid(), getuid(), deadline_ms);
    int ec[2], er[2], ctrl[2], stat[2], out[2];
    make_pipe(ec); make_pipe(er); make_pipe(ctrl); make_pipe(stat); make_pipe(out);
    pid_t e = fork();
    if (e == 0) { sentinel(ec[0], er[1]); _exit(80); }
    if (e < 0) return 3;
    note("owned", "\"child\":\"E\",\"pid\":%d", e);
    close(ec[0]); close(er[1]);
    pid_t s = fork();
    if (s == 0) { supervisor(ctrl[0], stat[1], out[1]); _exit(79); }
    if (s < 0) { finish_direct(&e, "E"); return 3; }
    note("owned", "\"child\":\"S\",\"pid\":%d", s);
    close(ctrl[0]); close(stat[1]); close(out[1]);
    check("sentinel_ready", get_byte(er[0], 1000) == 'R');
    inventory("browser_control_owner");
    bool finished = false, control_open = true, output_open = true;
    long long stop_at = 0, end = deadline_ms - 1000;
    while (now_ms() < end && !finished) {
        int c = get_byte(stat[0], 10);
        if (c == 'R') {
            if (!strcmp(mode, "before")) { close(ctrl[1]); control_open = false; note("synthetic_browser_close_control", "\"before_release\":true"); }
            else if (strcmp(mode, "partial")) check("browser_release_sent", put(ctrl[1], 'G'));
        } else if (c == 'P' && !strcmp(mode, "running")) {
            close(out[0]); output_open = false; stop_at = now_ms() + 60;
            note("synthetic_browser_close_output", "");
        } else if (c == 'F') finished = true;
        else if (c == -1) break;
        if (stop_at && now_ms() >= stop_at && control_open) {
            close(ctrl[1]); control_open = false; note("synthetic_browser_close_control", "\"before_release\":false");
        }
        /* Intentionally never drain B's output reader: normal case tests backpressure. */
    }
    if (control_open) close(ctrl[1]);
    if (output_open) close(out[0]);
    check("supervisor_completion_received", finished);
    finish_direct(&s, "S");
    check("sentinel_ping_sent_after_worker_cleanup", put(ec[1], 'p'));
    check("sentinel_unaffected", get_byte(er[0], 500) == 'P');
    put(ec[1], 'q'); finish_direct(&e, "E");
    note("case_end", "\"failures\":%d,\"supervisor_reaped\":%s,\"sentinel_reaped\":%s", failures, s < 0 ? "true" : "false", e < 0 ? "true" : "false");
    return failures ? 1 : 0;
}

```

Exact source driver.py
```python
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
CASES = {'normal': 5, 'before': 4, 'running': 4, 'partial': 4}

def save(path, obj):
    path.write_text(json.dumps(obj, indent=2) + '\n', encoding='utf-8')

def run(case):
    budget_path = ROOT / 'birth-budget.json'
    budget = json.loads(budget_path.read_text()) if budget_path.exists() else {
        'reserved_births': 0, 'first_launch_monotonic': time.monotonic(), 'attempts': []}
    if case not in CASES or budget['reserved_births'] + CASES[case] > 32:
        raise RuntimeError('Finite birth budget would be exceeded')
    if time.monotonic() - budget['first_launch_monotonic'] > 105:
        raise RuntimeError('No launch allowed: overall 120-second deadline reserve')
    attempt = len(budget['attempts']) + 1
    base = f'attempt-{attempt:02d}-{case}'
    entry = {'attempt': attempt, 'case': case, 'maximum_births': CASES[case]}
    budget['reserved_births'] += CASES[case]
    budget['attempts'].append(entry)
    save(budget_path, budget)  # Reservation persists BEFORE any process launch.
    save(ROOT / (base + '-intent.json'), {
        **entry, 'created_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'timeout_seconds': 12, 'all_role_absolute_expiry_seconds': 7,
        'max_live_fixture_roles': CASES[case], 'uid': os.getuid(),
        'prototype_sha256': hashlib.sha256((ROOT / 'prototype').read_bytes()).hexdigest(),
        'source_sha256': hashlib.sha256((ROOT / 'prototype.c').read_bytes()).hexdigest()})
    started = time.monotonic()
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(ROOT), 'TMPDIR': str(ROOT)}
    child = subprocess.Popen([str(ROOT / 'prototype'), case], cwd=ROOT, env=env,
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, close_fds=True, text=True)
    save(ROOT / (base + '-browser-owned.json'), {
        'role': 'B', 'pid': child.pid, 'ownership': 'unreaped_direct_child_of_driver',
        'recorded_before_reading_any_setup_response': True})
    timed_out = False
    try:
        output, _ = child.communicate(timeout=12)
    except subprocess.TimeoutExpired:
        timed_out = True
        # Only the driver's own direct child; never a group or discovered PID.
        child.kill()
        output, _ = child.communicate(timeout=2)
    elapsed = time.monotonic() - started
    log = ROOT / (base + '.jsonl')
    log.write_text(output, encoding='utf-8')
    events, parse_errors = [], []
    for number, line in enumerate(output.splitlines(), 1):
        try:
            events.append(json.loads(line))
        except ValueError:
            parse_errors.append(number)
    assertions = [e for e in events if e.get('event') == 'assertion']
    failed = [e for e in assertions if not e.get('passed')]
    own = [e for e in events if e.get('event') == 'owned']
    reaps = [e for e in events if e.get('event') == 'reap']
    summaries = [e for e in events if e.get('event') == 'supervisor_summary']
    ends = [e for e in events if e.get('event') == 'case_end']
    by_child = {e['child']: e for e in own}
    direct_proofs = {name: any(e['role'] == parent and e['child'] == name and
                          e['pid'] == by_child.get(name, {}).get('pid')
                          for e in reaps)
                     for name, parent in [('S', 'B'), ('C', 'S'), ('E', 'B')]}
    d_observed = any(e.get('event') == 'descendant_NOTE_EXIT' and
                     e.get('registered_before_release') for e in events)
    signals = [e for e in events if e.get('role') == 'S' and e.get('event') == 'signal']
    root_reaps = [e for e in reaps if e['role'] == 'S' and e['child'] == 'C']
    ordering = bool(signals and root_reaps and all(
        e['seq'] < root_reaps[0]['seq'] for e in signals))
    disabled = any(e.get('event') == 'signals_permanently_disabled' and
                   root_reaps and e['seq'] < root_reaps[0]['seq'] for e in events)
    guard = any(e.get('event') == 'signal_guard_blocked' and e.get('root_reaped')
                for e in events)
    forged = any(e.get('child') == 'FORGED_PAYLOAD_RECORD' for e in events)
    checks = {
        'all_assertions_passed': bool(assertions) and not failed,
        'no_trace_parse_errors': not parse_errors,
        'driver_reaped_browser_exit_zero': child.returncode == 0,
        'supervisor_summary_success': len(summaries) == 1 and summaries[0]['failures'] == 0,
        'browser_summary_success': len(ends) == 1 and ends[0]['failures'] == 0,
        'supervisor_exited_zero': any(e['child'] == 'S' and e['exit'] == 0 and e['signal'] == 0 for e in reaps),
        'owned_direct_children_all_reaped': all(direct_proofs.values()),
        'descendant_known_instance_exited': d_observed if case == 'normal' else 'D' not in by_child,
        'signals_all_precede_root_reap': ordering,
        'signal_latch_disabled_before_reap': disabled,
        'post_reap_signal_guard_blocks_syscall': guard,
        'untrusted_output_not_parsed_as_lifecycle': not forged,
        'case_under_15_seconds': elapsed < 15,
        'no_timeout': not timed_out,
        'births_within_reservation': 1 + len(own) <= CASES[case],
    }
    result = {
        **entry, 'returncode': child.returncode, 'duration_seconds': elapsed,
        'timeout': timed_out, 'actual_births': 1 + len(own),
        'driver_browser_reap': {'pid': child.pid, 'returncode': child.returncode},
        'assertion_count': len(assertions), 'failed_assertions': failed,
        'checks': checks, 'passed': all(checks.values()),
        'no_live_owned_fixtures_confirmed': all(direct_proofs.values()) and
             child.returncode is not None and (d_observed if case == 'normal' else 'D' not in by_child),
        'direct_reaps': reaps,
        'descendant_reap_accounting': 'D exit observed through registered NOTE_EXIT; after C normal exit D is reparented. No direct D wait/reap is claimed.' if case == 'normal' else 'No descendant created',
        'signal_reap_trace': [e for e in events if e.get('role') == 'S' and e.get('event') in
            ['root_waitable_unreaped', 'signal', 'descendant_NOTE_EXIT',
             'signals_permanently_disabled', 'reap', 'signal_guard_blocked']],
        'log_path': str(log), 'log_sha256': hashlib.sha256(log.read_bytes()).hexdigest(),
        'total_reserved_births': budget['reserved_births'],
        'overall_wall_seconds': time.monotonic() - budget['first_launch_monotonic']}
    save(ROOT / (base + '-result.json'), result)
    print(json.dumps({k: result[k] for k in ['case','passed','actual_births','assertion_count',
          'failed_assertions','checks','duration_seconds','no_live_owned_fixtures_confirmed',
          'overall_wall_seconds','log_path']}), flush=True)
    return result['passed']

if __name__ == '__main__':
    if os.getuid() == 0 or os.geteuid() == 0:
        raise SystemExit('Refusing root')
    requested = list(CASES) if len(sys.argv) == 1 else sys.argv[1:]
    if len(requested) > 4:
        raise SystemExit('At most four cases per invocation')
    for name in requested:
        if not run(name):
            raise SystemExit(1)  # Preserve failure; never automatically retry.

```

Exact source SAFETY-PLAN.txt
```text
No launches before this plan and sources are retained. Four finite cases: normal (B,S,C,D,E = 5 births); before (B,S,C,E = 4); running (4); partial (4). Planned total 17; all attempts together capped at 32. Maximum 5 live fixture roles (plus independent driver W). All B/S/C/D/E recompute a shared absolute seven-second deadline and arm ITIMER_REAL immediately after fork, before blocking; no exec in this slice. Driver timeout 12 seconds per case, whole run 120 seconds. Every parent logs and owns the exact unreaped direct child before failure injection. S may signal only original PGID=unreaped PID(C) after session/group setup, otherwise only direct unreaped C. S permanently disables signaling before reap. B/driver fallback may signal only their own unreaped direct children. D is gated until S registers NOTE_EXIT, then killed only via C original group; D exit confirmed via the registered kernel event, OS adoption/reaping distinguished from direct wait receipts. No PID/group scans. No detachment, network, actual app, sandbox-exec or third-party code. All payloads self-authored synthetic natives. Payload output is isolated from lifecycle pipe. Preserve all failed sources/logs/binaries; no broad cleanup or old-file deletion.

```

Manifest: /private/tmp/freedom-retained-root-probe-y9rnyohd/manifest.json SHA256 8d44751da6b5e64c0266638fbac3fb709c0f48a12006fe4d13afb2936fecb2b6
