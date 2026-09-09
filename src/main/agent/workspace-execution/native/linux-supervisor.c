/* SPDX-License-Identifier: MPL-2.0
 * Linux x64 only. B -> S -> I (new lifetime PID namespace) -> bwrap -> gate.
 * No numeric signal operations. See linux-supervisor.md for the source proof.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/sched.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <sched.h>

#ifndef FREEDOM_SUPERVISOR_BUILD_ID
#define FREEDOM_SUPERVISOR_BUILD_ID "unbuilt"
#endif
#define CLEANUP_MS 2000
#define MAX_WALL_MS 86400000
#define GATE_PATH "/run/freedom-workspace-owner"

struct terminal { int code, signal; };
struct owner {
    bool created, armed, ready, released, observed, retired, reaped, uncertain;
    int pidfd, error;
    struct terminal actual;
    const char *reason;
};
struct operations {
    int (*send)(void *, int);
    int (*observe)(void *, int, struct terminal *);
    int (*reap)(void *, int, struct terminal *);
};
struct handoff_ops {
    bool (*arm)(void *);
    bool (*parent_alive)(void *);
    bool (*acknowledge)(void *);
    bool (*release)(void *);
};
static bool arm_parent(const struct handoff_ops *ops, void *ctx) {
    return ops->arm(ctx) && ops->parent_alive(ctx);
}
static bool handoff(const struct handoff_ops *ops, void *ctx) {
    return arm_parent(ops, ctx) &&
        ops->acknowledge(ctx) && ops->release(ctx) && ops->parent_alive(ctx);
}
static void request_stop(struct owner *o, const char *reason) {
    if (!o->reason) o->reason = reason;
}
static bool release_allowed(const struct owner *o) {
    return o->created && o->armed && o->ready && !o->released && !o->reason && !o->retired;
}
static bool accept_control(struct owner *o, char control) {
    if (control == 'G' && release_allowed(o)) {
        o->released = true; /* conservative even if the later pipe write fails */
        return true;
    }
    request_stop(o, control == 'A' ? "cancelled" : "protocol_error");
    return false;
}
static void cleanup_signal(struct owner *o, const struct operations *ops, void *ctx) {
    if (!o->created || o->retired || o->observed) return;
    int error = ops->send(ctx, o->pidfd);
    if (error && error != ESRCH) { o->error = error; o->uncertain = true; }
}
static void observe_and_reap(struct owner *o, const struct operations *ops, void *ctx) {
    if (!o->created || o->retired) return;
    struct terminal t = {-1, 0};
    int r = ops->observe(ctx, o->pidfd, &t);
    if (r == 0) return;
    if (r < 0) {
        o->error = -r; o->uncertain = true;
        if (r == -ECHILD) o->retired = true; /* authority lost, never rediscover */
        request_stop(o, "supervisor_failed");
        return;
    }
    o->actual = t; o->observed = true;
    o->retired = true; /* irreversible, before the sole destructive wait */
    struct terminal reaped = {-1, 0};
    r = ops->reap(ctx, o->pidfd, &reaped);
    o->reaped = r == 1;
    if (!o->reaped || t.code != reaped.code || t.signal != reaped.signal) {
        o->uncertain = true; o->error = r < 0 ? -r : EPROTO;
        request_stop(o, "supervisor_failed");
    }
}

