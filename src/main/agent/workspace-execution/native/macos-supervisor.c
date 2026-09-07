/* Freedom macOS original-process-group supervisor. See README.md for contract. */
#define _DARWIN_C_SOURCE 1
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <mach/mach_time.h>
#include <mach-o/dyld.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef FREEDOM_SUPERVISOR_BUILD_ID
#error "Define FREEDOM_SUPERVISOR_BUILD_ID as the quoted SHA256 of this source"
#endif

#define CONTROL_FD 3
#define STATUS_FD 4
#define GATE_READ_FD 5
#define GATE_STATUS_FD 6
#define MAX_RECORD 1024
#define MAX_STATUS 2048
#define IO_BATCH 4
#define TICK_MS 10
#define STARTUP_MS 5000
#define TERM_MS 1000
#define SETTLE_MS 250
#define FLUSH_MS 250
#define MAX_WALL_MS 1800000
#define GATE_MAGIC UINT32_C(0x46475331)
#define GATE_READY 1
#define GATE_ERROR 2

extern char **environ;

/* The fixed private framing never reaches B, stdout, or a successful payload exec. */
struct gate_record {
    uint32_t magic, kind;
    int32_t pid, pgid, sid, error;
};
_Static_assert(sizeof(struct gate_record) == 24, "private gate framing size");

enum phase { SETUP, ACTIVE, TERMINATING, SETTLING, RETIRED };
enum reason { COMPLETED, CANCELLED, TIMED_OUT, SETUP_FAILED, SUPERVISOR_FAILED };

/* Return conventions: observe/verify/send_signal return 0 or an errno value;
 * reap returns 1 (reaped), 0 (not waitable), or negative errno. I/O is POSIX.
 * Production uses only SYSTEM_OPS. No environment/CLI selects operations. */
struct operations {
    uint64_t (*now)(void *);
    int (*observe)(void *, pid_t, siginfo_t *);
    int (*reap)(void *, pid_t, int *);
    int (*send_signal)(void *, pid_t, int);
    int (*verify_group)(void *, pid_t);
    ssize_t (*read_bytes)(void *, int, void *, size_t);
    ssize_t (*write_bytes)(void *, int, const void *, size_t);
    void (*close_fd)(void *, int);
    void (*pause_tick)(void *);
};

struct supervisor {
    const struct operations *ops;
    void *context;
    enum phase phase;
    enum reason reason;
    pid_t root;
    int gate_write, gate_read;
    uint64_t wall_end, startup_end, phase_end;
    bool spawned, owned, signal_enabled, observed, reaped, group_verified;
    bool release_issued, ready_queued, ready_sent, gate_ready, gate_eof;
    bool go_seen, terminal, uncertain, final_kill, status_broken, gate_error_seen;
    unsigned gate_records;
    int setup_error, exit_code, exit_signal;
    int term_error, kill_error, observe_interrupts;
    unsigned char gate_buffer[sizeof(struct gate_record)];
    size_t gate_used;
    char status[MAX_STATUS];
    size_t status_used, status_sent;
    unsigned status_records;
};

static mach_timebase_info_data_t timebase;

static uint64_t system_now(void *unused) {
    (void)unused;
    __uint128_t ns = (__uint128_t)mach_continuous_time() * timebase.numer / timebase.denom;
    return (uint64_t)(ns / UINT64_C(1000000));
}
static int system_observe(void *unused, pid_t pid, siginfo_t *info) {
    (void)unused;
    return waitid(P_PID, (id_t)pid, info, WEXITED | WNOHANG | WNOWAIT) == 0 ? 0 : errno;
}
static int system_reap(void *unused, pid_t pid, int *status) {
    (void)unused;
    pid_t r = waitpid(pid, status, WNOHANG);
    return r == pid ? 1 : r == 0 ? 0 : -errno;
}
static int system_signal(void *unused, pid_t pid, int signo) {
    (void)unused;
    return kill(pid, signo) == 0 ? 0 : errno;
}
static int system_verify(void *unused, pid_t pid) {
    (void)unused;
    pid_t pgid = getpgid(pid);
    if (pgid < 0) return errno;
    pid_t sid = getsid(pid);
    if (sid < 0) return errno;
    return pgid == pid && sid == pid && getpgrp() != pid ? 0 : EPROTO;
}
static ssize_t system_read(void *unused, int fd, void *buf, size_t n) {
    (void)unused;
    return read(fd, buf, n);
}
static ssize_t system_write(void *unused, int fd, const void *buf, size_t n) {
    (void)unused;
    return write(fd, buf, n);
}
static void system_close(void *unused, int fd) {
    (void)unused;
    /* Do not retry close after an error: a retry must not target a reused FD. */
    (void)close(fd);
}
static void system_pause(void *unused) {
    (void)unused;
    (void)poll(NULL, 0, TICK_MS);
}
static const struct operations SYSTEM_OPS = {
    system_now, system_observe, system_reap, system_signal, system_verify,
    system_read, system_write, system_close, system_pause
};

