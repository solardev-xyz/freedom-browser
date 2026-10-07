/* Exit proof for interrupted owners: a lease held by both supervisor and
 * execution child, or a machine/boot witness for legacy records without that
 * lease. A free supervisor lock alone never proves an orphaned child is gone.
 * All operations run under the original native ownership lock. */
#define OWNER_WITNESS ".freedom-myotis-boot"
#define OWNER_LIFETIME ".freedom-myotis-lifetime"
#define OWNER_PROOF_SIZE 136
#define OWNER_BYTES_MAX 96
#ifdef _WIN32
#include <winternl.h>
#pragma comment(lib, "advapi32.lib")
typedef HANDLE owner_file;
typedef wchar_t owner_path_char;
#define OWNER_BAD INVALID_HANDLE_VALUE
#define owner_close CloseHandle
#else
#include <stdint.h>
#ifdef __APPLE__
#include <sys/mount.h>
#include <sys/sysctl.h>
#include <uuid/uuid.h>
#else
#include <sys/vfs.h>
#endif
typedef int owner_file;
typedef char owner_path_char;
#define OWNER_BAD (-1)
#define owner_close close
#endif

static int owner_read(owner_file file, char *bytes, size_t capacity) {
#ifdef _WIN32
  LARGE_INTEGER zero; zero.QuadPart = 0;
  DWORD size = 0;
  if (!SetFilePointerEx(file, zero, NULL, FILE_BEGIN) ||
      !ReadFile(file, bytes, (DWORD)capacity, &size, NULL)) return -1;
  return (int)size;
#else
  if (lseek(file, 0, SEEK_SET) < 0) return -1;
  size_t size = 0;
  while (size < capacity) {
    ssize_t n = read(file, bytes + size, capacity - size);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) return -1;
    if (!n) break;
    size += (size_t)n;
  }
  return (int)size;
#endif
}

static int owner_write(owner_file file, const char *bytes, size_t size) {
#ifdef _WIN32
  LARGE_INTEGER zero; zero.QuadPart = 0;
  return SetFilePointerEx(file, zero, NULL, FILE_BEGIN) && SetEndOfFile(file) &&
    write_all(file, bytes, (DWORD)size) && FlushFileBuffers(file) ? 0 : -1;
#else
  return lseek(file, 0, SEEK_SET) < 0 || ftruncate(file, 0) < 0 ||
    write_all(file, bytes, size) < 0 || fsync(file) < 0 ? -1 : 0;
#endif
}

/* Local filesystems only: a reboot of this host says nothing about writers
 * on another machine. No symlinks/reparse points, hardlinks or special files. */
