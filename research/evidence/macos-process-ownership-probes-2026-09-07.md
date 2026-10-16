# Disposable-Mac process ownership API probe evidence

Recorded 2026-09-07 from the explicit reply to `macmini/req-309da218615885d92e02b58e85f956ef`. This is a retained remote report and verbatim probe source, not a product qualification or executable installation. The primary agent checked that the three source blocks match their reported SHA-256 hashes. The sources were not compiled or run on the primary Mac. The original failed attempt is preserved alongside the successful revision.

The two authorized native discriminants are complete. Probe A confirms NOTE_TRACK is unsupported on this host while NOTE_FORK/NOTE_EXIT work. Probe B confirms genuine audit-token acquisition and identity-bound SIGUSR1 signaling work for these owned, unprivileged direct children, and that exec invalidates the old token. All three fixtures exited with code 0 and were reaped. No surviving fixture remains. The first, pre-fork failed attempt is retained below; nothing was silently replaced.

Host/repositories
- Mac.fritz.box, uid 501, Darwin arm64; macOS 15.6 (24G84). clang 17.0.0 (clang-1700.0.13.5), installed SDK 15.5 via /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk.
- Working directory /Users/flobot/Git/freedom-dev is not a Git repository.
- /Users/flobot/Git/freedom-dev/freedom-browser: codex/agent-workspace-macos-qualification, HEAD 11a863ecad4c02ed139040243d0ed657b7a1443b, git status --short empty before and after.
- /Users/flobot/Git/freedom-browser: feature/swarm-publishing-updated, HEAD 38b07f33bae548f167114ea615770e4871525ea4, git status --short empty before and after.
Both checkouts were untouched. No product implementation, lint/full qualification, packaging, network fixtures, root, entitlements, services, OS limits/configuration changes, detached grandchildren, external software or other-machine work occurred. Native runs used approved removal of the outer automation sandbox, still uid 501; no privilege/API fallback was required.

Retained evidence directory
/private/tmp/freedom-native-discriminants-r88pkwsx
JSON manifest: /private/tmp/freedom-native-discriminants-r88pkwsx/result-manifest.json
Prior assessment remains: /private/tmp/herdr-peer-macos-ownership-8f9qydsp.md
The manifest records every input/output hash, compiler commands and results, run commands, full assertion events, identity, cleanup proof and the primary-supplied XNU mapping xnu-11417.140.69 -> 43a90889846e00bfb5cf1d255cdc0a701a1e05a4. I did not re-resolve that mapping or upgrade SDK/OS.

Compiler
Both attempts compiled successfully with no diagnostics, using existing clang and SDK only. Final command:
/usr/bin/clang -std=c11 -Wall -Wextra -Werror -O0 -g -isysroot /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk /private/tmp/freedom-native-discriminants-r88pkwsx/probe-v2.c -o /private/tmp/freedom-native-discriminants-r88pkwsx/probe-v2 -lproc
Original command is compiler-command.txt (same options, probe.c -> probe); final command is compiler-command-v2.txt (probe-v2.c -> probe-v2). compiler.log and compiler-v2.log are empty successful compiler logs, accompanied by compile-result.json and compile-result-v2.json. No source or executable was overwritten between attempts.

Actual results and errors
Probe A initial attempt: executable exit 1; one assertion failed before fork, births 0. Source's descriptor-sweep safety guard refused RLIMIT_NOFILE above 65536; read-only query recorded soft limit 1048575. Revised source tracks and closes only descriptors opened by the harness, and the driver explicitly closes inherited descriptors. No process limits were changed. Original source, binary, compiler record and probe-A.jsonl remain intact.

Probe A revised: exit 0, 10/10 assertions; one direct fixture, 2 ms measured inside probe, 0.185807167 s driver wall time. kqueue creation and self NOTE_FORK registration succeeded. Monitoring the harness observed its single fork. On the still-blocked owned child, NOTE_TRACK registration with EV_RECEIPT returned one receipt carrying EV_ERROR data 45 (ENOTSUP); this is the event receipt's error, not a claim that kevent returned -1. Independent NOTE_EXIT registration returned receipt error 0. Releasing the child produced NOTE_EXIT. Child was subsequently reaped with exit 0.