#ifndef FREEDOM_OWNER_TEST
#if !defined(__x86_64__)
#error "Linux workspace ownership currently supports x86_64 only"
#endif
static int64_t now_ms(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts)) _exit(125);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
static int readable(int fd) {
    struct pollfd p = {.fd=fd, .events=POLLIN};
    int r = poll(&p, 1, 0);
    if (r < 0) return errno == EINTR ? 0 : -1;
    if (p.revents & POLLNVAL) return -1;
    return r && (p.revents & (POLLIN | POLLHUP | POLLERR)) ? 1 : 0;
}
static int nonblock(int fd) {
    int flags = fcntl(fd, F_GETFL);
    return flags < 0 ? -1 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
static int high_dup(int fd) { return fcntl(fd, F_DUPFD_CLOEXEC, 64); }
static int high_pipe(int p[2]) {
    int raw[2];
    if (pipe2(raw, O_CLOEXEC | O_NONBLOCK)) return -1;
    p[0] = high_dup(raw[0]); p[1] = high_dup(raw[1]);
    close(raw[0]); close(raw[1]);
    return p[0] < 0 || p[1] < 0 ? -1 : 0;
}
static bool byte_write(int fd, char c) { return write(fd, &c, 1) == 1; }
static bool wait_byte(int fd, char expected, int64_t deadline) {
    while (now_ms() < deadline) {
        char c;
        ssize_t n = read(fd, &c, 1);
        if (n == 1) return c == expected;
        if (n == 0 || (errno != EAGAIN && errno != EINTR)) return false;
        struct pollfd p = {.fd=fd, .events=POLLIN};
        if (poll(&p, 1, 10) < 0 && errno != EINTR) return false;
    }
    return false;
}
static int pidfd_signal(void *ctx, int fd) {
    (void)ctx;
    return syscall(SYS_pidfd_send_signal, fd, SIGKILL, NULL, 0) == 0 ? 0 : errno;
}
static int terminal_wait(int fd, struct terminal *t, bool reap) {
    siginfo_t info = {0};
    if (waitid(P_PIDFD, (id_t)fd, &info, WEXITED | WNOHANG | (reap ? 0 : WNOWAIT)))
        return errno == EINTR ? 0 : -errno;
    if (!info.si_pid) return 0;
    if (info.si_code == CLD_EXITED) { t->code = info.si_status; t->signal = 0; }
    else if (info.si_code == CLD_KILLED || info.si_code == CLD_DUMPED) {
        t->code = -1; t->signal = info.si_status;
    } else return -EPROTO;
    return 1;
}
static int native_observe(void *ctx, int fd, struct terminal *t) {
    (void)ctx;
    int r = readable(fd);
    if (r <= 0) return r < 0 ? -EBADF : 0;
    return terminal_wait(fd, t, false);
}
static int native_reap(void *ctx, int fd, struct terminal *t) {
    (void)ctx;
    return terminal_wait(fd, t, true);
}
static const struct operations native_ops = {pidfd_signal, native_observe, native_reap};
static pid_t clone_owned(uint64_t flags, int *pidfd) {
    struct clone_args args = {.flags=flags | CLONE_PIDFD,
        .pidfd=(uint64_t)(uintptr_t)pidfd, .exit_signal=SIGCHLD};
    return (pid_t)syscall(SYS_clone3, &args, sizeof(args));
}
static bool map_write(const char *path, const char *text) {
    int fd = open(path, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return false;
    size_t size = strlen(text);
    bool ok = write(fd, text, size) == (ssize_t)size;
    close(fd); return ok;
}
static bool create_user_context(const char **stage) {
    uid_t uid = getuid(); gid_t gid = getgid();
    *stage = "unprivileged_identity";
    if (!uid || uid != geteuid() || gid != getegid()) { errno = EPERM; return false; }
    *stage = "user_namespace";
    if (unshare(CLONE_NEWUSER)) return false;
    char map[96];
    snprintf(map, sizeof(map), "%u %u 1\n", uid, uid);
    *stage = "uid_map";
    if (!map_write("/proc/self/uid_map", map)) return false;
    *stage = "setgroups";
    if (!map_write("/proc/self/setgroups", "deny\n")) return false;
    snprintf(map, sizeof(map), "%u %u 1\n", gid, gid);
    *stage = "gid_map";
    return map_write("/proc/self/gid_map", map);
}
static int gate(int argc, char **argv) {
    if (argc < 4) return 125;
    /* Only 5=release reader and 6=exec-report writer survive the gate. */
    if (close(3) < 0 && errno != EBADF) return 125;
    if (close(4) < 0 && errno != EBADF) return 125;
    struct stat reader, writer;
    if (fcntl(0, F_GETFD) < 0 || fcntl(1, F_GETFD) < 0 || fcntl(2, F_GETFD) < 0 ||
        fstat(5, &reader) || fstat(6, &writer) || !S_ISFIFO(reader.st_mode) || !S_ISFIFO(writer.st_mode) ||
        (fcntl(5, F_GETFL) & O_ACCMODE) != O_RDONLY || (fcntl(6, F_GETFL) & O_ACCMODE) != O_WRONLY ||
        syscall(SYS_close_range, 7U, ~0U, 0) ||
        fcntl(6, F_SETFD, FD_CLOEXEC) < 0) return 125;
    if (!byte_write(6, 'R') || !wait_byte(5, 'G', now_ms() + MAX_WALL_MS)) return 125;
    close(5);
    if (!byte_write(6, 'E')) return 125;
    /* Marker is transport readiness, never original terminal/exec proof. */
    if (dprintf(1, "%s\n", argv[2]) < 0) return 125;
    execvp(argv[3], argv + 3);
    (void)byte_write(6, 'F');
    return 127;
}
struct inner_record { char type; int code, signal, error; };
static bool inner_write(int fd, char type, struct terminal t, int error) {
    struct inner_record r = {.type=type, .code=t.code, .signal=t.signal, .error=error};
    return write(fd, &r, sizeof(r)) == sizeof(r);
}
struct init_handoff { int parentfd, report, start; int64_t deadline; };
static bool arm_init(void *ctx) { (void)ctx; return prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) == 0; }
static bool original_browser_parent(void *ctx) {
    /* Own real-parent relationship, never a signal target or /proc scan. After
     * reparenting, a newly allocated process cannot become our old ancestor. */
    return getppid() == *(pid_t *)ctx;
}
static bool parent_alive(void *ctx) { return readable(((struct init_handoff *)ctx)->parentfd) == 0; }
static bool acknowledge_init(void *ctx) {
    return inner_write(((struct init_handoff *)ctx)->report, 'A', (struct terminal){-1,0}, 0);
}
static bool release_init(void *ctx) {
    struct init_handoff *h = ctx;
    return wait_byte(h->start, 'G', h->deadline);
}
static void init_process(int parentfd, int start, int report, int gate_read,
                         int gate_write, int executable, bool probe, char **command,
                         int64_t deadline) {
    /* No credential transition or exec occurs in I after this arm. The parent
     * pidfd refers to S itself, acquired by S before clone; getppid is not used. */
    struct init_handoff h = {parentfd, report, start, deadline};
    const struct handoff_ops hops = {arm_init, parent_alive, acknowledge_init, release_init};
    if (!handoff(&hops, &h)) _exit(125);
    close(start); close(parentfd);
    int mfd = -1;
    pid_t m = clone_owned(0, &mfd);
    if (m < 0) { (void)inner_write(report, 'F', (struct terminal){-1,0}, errno); _exit(125); }
    if (!m) {
        close(report); /* no descendant can forge native original M status */
        if (signal(SIGPIPE, SIG_DFL) == SIG_ERR) _exit(125);
        if (!probe && (dup2(gate_read, 5) < 0 || dup2(gate_write, 6) < 0 || dup2(executable, 8) < 0)) _exit(125);
        close(3); close(4);
        if (probe) { if (syscall(SYS_close_range, 3U, ~0U, 0)) _exit(125); }
        else {
            close(7);
            if (syscall(SYS_close_range, 9U, ~0U, 0)) _exit(125);
        }
        execv(command[0], command); _exit(127);
    }
    close(gate_read); close(gate_write); close(executable);
    close(0); close(1); close(2); /* I must not keep command transports open */
    struct owner monitor = {.created=true, .pidfd=mfd, .actual={-1,0}};
    while (now_ms() < deadline) {
        observe_and_reap(&monitor, &native_ops, NULL);
        if (monitor.retired) {
            (void)inner_write(report, monitor.reaped && !monitor.uncertain ? 'M' : 'F',
                monitor.actual, monitor.error);
            _exit(monitor.reaped && !monitor.uncertain ? 0 : 125);
        }
        struct pollfd p = {.fd=mfd, .events=POLLIN};
        if (poll(&p, 1, 10) < 0 && errno != EINTR) break;
    }
    (void)inner_write(report, 'F', monitor.actual, ETIMEDOUT);
    _exit(125); /* PID1 exit tears down M and every nested namespace */
}
static bool status_line(const char *text) {
    size_t n = strlen(text);
    return n <= 2048 && write(4, text, n) == (ssize_t)n;
}
int main(int argc, char **argv) {
    if (argc > 1 && !strcmp(argv[1], "--gate")) return gate(argc, argv);
    if (argc < 7 || (strcmp(argv[1], "--run") && strcmp(argv[1], "--probe")) || strcmp(argv[4], "--")) return 125;
    char *end; long wall = strtol(argv[2], &end, 10);
    if (*end || wall < 1 || wall > MAX_WALL_MS || strcmp(argv[5], "/usr/bin/bwrap")) return 125;
    long parent = strtol(argv[3], &end, 10);
    if (*end || parent < 1 || parent > INT_MAX) return 125;
    pid_t browser_parent = (pid_t)parent;
    bool probe = !strcmp(argv[1], "--probe");
    int64_t deadline = now_ms() + wall, cleanup_end = 0;
    struct owner o = {.pidfd=-1, .actual={-1,0}};
    const char *stage = "channels";
    struct terminal m = {-1,0};
    bool m_seen = false, inner_eof = false, gate_eof = false, exec_attempted = false, exec_failed = false;
    int self = -1, parentfd = -1, start[2] = {-1,-1}, report[2] = {-1,-1};
    int entry[2] = {-1,-1}, release[2] = {-1,-1};
    sigset_t empty; sigemptyset(&empty);
    if (sigprocmask(SIG_SETMASK, &empty, NULL) || signal(SIGCHLD, SIG_DFL) == SIG_ERR ||
        signal(SIGPIPE, SIG_IGN) == SIG_ERR || nonblock(3) || nonblock(4) ||
        prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) { o.error=errno; goto unavailable; }
    /* S is a fresh single-threaded executable. Browser control writer exists
     * only in B; S never has a copy. No descendants exist before this check. */
    if (readable(3)) { request_stop(&o, "cancelled"); goto final; }
    stage = "executable";
    self = open("/proc/self/exe", O_RDONLY | O_CLOEXEC);
    if (self < 0) goto unavailable;
    int temp = high_dup(self); close(self); self = temp;
    if (self < 0) goto unavailable;
    stage = "internal_channels";
    if (high_pipe(start) || high_pipe(report) || high_pipe(entry) || high_pipe(release)) goto unavailable;
    stage = "parent_pidfd";
    parentfd = (int)syscall(SYS_pidfd_open, getpid(), 0);
    if (parentfd < 0) goto unavailable;
    temp = high_dup(parentfd); close(parentfd); parentfd = temp;
    if (parentfd < 0 || !create_user_context(&stage)) goto unavailable;
    /* No descendants yet. User mapping can clear PDEATHSIG, so arm afterwards
     * and verify our original browser parent, supplied by that browser itself.
     * S never execs or changes credentials after this point. This backs up EOF
     * if another browser child transiently inherited its CLOEXEC writer. */
    stage = "browser_parent";
    const struct handoff_ops browser_ops = {arm_init, original_browser_parent, NULL, NULL};
    errno = 0;
    if (!arm_parent(&browser_ops, &browser_parent)) {
        if (errno) goto unavailable;
        request_stop(&o, "control_eof"); goto final;
    }
    /* All mapping/credential changes precede creation of I. */
    if (readable(3)) { request_stop(&o, "cancelled"); goto final; }
    stage = "lifetime_clone";
    pid_t i = clone_owned(CLONE_NEWPID, &o.pidfd);
    if (i < 0) goto unavailable;
    if (!i) {
        close(3); close(4); close(start[1]); close(report[0]); close(entry[0]); close(release[1]);
        init_process(parentfd, start[0], report[1], release[0], entry[1], self, probe, argv+5, deadline);
        _exit(125);
    }
    o.created = true;
    stage = "lifetime";
    close(5); /* original inherited executable descriptor is no longer needed */
    close(start[0]); close(report[1]); close(entry[1]); close(release[0]); close(parentfd); close(self);
    close(0); close(1); close(2);
    for (;;) {
        int64_t now = now_ms();
        if (now >= deadline) request_stop(&o, "timed_out");
        /* Pipes/sockets preserve byte order, not write boundaries: a valid G,A
         * pair may coalesce. Consume one byte rather than reject that race. */
        char control; ssize_t n = read(3, &control, 1);
        if (n == 0) request_stop(&o, "control_eof");
        else if (n > 0) {
            if (accept_control(&o, control)) {
                if (!byte_write(probe ? start[1] : release[1], 'G')) request_stop(&o, "setup_failed");
            }
        } else if (errno != EAGAIN && errno != EINTR) request_stop(&o, "protocol_error");
        struct inner_record r;
        n = read(report[0], &r, sizeof(r));
        if (n == 0) inner_eof = true;
        else if (n > 0) {
            if (n != sizeof(r)) request_stop(&o, "protocol_error");
            else if (r.type == 'A' && !o.armed) {
                o.armed = true;
                if (probe) o.ready = true;
                else if (!o.reason && !byte_write(start[1], 'G')) request_stop(&o, "setup_failed");
            } else if (r.type == 'M' && o.armed && !m_seen) { m_seen = true; m.code=r.code; m.signal=r.signal; }
            else { o.error=r.error; request_stop(&o, "setup_failed"); }
        } else if (errno != EAGAIN && errno != EINTR) request_stop(&o, "protocol_error");
        if (!probe && !gate_eof) {
            char event;
            n = read(entry[0], &event, 1);
            if (!n) gate_eof = true;
            else if (n == 1) {
                if (event == 'R' && o.armed && !o.ready) o.ready = true;
                else if (event == 'E' && o.released && !exec_attempted) exec_attempted = true;
                else if (event == 'F' && exec_attempted && !exec_failed) { exec_failed=true; request_stop(&o, "exec_failed"); }
                else request_stop(&o, "protocol_error");
            } else if (errno != EAGAIN && errno != EINTR) request_stop(&o, "protocol_error");
        }
        /* Exactly one READY. Internal A precedes it in both modes. */
        static bool ready_sent = false;
        if (o.ready && !ready_sent && !o.reason) {
            ready_sent = true;
            if (!status_line("{\"type\":\"READY\",\"protocol\":1}\n")) request_stop(&o, "control_eof");
        }
        if (o.reason && !cleanup_end) { cleanup_end=now+CLEANUP_MS; cleanup_signal(&o, &native_ops, NULL); }
        observe_and_reap(&o, &native_ops, NULL);
        if (o.retired) {
            /* Drain the bounded trusted internal record pipe before classifying
             * natural completion; I can exit before S reads M's record. */
            if (!inner_eof || (!probe && !gate_eof)) {
                if (now >= (cleanup_end ? cleanup_end : deadline + CLEANUP_MS)) { o.uncertain=true; break; }
                continue;
            }
            if (!o.reason) request_stop(&o, m_seen && !exec_failed && o.released &&
                (probe || exec_attempted) && o.actual.code == 0 ? "completed" : "setup_failed");
            break;
        }
        if (cleanup_end && now >= cleanup_end) {
            o.uncertain = true;
            cleanup_signal(&o, &native_ops, NULL); /* keep original authority to last owned attempt */
            break; /* S exit also triggers I's armed parent-death handoff */
        }
        struct pollfd p[4] = {{.fd=o.reason?-1:3,.events=POLLIN},
            {.fd=inner_eof?-1:report[0],.events=POLLIN},
            {.fd=(probe||gate_eof)?-1:entry[0],.events=POLLIN},{.fd=o.pidfd,.events=POLLIN}};
        if (poll(p, 4, 10) < 0 && errno != EINTR) request_stop(&o, "supervisor_failed");
    }
    goto final;
unavailable:
    o.error = errno;
    request_stop(&o, "unavailable");
final: {
    char line[2048];
    snprintf(line, sizeof(line), "{\"type\":\"FINAL\",\"protocol\":1,\"buildId\":\"%s\","
        "\"reason\":\"%s\",\"stage\":\"%s\",\"created\":%s,\"armed\":%s,\"released\":%s,\"execAttempted\":%s,"
        "\"observed\":%s,\"retired\":%s,\"reaped\":%s,\"uncertain\":%s,"
        "\"initCode\":%d,\"initSignal\":%d,\"monitorObserved\":%s,\"monitorCode\":%d,\"monitorSignal\":%d,\"error\":%d}\n",
        FREEDOM_SUPERVISOR_BUILD_ID, o.reason ? o.reason : "supervisor_failed", stage,
        o.created?"true":"false",o.armed?"true":"false",o.released?"true":"false",exec_attempted?"true":"false",
        o.observed?"true":"false",o.retired?"true":"false",o.reaped?"true":"false",o.uncertain?"true":"false",
        o.actual.code,o.actual.signal,m_seen?"true":"false",m.code,m.signal,o.error);
    bool sent = status_line(line);
    return sent && !o.uncertain && (!o.created || o.reaped) ? 0 : 125;
}}
#endif
