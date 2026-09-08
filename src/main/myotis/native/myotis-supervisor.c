/* Freedom Myotis direct-child supervisor. No descendant/sandbox guarantee.
 * This single-threaded process is the sole waiter and signal owner. It never
 * signals after retiring authority, and never reaps before retiring it.
 */
#define _DARWIN_C_SOURCE
#define _DEFAULT_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static int write_all(int fd, const char *s, size_t size) {
  while (size) {
    ssize_t n = write(fd, s, size);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return -1;
    s += n;
    size -= (size_t)n;
  }
  return 0;
}

static int record(int fd, const char *state, const char *generation) {
  char data[96];
  int size = snprintf(data, sizeof(data), "v1 %s %s\n", state, generation);
  return lseek(fd, 0, SEEK_SET) < 0 || ftruncate(fd, 0) < 0 ||
    write_all(fd, data, (size_t)size) < 0 || fsync(fd) < 0 ? -1 : 0;
}

/* 0 = parent control still open; EOF, input, or descriptor error = revoke. */
static int revoked(int timeout) {
  struct pollfd control = { .fd = STDIN_FILENO, .events = POLLIN | POLLHUP };
  int ready;
  do { ready = poll(&control, 1, timeout); } while (ready < 0 && errno == EINTR);
  return ready != 0;
}

static int valid_generation(const char *generation) {
  if (strlen(generation) != 36) return 0;
  for (size_t i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (generation[i] != '-') return 0;
    } else if (!((generation[i] >= '0' && generation[i] <= '9') ||
                 (generation[i] >= 'a' && generation[i] <= 'f'))) return 0;
  }
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 5 || !valid_generation(argv[3]) || argv[1][0] != '/' || argv[2][0] != '/') return 64;
  const char *generation = argv[3];
  const char *node_mode = getenv("ELECTRON_RUN_AS_NODE");
  if (!node_mode || strcmp(node_mode, "1") != 0) return 64;
  /* Node's private IPC fd must be exactly the separately inherited fd 3. */
  const char *ipc = getenv("NODE_CHANNEL_FD");
  if (!ipc || strcmp(ipc, "3") != 0) return 64;
  signal(SIGCHLD, SIG_DFL);
  signal(SIGPIPE, SIG_IGN);
  sigset_t empty;
  sigemptyset(&empty);
  if (sigprocmask(SIG_SETMASK, &empty, NULL) < 0 || revoked(0)) return 65;
  /* No stale profile-lock override authorizes data reuse: native ownership is
   * separately locked and durable. An active/malformed record is quarantine.
   */
  int directory = open(argv[4], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (directory < 0) return 66;
  int fresh = 1;
  int owner = openat(directory, ".freedom-myotis-owner", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (owner < 0 && errno == EEXIST) {
    fresh = 0;
    owner = openat(directory, ".freedom-myotis-owner", O_RDWR | O_NOFOLLOW);
  }
  struct stat info;
  if (owner < 0 || fstat(owner, &info) < 0 || !S_ISREG(info.st_mode) || info.st_nlink != 1 ||
      flock(owner, LOCK_EX | LOCK_NB) < 0) return 66;
  if (!fresh) {
    char prior[96] = {0};
    ssize_t size = read(owner, prior, sizeof(prior));
    if (size != 48 || memcmp(prior, "v1 retired ", 11) != 0 || prior[47] != '\n') return 67;
    prior[47] = '\0';
    if (!valid_generation(prior + 11)) return 67;
  }
  if (record(owner, "active", generation) < 0 || fsync(directory) < 0) return 68;
  close(directory);
  int gate[2];
  if (pipe(gate) < 0) return 68;
  if (revoked(0)) return 65; /* Active record conservatively remains quarantined. */
  pid_t child = fork();
  if (child < 0) return 69;
  if (child == 0) {
    close(gate[1]);
    close(owner); /* No lock/reporting authority in the addon process. */
    close(STDIN_FILENO);
    close(STDOUT_FILENO);
    int nullfd = open("/dev/null", O_RDWR);
    if (nullfd < 0 || dup2(nullfd, STDIN_FILENO) < 0 || dup2(nullfd, STDOUT_FILENO) < 0) _exit(126);
    if (nullfd > STDERR_FILENO) close(nullfd);
    char release;
    ssize_t size;
    do { size = read(gate[0], &release, 1); } while (size < 0 && errno == EINTR);
    close(gate[0]);
    if (size != 1 || release != 'R') _exit(126);
    for (int number = 1; number < NSIG; number++) {
      if (number == SIGKILL || number == SIGSTOP) continue;
      if (signal(number, SIG_DFL) == SIG_ERR && errno != EINVAL) _exit(126);
    }
    /* Only fd 3 (main/child IPC) and null stdio survive exec. */
    long limit = sysconf(_SC_OPEN_MAX);
    if (limit < 0) _exit(126);
    for (int fd = 4; fd < limit; fd++) close(fd);
    char *child_argv[] = { argv[1], argv[2], NULL };
    execv(argv[1], child_argv);
    _exit(127);
  }
  close(gate[0]);
  close(3); /* Only the addon owns the child side of Node IPC. */
  int terminate = revoked(0);
  if (!terminate && write_all(gate[1], "R", 1) < 0) terminate = 1;
  close(gate[1]);
  char receipt[192];
  int length = snprintf(receipt, sizeof(receipt), "{\"type\":\"owned\",\"generation\":\"%s\"}\n", generation);
  if (!terminate && write_all(STDOUT_FILENO, receipt, (size_t)length) < 0) terminate = 1;
  int status = 0;
  int forced = 0;
  for (;;) {
    siginfo_t observed;
    memset(&observed, 0, sizeof(observed));
    int result;
    do { result = waitid(P_PID, (id_t)child, &observed, WEXITED | WNOHANG | WNOWAIT); }
    while (result < 0 && errno == EINTR);
    if (result < 0) return 70; /* Lost ownership: never signal or declare terminal. */
    if (observed.si_pid == child || terminate) {
      if (terminate && observed.si_pid != child) {
        /* Still our unreaped direct child. It cannot have a reused PID. */
        if (kill(child, SIGKILL) < 0) return 71;
        forced = 1;
      }
      /* Signal authority permanently retired BEFORE the sole reaping wait. */
      pid_t retired = child;
      child = -1;
      pid_t waited;
      do { waited = waitpid(retired, &status, 0); } while (waited < 0 && errno == EINTR);
      if (waited != retired) return 72;
      break;
    }
    terminate = revoked(100);
  }
  if (record(owner, "retired", generation) < 0) return 73;
  length = snprintf(receipt, sizeof(receipt),
    "{\"type\":\"reaped\",\"generation\":\"%s\",\"exitCode\":%d,\"signal\":%d,\"forced\":%s}\n",
    generation, WIFEXITED(status) ? WEXITSTATUS(status) : -1,
    WIFSIGNALED(status) ? WTERMSIG(status) : 0, forced ? "true" : "false");
  if (write_all(STDOUT_FILENO, receipt, (size_t)length) < 0) return 74;
  /* Kernel closes the ownership lock on supervisor exit. */
  return 0;
}