Probe B revised: exit 0, 17/17 assertions; two direct fixtures, 480 ms inside probe, 0.484809166 s driver wall time.
- Before exec: task_name_for_pid -> KERN_SUCCESS (0); task_info(TASK_AUDIT_TOKEN) -> KERN_SUCCESS (0), expected result count.
- Deliberately changed PID-version copy -> proc_signal_with_audittoken(SIGUSR1) returned ESRCH (3). No handled-signal event arrived within 150 ms.
- Genuine current token -> return 0; the child reported handling SIGUSR1 ('U', synthetic byte 85).
- Controlled exec completed and reported readiness ('E', synthetic byte 69). Calling with the pre-exec token -> ESRCH (3); no handled-signal event within 150 ms.
- Reacquisition while the child remained an owned unreaped direct child: both Mach calls returned 0; PID version changed (boolean only recorded). New token -> return 0; SIGUSR1 handled.
- Sentinel: separate direct child received no test signal; ping response 'P' (80) arrived and no signal event appeared during its 150 ms check before cleanup.
All proc_signal_with_audittoken return values above are direct API error codes; errno was not substituted. Signal 0 was never used. Genuine token contents, PIDs and private identity values were never written into logs or the reply. Only the invalid copy's PID-version bit was changed; no live token was manufactured from guessed IDs.

Cleanup and strict bounds
Total actual fixture births across all attempts: 3 (initial A 0, revised A 1, B 2), maximum simultaneous fixtures 2, all direct children, no grandchildren or detachment. Exec created no additional process. Each fixture set an independent eight-second alarm before blocking and after controlled exec; the existing alarm stayed armed through exec. The harness had a 15-second alarm and the independent driver a 10-second deadline; no deadline fired. Every executed case lasted under 20 seconds.
The cleanup owner was the non-reaping harness before release. Numeric cleanup signaling was permitted only while the exact direct child remained unreaped, but none was needed: 'q' commands produced clean exit, then waitpid reaped all three. Cleanup records' term_rc/kill_rc=-999 mean NOT ATTEMPTED, not OS errors. No groups, names, host PID scans or PID-wrap were used. Reaping every possible fixture, coupled with source containing no fixture fork, establishes absence without ancestry scans. Sentinel was unaffected until its own orderly cleanup.

Impact on contract
Keep macos-seatbelt / best_effort / original_process_group / survivorsPossible=true / completeDescendantTermination=false. A establishes actual NOTE_TRACK rejection, not complete fork tracking. Coalescing and missing child-identity guarantees remain source findings, not results of a stress test: see [matching XNU event implementation](https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-11417.140.69/bsd/kern/kern_event.c), filt_procattach/filt_procevent, and local SDK usr/include/sys/event.h:354–361. B demonstrates that token-bound signaling is attainable for a KNOWN instance using installed interfaces without root on this host; it also demonstrates why an old token cannot simply be reused after exec. Ownership here came from the deliberately preserved direct-child relationship, not ancestry discovery or audit-token possession alone.
This is not complete descendant tracking, hostile fork/exec testing, PID-reuse stress, parent-crash/startup recovery, signed/hardened-toolchain compatibility, packaged-app or production Seatbelt qualification. libproc.h's private-interface notice remains relevant. Stop is still not permission revocation. Linux namespace semantics remain unchanged. The newer macOS 27 ES option remains separate and untested.

Exact retained source and log hashes
/private/tmp/freedom-native-discriminants-r88pkwsx/probe.c
SHA-256 4b95984a3693fe1f6b57a462d49d468684def382092552ccb8ed55a784b7e583 (11663 bytes)
/private/tmp/freedom-native-discriminants-r88pkwsx/probe-v2.c
SHA-256 1c66a5010edbb6fd1f108caadf21bb7bc724b78e53aff6a57469e51f9109a48e (11874 bytes)
/private/tmp/freedom-native-discriminants-r88pkwsx/run-probe.py
SHA-256 8110a36a645ff240b23029a92c46fd0511c06e94c67ad06cdebb060a1d6fc5ea (1278 bytes)
/private/tmp/freedom-native-discriminants-r88pkwsx/run-probe-v2.py
SHA-256 e03fab7bed4c7fa45e270ffbf2b783b1ab289e5d1df05cbe61d5194c29d1655c (1306 bytes)
/private/tmp/freedom-native-discriminants-r88pkwsx/probe-A.jsonl
SHA-256 ff15df03017af7b385f03736449c963b7a64f77683929e415b285a7f11e63241 (428 bytes)
/private/tmp/freedom-native-discriminants-r88pkwsx/probe-A-v2.jsonl
SHA-256 f7765c165178a552ea31abc653520a9751d9f76c0a74d09dc6ad5c226bcc05a6 (1157 bytes)
/private/tmp/freedom-native-discriminants-r88pkwsx/probe-B-v2.jsonl
SHA-256 9c8a0cf32af2afd33461bda735c020066d283fbd1c131bf9d2109c2a62309fc5 (2263 bytes)

Full final native probe source follows, plus the driver and original failed-attempt native source. These three source blocks total 24843 UTF-8 bytes, below 25 KiB. The original driver is separately retained and hashed above; its final changes are executable/log version suffixes and explicit close_fds=True.