static void close_owned_fd(struct supervisor *s, int *fd) {
    if (*fd >= 0) s->ops->close_fd(s->context, *fd);
    *fd = -1;
}
static void initialize(struct supervisor *s, const struct operations *ops,
                       void *context, uint64_t start, uint64_t timeout) {
    memset(s, 0, sizeof(*s));
    s->ops = ops; s->context = context; s->phase = SETUP;
    s->reason = SETUP_FAILED; s->root = -1;
    s->gate_write = -1; s->gate_read = -1;
    s->exit_code = -1; s->exit_signal = -1;
    s->wall_end = start + timeout;
    s->startup_end = start + (timeout < STARTUP_MS ? timeout : STARTUP_MS);
}
static void record_error(struct supervisor *s, int error) {
    if (error > 0 && !s->setup_error) s->setup_error = error;
}
static void stop_request(struct supervisor *s, enum reason why, int error) {
    if (s->phase == RETIRED) return;
    /* Protocol/ownership failures remain visible even during cancellation. */
    if (!s->terminal || why == SUPERVISOR_FAILED) s->reason = why;
    s->terminal = true;
    record_error(s, error);
}
static void lose_ownership(struct supervisor *s, int error) {
    s->owned = false;
    s->signal_enabled = false;
    s->uncertain = true;
    stop_request(s, SUPERVISOR_FAILED, error);
}
static void signal_root(struct supervisor *s, int signo) {
    if (!s->spawned || !s->owned || !s->signal_enabled || s->reaped || s->root <= 0)
        return;
    if (signo == SIGKILL) s->final_kill = true;
    int error = s->ops->send_signal(s->context,
        s->group_verified ? -s->root : s->root, signo);
    if (error) {
        if (signo == SIGTERM) s->term_error = error;
        else s->kill_error = error;
        s->uncertain = true;
    }
}
static bool observe_root(struct supervisor *s) {
    if (!s->owned || s->observed) return s->observed;
    siginfo_t info;
    memset(&info, 0, sizeof(info));
    int error = s->ops->observe(s->context, s->root, &info);
    if (error) {
        if (error == ECHILD) lose_ownership(s, error);
        else if (error != EINTR || ++s->observe_interrupts >= IO_BATCH)
            stop_request(s, SUPERVISOR_FAILED, error);
        return false;
    }
    s->observe_interrupts = 0;
    if (info.si_pid == 0) return true; /* waitid confirms direct-child ownership */
    if (info.si_pid != s->root ||
        (info.si_code != CLD_EXITED && info.si_code != CLD_KILLED && info.si_code != CLD_DUMPED) ||
        (info.si_code == CLD_EXITED && (info.si_status < 0 || info.si_status > 255)) ||
        (info.si_code != CLD_EXITED && (info.si_status < 1 || info.si_status > 64))) {
        stop_request(s, SUPERVISOR_FAILED, EPROTO);
        return false;
    }
    s->observed = true;
    if (info.si_code == CLD_EXITED) s->exit_code = info.si_status;
    else s->exit_signal = info.si_status;
    return true;
}

