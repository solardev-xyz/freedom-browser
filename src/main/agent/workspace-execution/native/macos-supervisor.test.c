/* Pure in-process tests: no production entry point or SYSTEM_OPS is called. */
#define FREEDOM_SUPERVISOR_BUILD_ID "unbuilt-unit"
#define main freedom_production_entry_not_called
#include "macos-supervisor.c"
#undef main
#include <assert.h>

struct mock {
    uint64_t time;
    uint64_t control_read_time;
    int observe_error, reap_result, signal_error, verify_error;
    bool waitable, did_reap, eof, gate_eof;
    int status_value, status_code, signal_count, reap_count, observe_count, gate_writes;
    int interrupted_reads, write_error, write_calls;
    size_t write_limit;
    pid_t signal_targets[4];
    int signals[4];
    unsigned char control[64], gate[128];
    size_t control_length, control_offset, gate_length, gate_offset;
    char output[4096];
    size_t output_used;
};
static uint64_t mock_now(void *p) { return ((struct mock *)p)->time; }
static int mock_observe(void *p, pid_t pid, siginfo_t *info) {
    struct mock *m = p; m->observe_count++;
    if (m->observe_error) return m->observe_error;
    if (m->waitable) { info->si_pid = pid; info->si_code = m->status_code; info->si_status = m->status_value; }
    return 0;
}
static int mock_reap(void *p, pid_t pid, int *status) {
    (void)pid;
    struct mock *m = p; m->reap_count++;
    if (m->reap_result == 1) {
        assert(!m->did_reap); m->did_reap = true;
        *status = m->status_code == CLD_EXITED ? m->status_value << 8 : m->status_value;
    }
    return m->reap_result;
}
static int mock_signal(void *p, pid_t pid, int signo) {
    struct mock *m = p;
    assert(!m->did_reap && m->signal_count < 4);
    m->signal_targets[m->signal_count] = pid;
    m->signals[m->signal_count++] = signo;
    return m->signal_error;
}
static int mock_verify(void *p, pid_t pid) { (void)pid; return ((struct mock *)p)->verify_error; }
static ssize_t mock_read(void *p, int fd, void *buffer, size_t n) {
    struct mock *m = p;
    if (m->interrupted_reads > 0) { m->interrupted_reads--; errno = EINTR; return -1; }
    unsigned char *source; size_t *offset, length; bool eof;
    if (fd == CONTROL_FD) {
        if (m->control_read_time) m->time = m->control_read_time;
        source = m->control; offset = &m->control_offset; length = m->control_length; eof = m->eof;
    } else {
        assert(fd == 10);
        source = m->gate; offset = &m->gate_offset; length = m->gate_length; eof = m->gate_eof;
    }
    if (*offset < length) {
        size_t amount = length - *offset; if (amount > n) amount = n;
        memcpy(buffer, source + *offset, amount); *offset += amount; return (ssize_t)amount;
    }
    if (eof) return 0;
    errno = EAGAIN; return -1;
}
static ssize_t mock_write(void *p, int fd, const void *buffer, size_t n) {
    struct mock *m = p; m->write_calls++;
    if (m->write_error) { errno = m->write_error; return -1; }
    if (fd == 9) { assert(n == 1 && *(const char *)buffer == 'G'); m->gate_writes++; return 1; }
    assert(fd == STATUS_FD);
    if (m->write_limit && n > m->write_limit) n = m->write_limit;
    assert(m->output_used + n < sizeof(m->output));
    memcpy(m->output + m->output_used, buffer, n); m->output_used += n;
    m->output[m->output_used] = '\0'; return (ssize_t)n;
}
static void mock_close(void *p, int fd) { (void)p; assert(fd >= 0); }
static void mock_pause(void *p) { ((struct mock *)p)->time += TICK_MS; }
static const struct operations MOCK_OPS = {
    mock_now, mock_observe, mock_reap, mock_signal, mock_verify,
    mock_read, mock_write, mock_close, mock_pause
};
static void fixture(struct supervisor *s, struct mock *m) {
    memset(m, 0, sizeof(*m)); m->reap_result = 1; m->status_code = CLD_EXITED;
    initialize(s, &MOCK_OPS, m, 0, 10000);
    s->root = 4242; s->spawned = true; s->owned = true; s->signal_enabled = true;
    s->gate_write = 9; s->gate_read = 10;
}
static void controls(struct mock *m, const char *text, bool eof) {
    m->control_length = strlen(text); memcpy(m->control, text, m->control_length);
    m->control_offset = 0; m->eof = eof;
}
static void gate_ready(struct mock *m) {
    struct gate_record r = {GATE_MAGIC, GATE_READY, 4242, 4242, 4242, 0};
    memcpy(m->gate, &r, sizeof(r)); m->gate_length = sizeof(r);
}
static void drive(struct supervisor *s, struct mock *m) {
    for (unsigned i = 0; i < 2000 && s->phase != RETIRED; i++) {
        step(s); mock_pause(m);
    }
    assert(s->phase == RETIRED);
}
static void ready_state(struct supervisor *s, struct mock *m) {
    gate_ready(m); step(s); assert(s->ready_sent && s->group_verified && !s->release_issued);
}
static void test_abort_gate_setup(void) {
    struct supervisor s; struct mock m; fixture(&s, &m);
    controls(&m, "A", false); step(&s);
    assert(s.phase == TERMINATING && s.reason == CANCELLED && !s.release_issued);
    assert(s.gate_write == -1 && m.signal_targets[0] == 4242);
    m.waitable = true; m.status_value = 127; drive(&s, &m);
    assert(s.reaped && !s.uncertain && m.gate_writes == 0);
}
static void test_echild_disables_authority(void) {
    struct supervisor s; struct mock m; fixture(&s, &m); m.observe_error = ECHILD;
    drive(&s, &m); signal_root(&s, SIGKILL);
    assert(m.signal_count == 0 && m.reap_count == 0 && !s.owned && !s.signal_enabled);
    assert(s.uncertain && s.reason == SUPERVISOR_FAILED && s.setup_error == ECHILD);
}
static void test_natural_exit_last_signal_before_reap(void) {
    struct supervisor s; struct mock m; fixture(&s, &m); ready_state(&s, &m);
    controls(&m, "G", false); step(&s); assert(s.release_issued && m.gate_writes == 1);
    m.waitable = true; m.status_value = 7; m.gate_eof = true;
    drive(&s, &m);
    assert(m.signal_count == 1 && m.signals[0] == SIGKILL && m.signal_targets[0] == -4242);
    assert(s.reaped && s.exit_code == 7 && s.reason == COMPLETED && !s.signal_enabled);
    signal_root(&s, SIGTERM); signal_root(&s, SIGKILL); step(&s);
    assert(m.signal_count == 1 && m.reap_count == 1);
}
static void test_cancel_priority(void) {
    const char *commands[] = {"GA", "G"};
    for (unsigned i = 0; i < 2; i++) {
        struct supervisor s; struct mock m; fixture(&s, &m); ready_state(&s, &m);
        controls(&m, commands[i], i == 1); step(&s);
        assert(s.reason == CANCELLED && !s.release_issued && !m.gate_writes);
    }
}
static void test_invalid_commands(void) {
    const char *commands[] = {"GG", "AA", "X", "GGGGGGGGGG"};
    for (unsigned i = 0; i < 4; i++) {
        struct supervisor s; struct mock m; fixture(&s, &m); ready_state(&s, &m);
        controls(&m, commands[i], false); step(&s);
        assert(s.reason == SUPERVISOR_FAILED && !s.release_issued && !m.gate_writes);
    }
    struct supervisor s; struct mock m; fixture(&s, &m);
    controls(&m, "G", false); step(&s); assert(s.reason == SUPERVISOR_FAILED && !m.gate_writes);
}
static void test_wait_eintr_bounded(void) {
    struct supervisor s; struct mock m; fixture(&s, &m); m.observe_error = EINTR;
    drive(&s, &m);
    assert(s.setup_error == EINTR && s.uncertain && !s.reaped);
    assert(m.signal_count == 2 && m.reap_count == 0 && m.time < 1500);
}
static void test_unwaitable_bounded(void) {
    struct supervisor s; struct mock m; fixture(&s, &m); controls(&m, "A", false);
    drive(&s, &m);
    assert(s.uncertain && !s.observed && !s.reaped && m.reap_count == 0);
    assert(m.signal_count == 2 && m.time <= TERM_MS + SETTLE_MS + 30);
}
static void test_reap_eintr_bounded(void) {
    struct supervisor s; struct mock m; fixture(&s, &m);
    m.waitable = true; m.reap_result = -EINTR; s.release_issued = true;
    drive(&s, &m);
    assert(m.reap_count == IO_BATCH && s.uncertain && !s.reaped && !s.signal_enabled);
    assert(s.setup_error == EINTR && m.signal_count == 1);
}
static void test_reap_echild_no_retry(void) {
    struct supervisor s; struct mock m; fixture(&s, &m);
    m.waitable = true; m.reap_result = -ECHILD;
    drive(&s, &m); signal_root(&s, SIGKILL);
    assert(m.reap_count == 1 && m.signal_count == 1 && !s.owned && s.uncertain);
}
static void test_signal_errno_receipt(void) {
    struct supervisor s; struct mock m; fixture(&s, &m);
    s.release_issued = true; s.group_verified = true; m.waitable = true; m.signal_error = EPERM;
    drive(&s, &m); finish_status(&s);
    assert(s.reason == COMPLETED && s.reaped && s.uncertain && s.kill_error == EPERM);
    assert(strstr(m.output, "\"phase\":\"kill\",\"errno\":1"));
    assert(strstr(m.output, "\"cleanupUncertain\":true"));
    assert(!strstr(m.output, "4242") && s.status_records == 1 && s.status_used < MAX_RECORD);
}
static void test_status_failure_cleans_up(void) {
    struct supervisor s; struct mock m; fixture(&s, &m);
    gate_ready(&m); m.write_error = EPIPE; step(&s);
    assert(s.status_broken && s.phase == TERMINATING && !s.release_issued);
    m.waitable = true; drive(&s, &m);
    assert(s.reaped && m.signal_count == 2 && s.reason == SUPERVISOR_FAILED);
}
static void test_status_backpressure_deadline(void) {
    struct supervisor s; struct mock m; fixture(&s, &m); gate_ready(&m); m.write_error = EAGAIN;
    drive(&s, &m); unsigned calls = (unsigned)m.write_calls;
    finish_status(&s);
    assert(!s.release_issued && s.status_broken && m.time < 7000);
    assert((unsigned)m.write_calls - calls <= FLUSH_MS / TICK_MS + 1);
}
static void test_partial_status_framing(void) {
    struct supervisor s; struct mock m; fixture(&s, &m); ready_state(&s, &m);
    m.waitable = true; drive(&s, &m); m.write_limit = 7; finish_status(&s);
    assert(!s.status_broken && s.status_records == 2 && s.status_used < MAX_STATUS);
    unsigned lines = 0; for (size_t i = 0; i < m.output_used; i++) if (m.output[i] == '\n') lines++;
    assert(lines == 2 && !strncmp(m.output, "{\"v\":1,\"type\":\"ready\"}\n", 23));
    assert(!queue_record(&s, "{}\n", 3));
}
static void test_group_verification_failure(void) {
    struct supervisor s; struct mock m; fixture(&s, &m); gate_ready(&m); m.verify_error = EPERM;
    step(&s); assert(s.terminal && !s.group_verified && !s.ready_sent && !s.release_issued);
    assert(m.signal_targets[0] == 4242);
}
static void test_gate_eof_aborts(void) {
    struct supervisor s; struct mock m; fixture(&s, &m); m.gate_eof = true;
    step(&s); assert(s.reason == SETUP_FAILED && s.setup_error == EPIPE && !s.release_issued);
}
static void test_control_interrupted_budget(void) {
    struct supervisor s; struct mock m; fixture(&s, &m); m.interrupted_reads = 100;
    (void)read_control(&s);
    assert(s.terminal && s.reason == SUPERVISOR_FAILED && m.interrupted_reads == 96);
}
static void test_deadlines_before_release(void) {
    struct supervisor s; struct mock m; fixture(&s, &m); m.time = STARTUP_MS;
    step(&s); assert(s.reason == SETUP_FAILED && s.setup_error == ETIMEDOUT);
    fixture(&s, &m); s.wall_end = 1; s.startup_end = 1; m.time = 2;
    step(&s); assert(s.reason == TIMED_OUT && !s.release_issued);
}
static void test_no_root_final(void) {
    struct supervisor s; struct mock m; memset(&m, 0, sizeof(m));
    initialize(&s, &MOCK_OPS, &m, 0, 100);
    stop_request(&s, SETUP_FAILED, E2BIG); s.phase = RETIRED; finish_status(&s);
    assert(s.status_records == 1 && !s.uncertain && !m.signal_count && !m.reap_count);
    assert(strstr(m.output, "\"spawned\":false") && strstr(m.output, "\"finalKillAttempted\":false"));
}
static void test_deadline_expires_during_release(void) {
    for (int wall = 0; wall < 2; wall++) {
        struct supervisor s; struct mock m; fixture(&s, &m); ready_state(&s, &m);
        if (wall) s.startup_end = s.wall_end;
        m.time = s.startup_end - 1;
        m.control_read_time = s.startup_end;
        controls(&m, "G", false); step(&s);
        assert(!s.release_issued && m.gate_writes == 0);
        assert(s.reason == (wall ? TIMED_OUT : SETUP_FAILED));
        assert(s.setup_error == (wall ? 0 : ETIMEDOUT));
    }
}
static void test_timeout_parser(void) {
    uint64_t value = 0;
    assert(parse_timeout("1", &value) && value == 1);
    assert(parse_timeout("1800000", &value) && value == MAX_WALL_MS);
    assert(!parse_timeout("0", &value) && !parse_timeout("1800001", &value));
    assert(!parse_timeout("-1", &value) && !parse_timeout("+1", &value));
    assert(!parse_timeout(" 1", &value) && !parse_timeout("1x", &value));
}
static void test_gate_observation_error_is_terminal(void) {
    struct supervisor s; struct mock m; fixture(&s, &m);
    struct gate_record r = {GATE_MAGIC, GATE_READY, 4242, 4242, 4242, 0};
    m.observe_error = EINTR; consume_gate_record(&s, &r);
    assert(s.terminal && !s.group_verified && !s.ready_sent && s.setup_error == EINTR);
}
static void test_duplicate_gate_record_rejected(void) {
    struct supervisor s; struct mock m; fixture(&s, &m);
    struct gate_record r = {GATE_MAGIC, GATE_READY, 4242, 4242, 4242, 0};
    consume_gate_record(&s, &r); assert(s.group_verified);
    consume_gate_record(&s, &r); assert(s.terminal && s.reason == SUPERVISOR_FAILED);
}
static void test_private_exec_error_preserves_actual_status(void) {
    struct supervisor s; struct mock m; fixture(&s, &m); ready_state(&s, &m);
    controls(&m, "G", false); step(&s); assert(s.release_issued);
    struct gate_record r = {GATE_MAGIC, GATE_ERROR, 4242, 4242, 4242, ENOENT};
    memcpy(m.gate + m.gate_length, &r, sizeof(r)); m.gate_length += sizeof(r);
    m.waitable = true; m.status_value = 127; m.gate_eof = true;
    drive(&s, &m);
    assert(s.reason == COMPLETED && s.setup_error == ENOENT && s.exit_code == 127 && s.reaped);
}
static void test_repeated_go_after_release_rejected(void) {
    struct supervisor s; struct mock m; fixture(&s, &m); ready_state(&s, &m);
    controls(&m, "G", false); step(&s); assert(m.gate_writes == 1);
    controls(&m, "G", false); step(&s);
    assert(s.reason == SUPERVISOR_FAILED && m.gate_writes == 1);
}
int main(void) {
    void (*const tests[])(void) = {
        test_abort_gate_setup, test_echild_disables_authority,
        test_natural_exit_last_signal_before_reap, test_cancel_priority,
        test_invalid_commands, test_wait_eintr_bounded, test_unwaitable_bounded,
        test_reap_eintr_bounded, test_reap_echild_no_retry, test_signal_errno_receipt,
        test_status_failure_cleans_up, test_status_backpressure_deadline,
        test_partial_status_framing, test_group_verification_failure,
        test_gate_eof_aborts, test_control_interrupted_budget,
        test_deadlines_before_release, test_no_root_final, test_timeout_parser,
        test_gate_observation_error_is_terminal, test_duplicate_gate_record_rejected,
        test_private_exec_error_preserves_actual_status, test_repeated_go_after_release_rejected,
        test_deadline_expires_during_release
    };
    for (size_t i = 0; i < sizeof(tests) / sizeof(tests[0]); i++) {
        tests[i](); printf("ok %zu\n", i + 1);
    }
    printf("%zu mock tests passed; zero real fork/spawn/signal operations\n",
           sizeof(tests) / sizeof(tests[0]));
    return 0;
}