probe-v2.c
```c
#include <sys/types.h>
#include <sys/event.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <mach/mach.h>
#include <mach/mach_traps.h>
#include <libproc.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* Local probes only. No PID/group scans; every numeric signal precedes reaping. */
struct owned { pid_t pid; int command; int events; const char *label; };
static int failures;
static int births;
static int owned_fds[16];
static int owned_fd_count;
static void remember_fd(int fd) {
    if (owned_fd_count >= 16) abort();
    owned_fds[owned_fd_count++] = fd;
}
static const char *self_path;
static long long now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static void result(const char *name, bool pass, int actual, int expected) {
    printf("{\"type\":\"assertion\",\"name\":\"%s\",\"passed\":%s,\"actual\":%d,\"expected\":%d}\n",
           name, pass ? "true" : "false", actual, expected);
    fflush(stdout);
    if (!pass) failures++;
}
static void usr1(int signo) {
    (void)signo;
    int saved = errno;
    const char c = 'U';
    (void)write(STDOUT_FILENO, &c, 1);
    errno = saved;
}
static void fixture(bool after_exec) {
    /* alarm survives exec; reset immediately at each fixture entry, <=16s total. */
    signal(SIGALRM, SIG_DFL);
    alarm(8);
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = usr1;
    sa.sa_flags = SA_RESTART;
    sigemptyset(&sa.sa_mask);
    if (sigaction(SIGUSR1, &sa, NULL) != 0) _exit(91);
    char ready = after_exec ? 'E' : 'R';
    if (write(STDOUT_FILENO, &ready, 1) != 1) _exit(92);
    for (;;) {
        char c;
        ssize_t n = read(STDIN_FILENO, &c, 1);
        if (n < 0 && errno == EINTR) continue;
        if (n != 1 || c == 'q') _exit(0);
        if (c == 'p') {
            if (write(STDOUT_FILENO, "P", 1) != 1) _exit(93);
        } else if (c == 'e' && !after_exec) {
            /* Do not reset the existing timer before exec: no expiry gap. */
            execl(self_path, self_path, "fixture-after-exec", (char *)NULL);
            (void)write(STDOUT_FILENO, "X", 1);
            _exit(94);
        }
    }
}
static int event_byte(struct owned *p, int timeout_ms) {
    struct pollfd fd = { .fd = p->events, .events = POLLIN };
    long long end = now_ms() + timeout_ms;
    for (;;) {
        int left = (int)(end - now_ms());
        if (left < 0) left = 0;
        int r = poll(&fd, 1, left);
        if (r < 0 && errno == EINTR) continue;
        if (r == 0) return -2;
        if (r < 0) return -3;
        char c;
        ssize_t n = read(p->events, &c, 1);
        if (n == 1) return (unsigned char)c;
        if (n < 0 && errno == EINTR) continue;
        return -4;
    }
}
static bool command(struct owned *p, char c) {
    return p->pid > 0 && write(p->command, &c, 1) == 1;
}
static struct owned spawn_owned(const char *label) {
    struct owned p = { .pid = -1, .command = -1, .events = -1, .label = label };
    int c[2], e[2];
    if (pipe(c) != 0) return p;
    if (pipe(e) != 0) { close(c[0]); close(c[1]); return p; }
    if (births >= 3) { close(c[0]); close(c[1]); close(e[0]); close(e[1]); return p; }
    remember_fd(c[0]); remember_fd(c[1]);
    remember_fd(e[0]); remember_fd(e[1]);
    p.pid = fork();
    if (p.pid == 0) {
        signal(SIGALRM, SIG_DFL);
        alarm(8); /* Independent child expiry exists before any blocking operation. */
        if (dup2(c[0], STDIN_FILENO) < 0 || dup2(e[1], STDOUT_FILENO) < 0) _exit(90);
        /* Runner closes all inherited fds. Close only our known additions. */
        for (int i = 0; i < owned_fd_count; i++)
            if (owned_fds[i] >= 3) close(owned_fds[i]);
        fixture(false);
        _exit(95);
    }
    close(c[0]); close(e[1]);
    if (p.pid < 0) { close(c[1]); close(e[0]); return p; }
    births++;
    p.command = c[1]; p.events = e[0];
    return p;
}
static bool reap_until(struct owned *p, int ms, int *status) {
    long long end = now_ms() + ms;
    while (now_ms() < end) {
        pid_t r = waitpid(p->pid, status, WNOHANG);
        if (r == p->pid) { p->pid = -1; return true; }
        if (r < 0 && errno != EINTR) {
            /* No established relationship: forbid all further numeric signaling. */
            p->pid = -1;
            return false;
        }
        struct timespec nap = { .tv_sec = 0, .tv_nsec = 10000000 };
        nanosleep(&nap, NULL);
    }
    return false;
}
static void cleanup(struct owned *p) {
    if (p->pid <= 0) return;
    int status = 0, term_rc = -999, kill_rc = -999;
    (void)command(p, 'q');
    bool reaped = reap_until(p, 300, &status);
    if (!reaped && p->pid > 0) {
        term_rc = kill(p->pid, SIGTERM); /* Owned, direct, not reaped. */
        reaped = reap_until(p, 300, &status);
    }
    if (!reaped && p->pid > 0) {
        kill_rc = kill(p->pid, SIGKILL); /* Still owned, direct, not reaped. */
        reaped = reap_until(p, 1000, &status);
    }
    printf("{\"type\":\"cleanup\",\"fixture\":\"%s\",\"reaped\":%s,\"term_rc\":%d,\"kill_rc\":%d,\"exit_code\":%d,\"exit_signal\":%d}\n",
           p->label, reaped ? "true" : "false", term_rc, kill_rc,
           reaped && WIFEXITED(status) ? WEXITSTATUS(status) : -1,
           reaped && WIFSIGNALED(status) ? WTERMSIG(status) : 0);
    if (!reaped) failures++;
    close(p->command); close(p->events);
    p->command = p->events = -1;
}
static int register_note(int kq, pid_t pid, unsigned int flags, int *event_errno) {
    struct kevent change, receipt;
    EV_SET(&change, (uintptr_t)pid, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_RECEIPT, flags, 0, NULL);
    struct timespec zero = { 0, 0 };
    errno = 0;
    int n = kevent(kq, &change, 1, &receipt, 1, &zero);
    *event_errno = n == 1 && (receipt.flags & EV_ERROR) ? (int)receipt.data : -999;
    return n;
}
static bool receive_note(int kq, pid_t pid, unsigned int flag) {
    long long end = now_ms() + 750;
    while (now_ms() < end) {
        struct kevent event;
        struct timespec wait = { .tv_sec = 0, .tv_nsec = 50000000 };
        int n = kevent(kq, NULL, 0, &event, 1, &wait);
        if (n == 1 && event.filter == EVFILT_PROC && event.ident == (uintptr_t)pid && (event.fflags & flag)) return true;
        if (n < 0 && errno != EINTR) return false;
    }
    return false;
}
static void probe_a(void) {
    int kq = kqueue(), code;
    result("A_kqueue_created", kq >= 0, kq >= 0, 1);
    if (kq < 0) return;
    remember_fd(kq);
    int n = register_note(kq, getpid(), NOTE_FORK, &code);
    result("A_self_fork_registration", n == 1 && code == 0, code, 0);
    struct owned child = spawn_owned("A_blocked_child");
    result("A_child_created", child.pid > 0, child.pid > 0, 1);
    if (child.pid <= 0) { close(kq); return; }
    result("A_child_ready", event_byte(&child, 1000) == 'R', 0, 0);
    result("A_NOTE_FORK_observed", receive_note(kq, getpid(), NOTE_FORK), 0, 0);
    n = register_note(kq, child.pid, NOTE_TRACK, &code);
    printf("{\"type\":\"note_track_receipt\",\"kevent_count\":%d,\"event_error\":%d,\"expected_ENOTSUP\":%d}\n", n, code, ENOTSUP);
    result("A_NOTE_TRACK_ENOTSUP", n == 1 && code == ENOTSUP, code, ENOTSUP);
    n = register_note(kq, child.pid, NOTE_EXIT, &code);
    result("A_exit_registration", n == 1 && code == 0, code, 0);
    result("A_release_child", command(&child, 'q'), 0, 0);
    result("A_NOTE_EXIT_observed", receive_note(kq, child.pid, NOTE_EXIT), 0, 0);
    cleanup(&child);
    close(kq);
}
static bool audit_token(struct owned *p, audit_token_t *token, const char *phase) {
    mach_port_name_t name = MACH_PORT_NULL;
    kern_return_t kr = task_name_for_pid(mach_task_self(), p->pid, &name);
    printf("{\"type\":\"audit_acquisition\",\"phase\":\"%s\",\"task_name_for_pid_kr\":%d}\n", phase, kr);
    if (kr != KERN_SUCCESS) return false;
    mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
    kr = task_info(name, TASK_AUDIT_TOKEN, (task_info_t)token, &count);
    printf("{\"type\":\"audit_acquisition\",\"phase\":\"%s\",\"task_info_kr\":%d,\"count_valid\":%s}\n", phase, kr, count == TASK_AUDIT_TOKEN_COUNT ? "true" : "false");
    mach_port_deallocate(mach_task_self(), name);
    return kr == KERN_SUCCESS && count == TASK_AUDIT_TOKEN_COUNT;
}
static void probe_b(void) {
    struct owned child = spawn_owned("B_signal_child");
    struct owned sentinel = spawn_owned("B_owned_sentinel");
    result("B_two_direct_children_created", child.pid > 0 && sentinel.pid > 0, births, 2);
    if (child.pid <= 0 || sentinel.pid <= 0) goto done;
    result("B_child_ready", event_byte(&child, 1000) == 'R', 0, 0);
    result("B_sentinel_ready", event_byte(&sentinel, 1000) == 'R', 0, 0);
    audit_token_t original, changed, current;
    if (!audit_token(&child, &original, "before_exec")) {
        printf("{\"type\":\"limitation\",\"reason\":\"genuine_audit_token_unavailable_no_privilege_fallback\"}\n");
        goto sentinel_check;
    }
    changed = original;
    changed.val[7] ^= 1u; /* Only a deliberately invalid copy is manufactured. */
    int rc = proc_signal_with_audittoken(&changed, SIGUSR1);
    result("B_changed_version_ESRCH", rc == ESRCH, rc, ESRCH);
    int byte = event_byte(&child, 150);
    result("B_changed_version_no_signal", byte == -2, byte, -2);
    rc = proc_signal_with_audittoken(&original, SIGUSR1);
    result("B_current_token_signal_return", rc == 0, rc, 0);
    byte = event_byte(&child, 750);
    result("B_current_token_signal_handled", byte == 'U', byte, 'U');
    if (!command(&child, 'e')) { result("B_exec_command", false, -1, 0); goto sentinel_check; }
    byte = event_byte(&child, 1000);
    result("B_exec_ready", byte == 'E', byte, 'E');
    if (byte != 'E') goto sentinel_check;
    rc = proc_signal_with_audittoken(&original, SIGUSR1);
    result("B_old_token_after_exec_ESRCH", rc == ESRCH, rc, ESRCH);
    byte = event_byte(&child, 150);
    result("B_old_token_after_exec_no_signal", byte == -2, byte, -2);
    if (!audit_token(&child, &current, "after_exec")) {
        printf("{\"type\":\"limitation\",\"reason\":\"post_exec_audit_token_unavailable_no_privilege_fallback\"}\n");
        goto sentinel_check;
    }
    result("B_exec_changed_version", original.val[7] != current.val[7], original.val[7] != current.val[7], 1);
    rc = proc_signal_with_audittoken(&current, SIGUSR1);
    result("B_post_exec_current_signal_return", rc == 0, rc, 0);
    byte = event_byte(&child, 750);
    result("B_post_exec_current_signal_handled", byte == 'U', byte, 'U');
sentinel_check:
    result("B_sentinel_ping_sent", command(&sentinel, 'p'), 0, 0);
    int s = event_byte(&sentinel, 750);
    result("B_sentinel_unaffected_before_cleanup", s == 'P', s, 'P');
    s = event_byte(&sentinel, 150);
    result("B_sentinel_no_signal_event", s == -2, s, -2);
done:
    cleanup(&child);
    cleanup(&sentinel);
}
int main(int argc, char **argv) {
    self_path = argv[0];
    if (argc == 2 && strcmp(argv[1], "fixture-after-exec") == 0) fixture(true);
    if (argc != 2 || (strcmp(argv[1], "A") && strcmp(argv[1], "B"))) return 2;
    if (getuid() == 0 || geteuid() == 0) return 3;
    signal(SIGALRM, SIG_DFL);
    signal(SIGPIPE, SIG_IGN);
    signal(SIGCHLD, SIG_DFL);
    alarm(15); /* Harness expiry; fixtures have their own independent alarm. */
    long long start = now_ms();
    if (strcmp(argv[1], "A") == 0) probe_a(); else probe_b();
    long long elapsed = now_ms() - start;
    result("case_under_20_seconds", elapsed < 20000, (int)elapsed, 20000);
    printf("{\"type\":\"summary\",\"probe\":\"%s\",\"failures\":%d,\"births\":%d,\"duration_ms\":%lld}\n", argv[1], failures, births, elapsed);
    return failures ? 1 : 0;
}
```