static bool queue_record(struct supervisor *s, const char *record, size_t size) {
    if (size == 0 || size > MAX_RECORD || s->status_records >= 2 ||
        size > MAX_STATUS - s->status_used || record[size - 1] != '\n') return false;
    memcpy(s->status + s->status_used, record, size);
    s->status_used += size;
    s->status_records++;
    return true;
}
static void flush_status(struct supervisor *s) {
    if (s->status_broken) return;
    for (int i = 0; i < IO_BATCH && s->status_sent < s->status_used; i++) {
        ssize_t n = s->ops->write_bytes(s->context, STATUS_FD,
            s->status + s->status_sent, s->status_used - s->status_sent);
        if (n > 0) s->status_sent += (size_t)n;
        else if (n < 0 && errno == EINTR) continue;
        else if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
        else {
            int error = n == 0 ? EIO : errno;
            s->status_broken = true;
            stop_request(s, SUPERVISOR_FAILED, error);
            break;
        }
    }
    if (s->ready_queued && s->status_records == 1 && s->status_sent == s->status_used)
        s->ready_sent = true;
}

/* Collect an entire bounded currently-readable batch BEFORE committing G. EOF or
 * A in the same batch wins. Exhausting the budget without EAGAIN fails closed. */
static bool read_control(struct supervisor *s) {
    bool go = false, abort_seen = false, eof = false, exhausted = true;
    int error = 0;
    size_t bytes = 0;
    for (int i = 0; i < IO_BATCH; i++) {
        unsigned char buffer[8];
        ssize_t n = s->ops->read_bytes(s->context, CONTROL_FD, buffer, sizeof(buffer));
        if (n > 0) {
            bytes += (size_t)n;
            for (ssize_t j = 0; j < n; j++) {
                if (buffer[j] == 'A' && !abort_seen) abort_seen = true;
                else if (buffer[j] == 'G' && !go && !s->go_seen) go = true;
                else error = EPROTO;
            }
            if (bytes > 2) error = EPROTO;
        } else if (n == 0) { eof = true; exhausted = false; break; }
        else if (errno == EINTR) continue;
        else if (errno == EAGAIN || errno == EWOULDBLOCK) { exhausted = false; break; }
        else { error = errno; exhausted = false; break; }
    }
    if (exhausted && !error) error = EOVERFLOW;
    if (error) stop_request(s, SUPERVISOR_FAILED, error);
    else if (abort_seen || eof) stop_request(s, CANCELLED, 0);
    else if (go) {
        if (!s->ready_sent || s->release_issued) stop_request(s, SUPERVISOR_FAILED, EPROTO);
        else s->go_seen = true;
    }
    return go && !s->terminal;
}
static void consume_gate_record(struct supervisor *s, const struct gate_record *r) {
    if (++s->gate_records > 2 || r->magic != GATE_MAGIC || r->pid != s->root) {
        stop_request(s, SUPERVISOR_FAILED, EPROTO); return;
    }
    if (r->kind == GATE_ERROR && r->error > 0 && !s->gate_error_seen) {
        s->gate_error_seen = true;
        record_error(s, r->error);
        if (!s->release_issued) stop_request(s, SETUP_FAILED, r->error);
        /* After release: an execvp failure is natural exit127 with setupError.
         * Wait status, never this record, determines actual root termination. */
        return;
    }
    if (r->kind != GATE_READY || r->error || s->gate_ready || s->release_issued ||
        r->pgid != s->root || r->sid != s->root) {
        stop_request(s, SUPERVISOR_FAILED, EPROTO); return;
    }
    if (!observe_root(s)) {
        if (!s->terminal) stop_request(s, SUPERVISOR_FAILED, EINTR);
        return;
    }
    if (s->observed || s->terminal) return;
    int error = s->ops->verify_group(s->context, s->root);
    if (error) { stop_request(s, SETUP_FAILED, error); return; }
    s->group_verified = true;
    s->gate_ready = true;
    static const char ready[] = "{\"v\":1,\"type\":\"ready\"}\n";
    if (!queue_record(s, ready, sizeof(ready) - 1))
        stop_request(s, SUPERVISOR_FAILED, EOVERFLOW);
    else s->ready_queued = true;
}
static void read_gate(struct supervisor *s) {
    if (s->gate_read < 0 || s->terminal) return;
    for (int i = 0; i < IO_BATCH; i++) {
        ssize_t n = s->ops->read_bytes(s->context, s->gate_read,
            s->gate_buffer + s->gate_used, sizeof(s->gate_buffer) - s->gate_used);
        if (n > 0) {
            s->gate_used += (size_t)n;
            if (s->gate_used == sizeof(s->gate_buffer)) {
                struct gate_record r;
                memcpy(&r, s->gate_buffer, sizeof(r)); s->gate_used = 0;
                consume_gate_record(s, &r);
                if (s->terminal) return;
            }
        } else if (n == 0) {
            s->gate_eof = true;
            close_owned_fd(s, &s->gate_read);
            if (s->gate_used) stop_request(s, SUPERVISOR_FAILED, EPROTO);
            else if (!s->release_issued) stop_request(s, SETUP_FAILED, EPIPE);
            return;
        } else if (errno == EINTR) continue;
        else if (errno == EAGAIN || errno == EWOULDBLOCK) return;
        else { stop_request(s, SUPERVISOR_FAILED, errno); return; }
    }
    /* Bounded per-tick work; total startup/wall deadlines still apply. */
}
static void retire_and_reap(struct supervisor *s) {
    /* This irreversible latch precedes every waitpid. No caller may restore it. */
    s->signal_enabled = false;
    s->phase = RETIRED;
    if (s->observed && s->owned) {
        for (int i = 0; i < IO_BATCH; i++) {
            int status = 0;
            int r = s->ops->reap(s->context, s->root, &status);
            if (r == 1) {
                s->reaped = true; s->owned = false; s->root = -1;
                /* The actual reap must agree with the retained observation. */
                if ((s->exit_code >= 0 && (!WIFEXITED(status) || WEXITSTATUS(status) != s->exit_code)) ||
                    (s->exit_signal >= 0 && (!WIFSIGNALED(status) || WTERMSIG(status) != s->exit_signal))) {
                    s->uncertain = true; s->reason = SUPERVISOR_FAILED;
                    record_error(s, EPROTO);
                }
                break;
            }
            if (r == -EINTR) continue;
            s->uncertain = true;
            s->reason = SUPERVISOR_FAILED;
            record_error(s, r < 0 ? -r : EAGAIN);
            if (r == -ECHILD) { s->owned = false; s->reason = SUPERVISOR_FAILED; }
            break;
        }
    }
    if (s->spawned && (!s->observed || !s->reaped)) {
        s->uncertain = true;
        if (s->observed && s->owned && !s->setup_error) {
            s->reason = SUPERVISOR_FAILED;
            record_error(s, EINTR);
        }
    }
    close_owned_fd(s, &s->gate_write);
    close_owned_fd(s, &s->gate_read);
}
static void final_signal(struct supervisor *s, uint64_t now) {
    signal_root(s, SIGKILL); /* Last possible signal syscall for this instance. */
    s->signal_enabled = false;
    s->phase = SETTLING;
    s->phase_end = now + SETTLE_MS;
}
static void begin_cleanup(struct supervisor *s, uint64_t now) {
    close_owned_fd(s, &s->gate_write); /* EOF aborts an unreleased gate. */
    if (!s->owned || s->observed) { final_signal(s, now); return; }
    signal_root(s, SIGTERM);
    s->phase = TERMINATING;
    s->phase_end = now + TERM_MS;
}
static void step(struct supervisor *s) {
    uint64_t now = s->ops->now(s->context);
    if (s->phase == RETIRED) return;
    (void)observe_root(s);
    if (s->phase == SETTLING) {
        if (s->observed || !s->owned || now >= s->phase_end) retire_and_reap(s);
        return;
    }
    if (s->phase == TERMINATING) {
        if (s->observed || !s->owned || now >= s->phase_end) final_signal(s, now);
        return;
    }
    /* Read private exec-error evidence even when the root just became waitable. */
    read_gate(s);
    bool go = read_control(s);
    if (!s->terminal && now >= s->wall_end) stop_request(s, TIMED_OUT, 0);
    else if (!s->terminal && !s->release_issued && now >= s->startup_end)
        stop_request(s, SETUP_FAILED, ETIMEDOUT);
    if (s->observed && !s->terminal) {
        stop_request(s, s->release_issued ? COMPLETED : SETUP_FAILED,
                     s->release_issued ? 0 : EIO);
    }
    flush_status(s);
    if (s->terminal) { begin_cleanup(s, now); return; }
    if (go) {
        /* Catch A/EOF that became readable while validating/forwarding READY. */
        (void)read_control(s);
        if (s->terminal) { begin_cleanup(s, now); return; }
        uint64_t release_now = s->ops->now(s->context);
        if (release_now >= s->wall_end || release_now >= s->startup_end) {
            bool wall_expired = release_now >= s->wall_end;
            stop_request(s, wall_expired ? TIMED_OUT : SETUP_FAILED,
                         wall_expired ? 0 : ETIMEDOUT);
            begin_cleanup(s, release_now); return;
        }
        ssize_t n = s->ops->write_bytes(s->context, s->gate_write, "G", 1);
        if (n != 1) {
            stop_request(s, SETUP_FAILED, n < 0 ? errno : EIO);
            begin_cleanup(s, now); return;
        }
        s->release_issued = true; s->phase = ACTIVE;
        close_owned_fd(s, &s->gate_write);
    }
}
static const char *reason_name(enum reason value) {
    static const char *const names[] = {
        "completed", "cancelled", "timed_out", "setup_failed", "supervisor_failed"
    };
    return names[value];
}
static const char *boolean(bool value) { return value ? "true" : "false"; }
static bool queue_final(struct supervisor *s) {
    char code[24], sig[24], error[24], errors[160], record[MAX_RECORD];
    if (s->exit_code < 0) strcpy(code, "null"); else snprintf(code, sizeof(code), "%d", s->exit_code);
    if (s->exit_signal < 0) strcpy(sig, "null"); else snprintf(sig, sizeof(sig), "%d", s->exit_signal);
    if (!s->setup_error) strcpy(error, "null"); else snprintf(error, sizeof(error), "%d", s->setup_error);
    size_t used = 0;
    if (s->term_error) used = (size_t)snprintf(errors, sizeof(errors),
        "{\"phase\":\"term\",\"errno\":%d}", s->term_error);
    if (s->kill_error) used += (size_t)snprintf(errors + used, sizeof(errors) - used,
        "%s{\"phase\":\"kill\",\"errno\":%d}", used ? "," : "", s->kill_error);
    errors[used] = '\0';
    int n = snprintf(record, sizeof(record),
        "{\"v\":1,\"type\":\"final\",\"reason\":\"%s\",\"spawned\":%s,"
        "\"releaseIssued\":%s,\"rootExitObserved\":%s,\"rootReaped\":%s,"
        "\"groupVerified\":%s,\"cleanupUncertain\":%s,\"exitCode\":%s,\"signal\":%s,"
        "\"finalKillAttempted\":%s,\"signalErrors\":[%s],\"setupError\":%s}\n",
        reason_name(s->reason), boolean(s->spawned), boolean(s->release_issued),
        boolean(s->observed), boolean(s->reaped), boolean(s->group_verified),
        boolean(s->uncertain), code, sig, boolean(s->final_kill), errors, error);
    return n > 0 && n < (int)sizeof(record) && queue_record(s, record, (size_t)n);
}
static void finish_status(struct supervisor *s) {
    if (!queue_final(s)) { s->status_broken = true; return; }
    uint64_t end = s->ops->now(s->context) + FLUSH_MS;
    /* Iteration cap independently bounds repeated interrupted sleeps/time mocks. */
    for (unsigned i = 0; i < FLUSH_MS + 1 && !s->status_broken &&
         s->status_sent < s->status_used && s->ops->now(s->context) < end; i++) {
        flush_status(s);
        if (s->status_sent < s->status_used) s->ops->pause_tick(s->context);
    }
    if (s->status_sent != s->status_used) s->status_broken = true;
}