static owner_file owner_open_mode(const owner_path_char *directory, const char *name, int create, int readonly) {
#ifdef _WIN32
  wchar_t volume[MAX_PATH], filename[32768];
  if (!GetVolumePathNameW(directory, volume, MAX_PATH)) return OWNER_BAD;
  UINT type = GetDriveTypeW(volume);
  if (type != DRIVE_FIXED && type != DRIVE_REMOVABLE && type != DRIVE_RAMDISK) return OWNER_BAD;
  HANDLE dir = CreateFileW(directory, FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  BY_HANDLE_FILE_INFORMATION info;
  if (dir == INVALID_HANDLE_VALUE) return OWNER_BAD;
  int safe = GetFileInformationByHandle(dir, &info) &&
    (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT);
  CloseHandle(dir);
  if (!safe || swprintf(filename, 32768, L"%ls\\%hs", directory, name) < 0) return OWNER_BAD;
  HANDLE file = CreateFileW(filename, readonly ? GENERIC_READ : GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ,
    NULL, create ? OPEN_ALWAYS : OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, NULL);
  if (file == INVALID_HANDLE_VALUE) return OWNER_BAD;
  if (!GetFileInformationByHandle(file, &info) || info.nNumberOfLinks != 1 ||
      (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) {
    CloseHandle(file); return OWNER_BAD;
  }
  return file;
#else
  int dir = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (dir < 0) return OWNER_BAD;
  struct statfs filesystem = {0};
  int local = fstatfs(dir, &filesystem) == 0;
#ifdef __APPLE__
  local = local && (filesystem.f_flags & MNT_LOCAL);
#else
  /* ext2/3/4, XFS, Btrfs, tmpfs, overlay, F2FS, ZFS, eCryptfs (Ubuntu's
   * encrypted home), bcachefs, JFS, ReiserFS, NILFS2 (linux/magic.h, statfs(2)).
   * Unknown/remote filesystems retain the existing ownership block rather
   * than assuming locality. */
  unsigned long type = (unsigned long)filesystem.f_type;
  local = local && (type == 0xef53 || type == 0x58465342 || type == 0x9123683e ||
    type == 0x01021994 || type == 0x794c7630 || type == 0xf2f52010 || type == 0x2fc12fc1 ||
    type == 0xf15f || type == 0xca451a4e || type == 0x3153464a || type == 0x52654973 ||
    type == 0x3434);
#endif
  if (!local) { close(dir); return OWNER_BAD; }
  int file = openat(dir, name, (readonly ? O_RDONLY : O_RDWR) | O_NOFOLLOW | O_NONBLOCK | (create ? O_CREAT : 0), 0600);
  struct stat info;
  if (file < 0 || fstat(file, &info) < 0 || !S_ISREG(info.st_mode) || info.st_nlink != 1 ||
      info.st_uid != geteuid() || flock(file, LOCK_EX | LOCK_NB) < 0 || (create && fsync(dir) < 0)) {
    if (file >= 0) close(file);
    close(dir); return OWNER_BAD;
  }
  close(dir);
  return file;
#endif
}

static owner_file owner_open(const owner_path_char *directory, const char *name, int create) {
  return owner_open_mode(directory, name, create, 0);
}

static int boot_identity(char host[64], char boot[64]) {
  memset(host, 0, 64); memset(boot, 0, 64);
#ifdef _WIN32
  char machine[40] = {0}; DWORD size = sizeof(machine);
  if (RegGetValueA(HKEY_LOCAL_MACHINE, "SOFTWARE\\Microsoft\\Cryptography", "MachineGuid",
      RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY, NULL, machine, &size) != ERROR_SUCCESS ||
      size < 37 || size > sizeof(machine)) return -1;
  for (size_t i = 0; i < strlen(machine); i++) if (machine[i] >= 'A' && machine[i] <= 'F') machine[i] += 'a' - 'A';
  if (!valid_generation(machine)) return -1;
  /* PID 4's creation time is fixed for the lifetime of this kernel. Unlike
   * wall-clock minus uptime, adjusting the clock cannot change this value.
   * Querying the process table works without opening the protected process. */
  typedef NTSTATUS (NTAPI *query_system_fn)(SYSTEM_INFORMATION_CLASS, PVOID, ULONG, PULONG);
  FARPROC address = GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQuerySystemInformation");
  query_system_fn query; memcpy(&query, &address, sizeof(query));
  if (!query) return -1;
  /* The process table grows with process *and* thread count (~12k threads
   * already exceed 1 MiB). Retry on STATUS_INFO_LENGTH_MISMATCH with the
   * reported size plus headroom for processes started in between. Every
   * allocation, headroom included, is capped at 256 MiB so a hostile/odd
   * answer cannot drive an unbounded allocation. */
  const ULONG max_capacity = 256u * 1024 * 1024;
  ULONG capacity = 1024 * 1024, used = 0;
  unsigned char *buffer = NULL;
  NTSTATUS status = (NTSTATUS)0xC0000004L;
  for (int attempt = 0; attempt < 8 && status == (NTSTATUS)0xC0000004L; attempt++) {
    free(buffer);
    buffer = (unsigned char *)malloc(capacity);
    if (!buffer) return -1;
    used = 0;
    status = query(SystemProcessInformation, buffer, capacity, &used);
    if (status == (NTSTATUS)0xC0000004L) {
      ULONG wanted = used > capacity ? used : capacity;
      if (wanted >= max_capacity) { free(buffer); return -1; }
      ULONG headroom = wanted / 4 + 64 * 1024;
      capacity = headroom > max_capacity - wanted ? max_capacity : wanted + headroom;
    }
  }
  if (status < 0 || used > capacity) { free(buffer); return -1; }
  ULONGLONG created = 0;
  /* SYSTEM_PROCESS_INFORMATION's public Reserved1 contains the three times:
   * CreateTime is at offset 32 in the native x64/ARM64 layout. */
  for (ULONG offset = 0; offset + sizeof(SYSTEM_PROCESS_INFORMATION) <= used;) {
    SYSTEM_PROCESS_INFORMATION *entry = (SYSTEM_PROCESS_INFORMATION *)(buffer + offset);
    if ((ULONG_PTR)entry->UniqueProcessId == 4) {
      memcpy(&created, buffer + offset + 32, sizeof(created)); break;
    }
    if (!entry->NextEntryOffset || entry->NextEntryOffset > used - offset ||
        entry->NextEntryOffset < sizeof(SYSTEM_PROCESS_INFORMATION)) break;
    offset += entry->NextEntryOffset;
  }
  free(buffer);
  if (!created) return -1;
  snprintf(host, 64, "windows:%s", machine);
  snprintf(boot, 64, "%016llx", (unsigned long long)created);
  return 0;
#elif defined(__APPLE__)
  uuid_t machine; struct timespec wait = {1, 0}; char text[37];
  size_t size = 64;
  if (gethostuuid(machine, &wait) != 0 || sysctlbyname("kern.bootsessionuuid", boot, &size, NULL, 0) != 0) return -1;
  uuid_unparse_lower(machine, text);
  snprintf(host, 64, "macos:%s", text);
  for (size_t i = 0; i < strlen(boot); i++) if (boot[i] >= 'A' && boot[i] <= 'F') boot[i] += 'a' - 'A';
  return valid_generation(boot) ? 0 : -1;
#else
  char machine[34] = {0};
  int fd = open("/etc/machine-id", O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return -1;
  ssize_t size = read(fd, machine, sizeof(machine)); close(fd);
  if (size != 33 || machine[32] != '\n') return -1;
  for (int i = 0; i < 32; i++) if (!((machine[i] >= '0' && machine[i] <= '9') ||
      (machine[i] >= 'a' && machine[i] <= 'f'))) return -1;
  machine[32] = 0;
  fd = open("/proc/sys/kernel/random/boot_id", O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return -1;
  size = read(fd, boot, 63); close(fd);
  if (size != 37 || boot[36] != '\n') return -1;
  boot[36] = 0;
  snprintf(host, 64, "linux:%s", machine);
  return valid_generation(boot) ? 0 : -1;
#endif
}

static int owner_terminal(const char *bytes, int size, const char *state) {
  char prefix[32]; int start = snprintf(prefix, sizeof(prefix), "v1 %s ", state);
  if (size != start + 37 || memcmp(bytes, prefix, (size_t)start) || bytes[size - 1] != '\n') return 0;
  char generation[37]; memcpy(generation, bytes + start, 36); generation[36] = 0;
  return valid_generation(generation);
}

static int valid_boot_key(const char boot[64]) {
  const char *end = (const char *)memchr(boot, 0, 64);
  if (!end) return 0;
  for (const char *tail = end; tail < boot + 64; tail++) if (*tail) return 0;
#ifdef _WIN32
  if (strlen(boot) != 16) return 0;
  for (int i = 0; i < 16; i++) if (!((boot[i] >= '0' && boot[i] <= '9') ||
      (boot[i] >= 'a' && boot[i] <= 'f'))) return 0;
  return strcmp(boot, "0000000000000000") != 0;
#else
  return valid_generation(boot);
#endif
}

static int owner_stamp(const owner_path_char *directory, const char *prior, int size) {
  char proof[OWNER_PROOF_SIZE + OWNER_BYTES_MAX] = "FBBOOT1";
  if (size < 0 || size > OWNER_BYTES_MAX || boot_identity(proof + 8, proof + 72) < 0) return -1;
  memcpy(proof + OWNER_PROOF_SIZE, prior, (size_t)size);
  owner_file file = owner_open(directory, OWNER_WITNESS, 1);
  if (file == OWNER_BAD) return -1;
  int result = owner_write(file, proof, OWNER_PROOF_SIZE + (size_t)size);
  owner_close(file); return result;
}

/* Exit codes are a bounded protocol, not error strings or paths. 10 means a
 * witness was recorded and a restart of the computer is required. 11 means
 * the old data must be preserved and a fresh generation created. */
static int recover_owner(const owner_path_char *directory, const char *generation) {
  owner_file owner = owner_open(directory, ".freedom-myotis-owner", 0);
  if (owner == OWNER_BAD) return 12;
  char prior[OWNER_BYTES_MAX + 1]; int size = owner_read(owner, prior, sizeof(prior));
  int result = 12;
  if (size < 0 || size > OWNER_BYTES_MAX) goto done;
  if (owner_terminal(prior, size, "retired")) { result = 0; goto done; }
  if (owner_terminal(prior, size, "rebooted")) { result = 11; goto done; }
  if (owner_terminal(prior, size, "orphaned")) { result = 11; goto done; }
  if (owner_terminal(prior, size, "leased")) {
    /* New supervisors acquire this lease BEFORE publishing 'leased' and
     * creating a child. Both retain it until exit, including across exec.
     * The child inherits only a read handle, never the owner receipt writer.
     * Holding BOTH locks therefore proves no old process can still write.
     * Do not create a missing lease, or turn a busy lease into reboot advice. */
    owner_file lifetime = owner_open(directory, OWNER_LIFETIME, 0);
    if (lifetime == OWNER_BAD) goto done;
    if (record(owner, "orphaned", generation) == 0) result = 11;
    owner_close(lifetime);
    goto done;
  }
  char host[64], boot[64];
  if (boot_identity(host, boot) < 0) goto done;
  char proof[OWNER_PROOF_SIZE + OWNER_BYTES_MAX + 1] = {0};
  owner_file witness = owner_open(directory, OWNER_WITNESS, 0);
  int count = -1;
  if (witness != OWNER_BAD) { count = owner_read(witness, proof, sizeof(proof)); owner_close(witness); }
  if (count == OWNER_PROOF_SIZE + size && !memcmp(proof, "FBBOOT1\0", 8) && valid_boot_key(proof + 72) &&
      !memcmp(proof + OWNER_PROOF_SIZE, prior, (size_t)size)) {
    if (memcmp(proof + 8, host, 64)) goto done;
    if (memcmp(proof + 72, boot, 64)) {
      /* Keep the original bytes in the witness; never call this a normal
       * retirement or permit resuming potentially half-written snapshots. */
      if (record(owner, "rebooted", generation) == 0) result = 11;
      goto done;
    }
    result = 10; goto done;
  }
  if (owner_stamp(directory, prior, size) == 0) result = 10;
done:
  owner_close(owner); return result;
}