run-probe-v2.py
```python
import hashlib, json, os, subprocess, sys, time
from pathlib import Path
root = Path(__file__).resolve().parent
case = sys.argv[1]
if case not in ('A', 'B'):
    raise SystemExit(2)
start = time.monotonic()
env = {'PATH': '/usr/bin:/bin', 'HOME': str(root), 'TMPDIR': str(root)}
child = subprocess.Popen([str(root / 'probe-v2'), case], cwd=root, env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, close_fds=True)
timed_out = False
try:
    output, _ = child.communicate(timeout=10)
except subprocess.TimeoutExpired:
    timed_out = True
    child.kill()  # Our own unreaped direct harness child; never a group.
    output, _ = child.communicate(timeout=2)
    time.sleep(8.25)  # Fixtures independently expire, even after a failed harness.
log = root / ('probe-' + case + '-v2.jsonl')
log.write_text(output, encoding='utf-8')
record = {'probe': case, 'command': [str(root / 'probe-v2'), case], 'uid': os.getuid(),
          'exit_code': child.returncode, 'harness_timeout': timed_out,
          'duration_seconds': time.monotonic() - start,
          'log': str(log), 'log_sha256': hashlib.sha256(log.read_bytes()).hexdigest()}
(root / ('run-' + case + '-v2.json')).write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps(record))
print(output, end='')
```