static int fd_flags(int fd, bool nonblocking) {
    int f = fcntl(fd, F_GETFD);
    if (f < 0 || fcntl(fd, F_SETFD, f | FD_CLOEXEC) < 0) return errno;
    if (nonblocking) {
        f = fcntl(fd, F_GETFL);
        if (f < 0 || fcntl(fd, F_SETFL, f | O_NONBLOCK) < 0) return errno;
    }
    return 0;
}
static int default_signals(bool supervisor) {
    sigset_t empty; sigemptyset(&empty);
    if (sigprocmask(SIG_SETMASK, &empty, NULL) < 0) return errno;
    struct sigaction action;
    memset(&action, 0, sizeof(action)); sigemptyset(&action.sa_mask);
    for (int n = 1; n < NSIG; n++) {
        if (n == SIGKILL || n == SIGSTOP) continue;
        action.sa_handler = supervisor && n == SIGPIPE ? SIG_IGN : SIG_DFL;
        if (sigaction(n, &action, NULL) < 0) return errno;
    }
    return 0;
}
static int make_gate_pipe(int fds[2]) {
    if (pipe(fds) < 0) return errno;
    int error = fd_flags(fds[0], true);
    if (!error) error = fd_flags(fds[1], true);
    if (error) { close(fds[0]); close(fds[1]); fds[0] = fds[1] = -1; }
    return error;
}
static int canonical_file(const char *input, char output[PATH_MAX]) {
    if (!input || input[0] != '/' || !realpath(input, output)) return input && input[0] == '/' ? errno : EINVAL;
    struct stat st;
    if (stat(output, &st) < 0) return errno;
    return S_ISREG(st.st_mode) ? 0 : EINVAL;
}
static int self_path(char output[PATH_MAX]) {
    char raw[PATH_MAX]; uint32_t size = sizeof(raw);
    if (_NSGetExecutablePath(raw, &size) != 0) return ENAMETOOLONG;
    return canonical_file(raw, output);
}
static bool safe_environment(void) {
    for (size_t i = 0; environ && environ[i]; i++) {
        if (i >= 256 || strlen(environ[i]) > 65536) return false;
        if (!strncmp(environ[i], "DYLD_", 5) || !strncmp(environ[i], "LD_", 3)) return false;
    }
    return true;
}
static int spawn_root(struct supervisor *s, const char *profile, char *const command[]) {
    char executable[PATH_MAX], canonical_profile[PATH_MAX];
    int error = self_path(executable);
    if (!error) error = canonical_file(profile, canonical_profile);
    if (!error && strcmp(profile, canonical_profile)) error = EINVAL;
    if (error) return error;
    if (!command[0] || !command[0][0]) return EINVAL;
    size_t count = 0;
    while (command[count]) { if (++count > 257) return E2BIG; }
    char *argv[266];
    argv[0] = (char *)"/usr/bin/sandbox-exec"; argv[1] = (char *)"-f";
    argv[2] = canonical_profile; argv[3] = executable;
    argv[4] = (char *)"--gate"; argv[5] = (char *)"--";
    for (size_t i = 0; i <= count; i++) argv[6 + i] = command[i];
    int release[2] = {-1, -1}, ready[2] = {-1, -1}, staged[5] = {-1, -1, -1, -1, -1};
    bool actions_live = false, attrs_live = false;
    posix_spawn_file_actions_t actions;
    posix_spawnattr_t attrs;
    error = make_gate_pipe(release);
    if (!error) error = make_gate_pipe(ready);
    if (error) goto cleanup;
    int sources[5] = {0, 1, 2, release[0], ready[1]};
    const int targets[5] = {0, 1, 2, GATE_READ_FD, GATE_STATUS_FD};
    for (int i = 0; i < 5; i++) {
        staged[i] = fcntl(sources[i], F_DUPFD_CLOEXEC, 8);
        if (staged[i] < 0) { error = errno; goto cleanup; }
    }
    error = posix_spawn_file_actions_init(&actions);
    if (error) goto cleanup;
    actions_live = true;
    for (int i = 0; i < 5; i++) {
        error = posix_spawn_file_actions_adddup2(&actions, staged[i], targets[i]);
        if (error) goto cleanup;
    }
    for (int i = 0; i < 5; i++) {
        error = posix_spawn_file_actions_addclose(&actions, staged[i]);
        if (error) goto cleanup;
    }
    error = posix_spawnattr_init(&attrs);
    if (error) goto cleanup;
    attrs_live = true;
    sigset_t empty, defaults; sigemptyset(&empty); sigfillset(&defaults);
    sigdelset(&defaults, SIGKILL); sigdelset(&defaults, SIGSTOP);
    error = posix_spawnattr_setsigmask(&attrs, &empty);
    if (!error) error = posix_spawnattr_setsigdefault(&attrs, &defaults);
    if (!error) error = posix_spawnattr_setflags(&attrs, POSIX_SPAWN_SETSID |
        POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
    if (error) goto cleanup;
    /* Recheck after path/action preparation, before a root can exist. */
    (void)read_control(s);
    uint64_t now = s->ops->now(s->context);
    if (!s->terminal && now >= s->wall_end) stop_request(s, TIMED_OUT, 0);
    else if (!s->terminal && now >= s->startup_end) stop_request(s, SETUP_FAILED, ETIMEDOUT);
    if (s->terminal) goto cleanup;
    pid_t root = -1;
    error = posix_spawn(&root, "/usr/bin/sandbox-exec", &actions, &attrs, argv, environ);
    if (!error) {
        /* Record ownership BEFORE any cleanup/setup operation that can fail. */
        s->root = root; s->spawned = true; s->owned = true; s->signal_enabled = true;
        s->gate_write = release[1]; release[1] = -1;
        s->gate_read = ready[0]; ready[0] = -1;
        close(0); close(1); close(2); /* Never use stdio APIs in S after this point. */
    }
cleanup:
    if (actions_live) (void)posix_spawn_file_actions_destroy(&actions);
    if (attrs_live) (void)posix_spawnattr_destroy(&attrs);
    for (int i = 0; i < 5; i++) if (staged[i] >= 0) close(staged[i]);
    for (int i = 0; i < 2; i++) {
        if (release[i] >= 0) close(release[i]);
        if (ready[i] >= 0) close(ready[i]);
    }
    return error;
}

static bool bounded_write(int fd, const void *bytes, size_t size, uint64_t end) {
    size_t offset = 0;
    for (unsigned i = 0; i < STARTUP_MS + 1 && offset < size && system_now(NULL) < end; i++) {
        ssize_t n = write(fd, (const char *)bytes + offset, size - offset);
        if (n > 0) offset += (size_t)n;
        else if (n < 0 && errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) return false;
        else if (n == 0) return false;
        if (offset < size) system_pause(NULL);
    }
    return offset == size;
}
static void gate_error(int error) {
    struct gate_record r = { GATE_MAGIC, GATE_ERROR, getpid(), getpgrp(), getsid(0), error };
    /* Failure reporting must not terminate via SIGPIPE or delay an exit. */
    struct sigaction action; memset(&action, 0, sizeof(action));
    action.sa_handler = SIG_IGN; sigemptyset(&action.sa_mask);
    (void)sigaction(SIGPIPE, &action, NULL);
    (void)bounded_write(GATE_STATUS_FD, &r, sizeof(r), system_now(NULL) + FLUSH_MS);
}
static int gate_main(char *const command[]) {
    int error = fd_flags(GATE_READ_FD, true);
    if (!error) error = fd_flags(GATE_STATUS_FD, true);
    if (!error && (fcntl(CONTROL_FD, F_GETFD) >= 0 || fcntl(STATUS_FD, F_GETFD) >= 0)) error = EPROTO;
    if (!error) error = default_signals(true); /* Ignore SIGPIPE only during trusted gate I/O. */
    if (error) { gate_error(error); return 127; }
    struct gate_record ready = { GATE_MAGIC, GATE_READY, getpid(), getpgrp(), getsid(0), 0 };
    uint64_t end = system_now(NULL) + STARTUP_MS;
    if (!bounded_write(GATE_STATUS_FD, &ready, sizeof(ready), end)) return 127;
    for (unsigned i = 0; i < STARTUP_MS + 1 && system_now(NULL) < end; i++) {
        unsigned char c;
        ssize_t n = read(GATE_READ_FD, &c, 1);
        if (n == 1) {
            if (c != 'G') return 127;
            close(GATE_READ_FD);
            error = default_signals(false);
            if (error) { gate_error(error); return 127; }
            /* FD6 is CLOEXEC from fd_flags; all requested exec paths lose it. */
            execvp(command[0], command);
            error = errno; gate_error(error); return 127;
        }
        if (n == 0) return 127; /* Abort/parent failure: never execute payload. */
        if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) return 127;
        system_pause(NULL);
    }
    gate_error(ETIMEDOUT);
    return 127;
}
static bool parse_timeout(const char *text, uint64_t *value) {
    if (!text || !*text) return false;
    uint64_t n = 0;
    for (size_t i = 0; text[i]; i++) {
        if (i >= 7 || text[i] < '0' || text[i] > '9') return false;
        n = n * 10 + (unsigned)(text[i] - '0');
        if (n > MAX_WALL_MS) return false;
    }
    if (!n) return false;
    *value = n; return true;
}
static bool valid_build_id(void) {
    const char *id = FREEDOM_SUPERVISOR_BUILD_ID;
    if (strlen(id) != 64) return false;
    for (size_t i = 0; i < 64; i++)
        if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f'))) return false;
    return true;
}
int main(int argc, char **argv) {
    if (mach_timebase_info(&timebase) != KERN_SUCCESS || !timebase.denom) return 125;
    uint64_t start = system_now(NULL);
    if (argc == 2 && !strcmp(argv[1], "--version")) {
        if (!valid_build_id()) return 125;
        char output[128];
        int n = snprintf(output, sizeof(output), "{\"protocol\":1,\"build\":\"%s\"}\n", FREEDOM_SUPERVISOR_BUILD_ID);
        if (n <= 0 || n >= (int)sizeof(output) || fd_flags(1, true)) return 125;
        if (default_signals(true)) return 125;
        return bounded_write(1, output, (size_t)n, start + FLUSH_MS) ? 0 : 125;
    }
    if (argc >= 4 && !strcmp(argv[1], "--gate") && !strcmp(argv[2], "--")) {
        if (!valid_build_id()) return 125;
        return gate_main(&argv[3]);
    }
    struct supervisor s;
    initialize(&s, &SYSTEM_OPS, NULL, start, STARTUP_MS);
    int error = default_signals(true);
    if (!error) error = fd_flags(STATUS_FD, true);
    if (error) return 125; /* No root exists; status may not be safely writable. */
    uint64_t timeout = 0;
    if (argc < 6 || strcmp(argv[1], "--supervise") || strcmp(argv[4], "--") ||
        !parse_timeout(argv[2], &timeout) || !valid_build_id()) error = EINVAL;
    if (!error && !safe_environment()) error = EINVAL;
    if (!error) error = fd_flags(CONTROL_FD, true);
    /* Validate stdio before pipe() can reuse an accidentally vacant standard FD. */
    for (int fd = 0; !error && fd < 3; fd++)
        if (fcntl(fd, F_GETFD) < 0) error = errno;
    if (!error) {
        s.wall_end = start + timeout;
        s.startup_end = start + (timeout < STARTUP_MS ? timeout : STARTUP_MS);
        (void)read_control(&s); /* EOF/A before spawn must not create C. */
        if (!s.terminal) error = spawn_root(&s, argv[3], &argv[5]);
    }
    if (error) stop_request(&s, SETUP_FAILED, error);
    if (!s.spawned) {
        s.signal_enabled = false; s.phase = RETIRED;
        finish_status(&s); return s.status_broken ? 125 : 0;
    }
    /* Fixed work per tick, finite total wall deadline and fixed cleanup phases.
     * No safety alarm and no generic reaper is installed in production. */
    while (s.phase != RETIRED) { step(&s); if (s.phase != RETIRED) system_pause(NULL); }
    finish_status(&s);
    close(CONTROL_FD); close(STATUS_FD);
    return s.status_broken ? 125 : 0;
}