probe.c
```c
#include <sys/types.h>
#include <sys/event.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <mach/mach.h>
#include <mach/mach_traps.h>
#include <libproc.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* Local probes only. No PID/group scans; every numeric signal precedes reaping. */
struct owned { pid_t pid; int command; int events; const char *label; };
static int failures;
static int births;
static const char *self_path;
static long long now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static void result(const char *name, bool pass, int actual, int expected) {
    printf("{\"type\":\"assertion\",\"name\":\"%s\",\"passed\":%s,\"actual\":%d,\"expected\":%d}\n",
           name, pass ? "true" : "false", actual, expected);
    fflush(stdout);
    if (!pass) failures++;
}
static void usr1(int signo) {
    (void)signo;
    int saved = errno;
    const char c = 'U';
    (void)write(STDOUT_FILENO, &c, 1);
    errno = saved;
}
static void fixture(bool after_exec) {
    /* alarm survives exec; reset immediately at each fixture entry, <=16s total. */
    signal(SIGALRM, SIG_DFL);
    alarm(8);
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = usr1;
    sa.sa_flags = SA_RESTART;
    sigemptyset(&sa.sa_mask);
    if (sigaction(SIGUSR1, &sa, NULL) != 0) _exit(91);
    char ready = after_exec ? 'E' : 'R';
    if (write(STDOUT_FILENO, &ready, 1) != 1) _exit(92);
    for (;;) {
        char c;
        ssize_t n = read(STDIN_FILENO, &c, 1);
        if (n < 0 && errno == EINTR) continue;
        if (n != 1 || c == 'q') _exit(0);
        if (c == 'p') {
            if (write(STDOUT_FILENO, "P", 1) != 1) _exit(93);
        } else if (c == 'e' && !after_exec) {
            /* Do not reset the existing timer before exec: no expiry gap. */
            execl(self_path, self_path, "fixture-after-exec", (char *)NULL);
            (void)write(STDOUT_FILENO, "X", 1);
            _exit(94);
        }
    }
}
static int event_byte(struct owned *p, int timeout_ms) {
    struct pollfd fd = { .fd = p->events, .events = POLLIN };
    long long end = now_ms() + timeout_ms;
    for (;;) {
        int left = (int)(end - now_ms());
        if (left < 0) left = 0;
        int r = poll(&fd, 1, left);
        if (r < 0 && errno == EINTR) continue;
        if (r == 0) return -2;
        if (r < 0) return -3;
        char c;
        ssize_t n = read(p->events, &c, 1);
        if (n == 1) return (unsigned char)c;
        if (n < 0 && errno == EINTR) continue;
        return -4;
    }
}
static bool command(struct owned *p, char c) {
    return p->pid > 0 && write(p->command, &c, 1) == 1;
}
static struct owned spawn_owned(const char *label) {
    struct owned p = { .pid = -1, .command = -1, .events = -1, .label = label };
    int c[2], e[2];
    if (pipe(c) != 0) return p;
    if (pipe(e) != 0) { close(c[0]); close(c[1]); return p; }
    if (births >= 3) { close(c[0]); close(c[1]); close(e[0]); close(e[1]); return p; }
    struct rlimit limit;
    if (getrlimit(RLIMIT_NOFILE, &limit) != 0 || limit.rlim_cur > 65536) {
        close(c[0]); close(c[1]); close(e[0]); close(e[1]); return p;
    }
    p.pid = fork();
    if (p.pid == 0) {
        signal(SIGALRM, SIG_DFL);
        alarm(8); /* Independent child expiry exists before any blocking operation. */
        if (dup2(c[0], STDIN_FILENO) < 0 || dup2(e[1], STDOUT_FILENO) < 0) _exit(90);
        for (int fd = 3; fd < (int)limit.rlim_cur; fd++) close(fd);
        fixture(false);
        _exit(95);
    }
    close(c[0]); close(e[1]);
    if (p.pid < 0) { close(c[1]); close(e[0]); return p; }
    births++;
    p.command = c[1]; p.events = e[0];
    return p;
}
static bool reap_until(struct owned *p, int ms, int *status) {
    long long end = now_ms() + ms;
    while (now_ms() < end) {
        pid_t r = waitpid(p->pid, status, WNOHANG);
        if (r == p->pid) { p->pid = -1; return true; }
        if (r < 0 && errno != EINTR) {
            /* No established relationship: forbid all further numeric signaling. */
            p->pid = -1;
            return false;
        }
        struct timespec nap = { .tv_sec = 0, .tv_nsec = 10000000 };
        nanosleep(&nap, NULL);
    }
    return false;
}
static void cleanup(struct owned *p) {
    if (p->pid <= 0) return;
    int status = 0, term_rc = -999, kill_rc = -999;
    (void)command(p, 'q');
    bool reaped = reap_until(p, 300, &status);
    if (!reaped && p->pid > 0) {
        term_rc = kill(p->pid, SIGTERM); /* Owned, direct, not reaped. */
        reaped = reap_until(p, 300, &status);
    }
    if (!reaped && p->pid > 0) {
        kill_rc = kill(p->pid, SIGKILL); /* Still owned, direct, not reaped. */
        reaped = reap_until(p, 1000, &status);
    }
    printf("{\"type\":\"cleanup\",\"fixture\":\"%s\",\"reaped\":%s,\"term_rc\":%d,\"kill_rc\":%d,\"exit_code\":%d,\"exit_signal\":%d}\n",
           p->label, reaped ? "true" : "false", term_rc, kill_rc,
           reaped && WIFEXITED(status) ? WEXITSTATUS(status) : -1,
           reaped && WIFSIGNALED(status) ? WTERMSIG(status) : 0);
    if (!reaped) failures++;
    close(p->command); close(p->events);
    p->command = p->events = -1;
}
static int register_note(int kq, pid_t pid, unsigned int flags, int *event_errno) {
    struct kevent change, receipt;
    EV_SET(&change, (uintptr_t)pid, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_RECEIPT, flags, 0, NULL);
    struct timespec zero = { 0, 0 };
    errno = 0;
    int n = kevent(kq, &change, 1, &receipt, 1, &zero);
    *event_errno = n == 1 && (receipt.flags & EV_ERROR) ? (int)receipt.data : -999;
    return n;
}
static bool receive_note(int kq, pid_t pid, unsigned int flag) {
    long long end = now_ms() + 750;
    while (now_ms() < end) {
        struct kevent event;
        struct timespec wait = { .tv_sec = 0, .tv_nsec = 50000000 };
        int n = kevent(kq, NULL, 0, &event, 1, &wait);
        if (n == 1 && event.filter == EVFILT_PROC && event.ident == (uintptr_t)pid && (event.fflags & flag)) return true;
        if (n < 0 && errno != EINTR) return false;
    }
    return false;
}
static void probe_a(void) {
    int kq = kqueue(), code;
    result("A_kqueue_created", kq >= 0, kq >= 0, 1);
    if (kq < 0) return;
    int n = register_note(kq, getpid(), NOTE_FORK, &code);
    result("A_self_fork_registration", n == 1 && code == 0, code, 0);
    struct owned child = spawn_owned("A_blocked_child");
    result("A_child_created", child.pid > 0, child.pid > 0, 1);
    if (child.pid <= 0) { close(kq); return; }
    result("A_child_ready", event_byte(&child, 1000) == 'R', 0, 0);
    result("A_NOTE_FORK_observed", receive_note(kq, getpid(), NOTE_FORK), 0, 0);
    n = register_note(kq, child.pid, NOTE_TRACK, &code);
    printf("{\"type\":\"note_track_receipt\",\"kevent_count\":%d,\"event_error\":%d,\"expected_ENOTSUP\":%d}\n", n, code, ENOTSUP);
    result("A_NOTE_TRACK_ENOTSUP", n == 1 && code == ENOTSUP, code, ENOTSUP);
    n = register_note(kq, child.pid, NOTE_EXIT, &code);
    result("A_exit_registration", n == 1 && code == 0, code, 0);
    result("A_release_child", command(&child, 'q'), 0, 0);
    result("A_NOTE_EXIT_observed", receive_note(kq, child.pid, NOTE_EXIT), 0, 0);
    cleanup(&child);
    close(kq);
}
static bool audit_token(struct owned *p, audit_token_t *token, const char *phase) {
    mach_port_name_t name = MACH_PORT_NULL;
    kern_return_t kr = task_name_for_pid(mach_task_self(), p->pid, &name);
    printf("{\"type\":\"audit_acquisition\",\"phase\":\"%s\",\"task_name_for_pid_kr\":%d}\n", phase, kr);
    if (kr != KERN_SUCCESS) return false;
    mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
    kr = task_info(name, TASK_AUDIT_TOKEN, (task_info_t)token, &count);
    printf("{\"type\":\"audit_acquisition\",\"phase\":\"%s\",\"task_info_kr\":%d,\"count_valid\":%s}\n", phase, kr, count == TASK_AUDIT_TOKEN_COUNT ? "true" : "false");
    mach_port_deallocate(mach_task_self(), name);
    return kr == KERN_SUCCESS && count == TASK_AUDIT_TOKEN_COUNT;
}
static void probe_b(void) {
    struct owned child = spawn_owned("B_signal_child");
    struct owned sentinel = spawn_owned("B_owned_sentinel");
    result("B_two_direct_children_created", child.pid > 0 && sentinel.pid > 0, births, 2);
    if (child.pid <= 0 || sentinel.pid <= 0) goto done;
    result("B_child_ready", event_byte(&child, 1000) == 'R', 0, 0);
    result("B_sentinel_ready", event_byte(&sentinel, 1000) == 'R', 0, 0);
    audit_token_t original, changed, current;
    if (!audit_token(&child, &original, "before_exec")) {
        printf("{\"type\":\"limitation\",\"reason\":\"genuine_audit_token_unavailable_no_privilege_fallback\"}\n");
        goto sentinel_check;
    }
    changed = original;
    changed.val[7] ^= 1u; /* Only a deliberately invalid copy is manufactured. */
    int rc = proc_signal_with_audittoken(&changed, SIGUSR1);
    result("B_changed_version_ESRCH", rc == ESRCH, rc, ESRCH);
    int byte = event_byte(&child, 150);
    result("B_changed_version_no_signal", byte == -2, byte, -2);
    rc = proc_signal_with_audittoken(&original, SIGUSR1);
    result("B_current_token_signal_return", rc == 0, rc, 0);
    byte = event_byte(&child, 750);
    result("B_current_token_signal_handled", byte == 'U', byte, 'U');
    if (!command(&child, 'e')) { result("B_exec_command", false, -1, 0); goto sentinel_check; }
    byte = event_byte(&child, 1000);
    result("B_exec_ready", byte == 'E', byte, 'E');
    if (byte != 'E') goto sentinel_check;
    rc = proc_signal_with_audittoken(&original, SIGUSR1);
    result("B_old_token_after_exec_ESRCH", rc == ESRCH, rc, ESRCH);
    byte = event_byte(&child, 150);
    result("B_old_token_after_exec_no_signal", byte == -2, byte, -2);
    if (!audit_token(&child, &current, "after_exec")) {
        printf("{\"type\":\"limitation\",\"reason\":\"post_exec_audit_token_unavailable_no_privilege_fallback\"}\n");
        goto sentinel_check;
    }
    result("B_exec_changed_version", original.val[7] != current.val[7], original.val[7] != current.val[7], 1);
    rc = proc_signal_with_audittoken(&current, SIGUSR1);
    result("B_post_exec_current_signal_return", rc == 0, rc, 0);
    byte = event_byte(&child, 750);
    result("B_post_exec_current_signal_handled", byte == 'U', byte, 'U');
sentinel_check:
    result("B_sentinel_ping_sent", command(&sentinel, 'p'), 0, 0);
    int s = event_byte(&sentinel, 750);
    result("B_sentinel_unaffected_before_cleanup", s == 'P', s, 'P');
    s = event_byte(&sentinel, 150);
    result("B_sentinel_no_signal_event", s == -2, s, -2);
done:
    cleanup(&child);
    cleanup(&sentinel);
}
int main(int argc, char **argv) {
    self_path = argv[0];
    if (argc == 2 && strcmp(argv[1], "fixture-after-exec") == 0) fixture(true);
    if (argc != 2 || (strcmp(argv[1], "A") && strcmp(argv[1], "B"))) return 2;
    if (getuid() == 0 || geteuid() == 0) return 3;
    signal(SIGALRM, SIG_DFL);
    signal(SIGPIPE, SIG_IGN);
    signal(SIGCHLD, SIG_DFL);
    alarm(15); /* Harness expiry; fixtures have their own independent alarm. */
    long long start = now_ms();
    if (strcmp(argv[1], "A") == 0) probe_a(); else probe_b();
    long long elapsed = now_ms() - start;
    result("case_under_20_seconds", elapsed < 20000, (int)elapsed, 20000);
    printf("{\"type\":\"summary\",\"probe\":\"%s\",\"failures\":%d,\"births\":%d,\"duration_ms\":%lld}\n", argv[1], failures, births, elapsed);
    return failures ? 1 : 0;
}
```
