/* Windows counterpart: retained process HANDLE, mandatory job assignment at
 * creation, explicit inherited handle list, native terminal receipt. Runtime
 * qualification of the shipped Electron/CRT IPC mapping is still required.
 */
#define _CRT_SECURE_NO_WARNINGS
#define _WIN32_WINNT 0x0A00
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <io.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

static int valid_generation(const char *s) {
  if (strlen(s) != 36) return 0;
  for (int i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (s[i] != '-') return 0; }
    else if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return 0;
  }
  return 1;
}

static int write_all(HANDLE target, const char *data, DWORD size) {
  while (size) {
    DWORD written = 0;
    if (!WriteFile(target, data, size, &written, NULL) || written == 0) return 0;
    data += written; size -= written;
  }
  return 1;
}

static int record(HANDLE owner, const char *state, const char *generation) {
  char data[96];
  int size = snprintf(data, sizeof(data), "v1 %s %s\n", state, generation);
  LARGE_INTEGER zero; zero.QuadPart = 0;
  return SetFilePointerEx(owner, zero, NULL, FILE_BEGIN) && SetEndOfFile(owner) &&
    write_all(owner, data, (DWORD)size) && FlushFileBuffers(owner);
}

static int revoked(HANDLE control) {
  DWORD available = 0;
  return !PeekNamedPipe(control, NULL, 0, NULL, &available, NULL) || available != 0;
}

int wmain(int argc, wchar_t **argv) {
  if (argc != 5 || wcslen(argv[3]) != 36 || wcslen(argv[1]) > 16000 ||
      wcslen(argv[2]) > 16000 || wcslen(argv[4]) > 32000) return 64;
  char generation[37];
  for (int i = 0; i <= 36; i++) {
    if (argv[3][i] > 127) return 64;
    generation[i] = (char)argv[3][i];
  }
  if (!valid_generation(generation)) return 64;
  const wchar_t *node_mode = _wgetenv(L"ELECTRON_RUN_AS_NODE");
  if (!node_mode || wcscmp(node_mode, L"1") != 0) return 64;
  const wchar_t *ipc_fd = _wgetenv(L"NODE_CHANNEL_FD");
  if (!ipc_fd || wcscmp(ipc_fd, L"3") != 0) return 64;
  HANDLE control = GetStdHandle(STD_INPUT_HANDLE);
  HANDLE report = GetStdHandle(STD_OUTPUT_HANDLE);
  if (revoked(control)) return 65;
  HANDLE directory = CreateFileW(argv[4], FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
    NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  BY_HANDLE_FILE_INFORMATION directory_info;
  if (directory == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(directory, &directory_info) ||
      !(directory_info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (directory_info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) return 66;
  wchar_t owner_path[32768];
  if (swprintf(owner_path, 32768, L"%ls\\.freedom-myotis-owner", argv[4]) < 0) return 66;
  /* Share-read only: no other writer or inode replacement while owned. */
  HANDLE owner = CreateFileW(owner_path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, NULL,
    CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, NULL);
  int fresh = owner != INVALID_HANDLE_VALUE;
  if (!fresh && GetLastError() == ERROR_FILE_EXISTS) {
    owner = CreateFileW(owner_path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, NULL,
      OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, NULL);
  }
  BY_HANDLE_FILE_INFORMATION info;
  if (owner == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(owner, &info) ||
      (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
      info.nNumberOfLinks != 1) return 66;
  if (!fresh) {
    char prior[96] = {0}; DWORD size = 0;
    if (!ReadFile(owner, prior, sizeof(prior), &size, NULL) || size != 48 ||
        memcmp(prior, "v1 retired ", 11) != 0 || prior[47] != '\n') return 67;
    prior[47] = 0;
    if (!valid_generation(prior + 11)) return 67;
  }
  if (!record(owner, "active", generation)) return 68;

  HANDLE job = CreateJobObjectW(NULL, NULL);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  memset(&limits, 0, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 69;
  SECURITY_ATTRIBUTES security = { sizeof(security), NULL, TRUE };
  HANDLE null_handle = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE,
    FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, NULL);
  HANDLE ipc = (HANDLE)_get_osfhandle(3);
  if (null_handle == INVALID_HANDLE_VALUE || ipc == INVALID_HANDLE_VALUE ||
      !SetHandleInformation(ipc, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) return 69;

  STARTUPINFOEXW startup;
  memset(&startup, 0, sizeof(startup));
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = null_handle;
  startup.StartupInfo.hStdOutput = null_handle;
  startup.StartupInfo.hStdError = null_handle;
  /* Node/libuv's CRT descriptor table: count, byte flags, HANDLEs. Only NUL
   * stdio and fd3 IPC are present. Control, receipt, owner and job are absent.
   */
  unsigned char descriptors[sizeof(int) + 4 + 4 * sizeof(HANDLE)];
  int count = 4;
  memcpy(descriptors, &count, sizeof(count));
  for (int i = 0; i < 4; i++) {
    descriptors[sizeof(int) + i] = (unsigned char)(i == 3 ? 0x09 : 0x41);
    HANDLE value = i == 3 ? ipc : null_handle;
    memcpy(descriptors + sizeof(int) + 4 + i * sizeof(HANDLE), &value, sizeof(value));
  }
  startup.StartupInfo.cbReserved2 = (WORD)sizeof(descriptors);
  startup.StartupInfo.lpReserved2 = descriptors;
  SIZE_T attribute_size = 0;
  InitializeProcThreadAttributeList(NULL, 2, 0, &attribute_size);
  startup.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)malloc(attribute_size);
  HANDLE inherited[] = { null_handle, ipc };
  if (!startup.lpAttributeList || !InitializeProcThreadAttributeList(startup.lpAttributeList, 2, 0, &attribute_size) ||
      !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        inherited, sizeof(inherited), NULL, NULL) ||
      !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
        &job, sizeof(job), NULL, NULL)) return 69;
  /* Paths cannot contain quotes on Windows; neither argument ends in a slash.
   * lpApplicationName selects the exact executable, with no PATH/shell search.
   */
  if (wcschr(argv[1], L'"') || wcschr(argv[2], L'"')) return 64;
  wchar_t command[32768];
  if (swprintf(command, 32768, L"\"%ls\" \"%ls\"", argv[1], argv[2]) < 0 || revoked(control)) return 65;
  PROCESS_INFORMATION child;
  memset(&child, 0, sizeof(child));
  if (!CreateProcessW(argv[1], command, NULL, NULL, TRUE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
      NULL, NULL, &startup.StartupInfo, &child)) return 69;
  /* Job assignment was atomic with creation. Even a supervisor crash here
   * closes the sole job handle; no unassigned suspended-child window exists.
   */
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  free(startup.lpAttributeList);
  _close(3);
  CloseHandle(null_handle);
  int terminate = revoked(control);
  if (!terminate && ResumeThread(child.hThread) == (DWORD)-1) terminate = 1;
  CloseHandle(child.hThread);
  char receipt[192];
  int length = snprintf(receipt, sizeof(receipt), "{\"type\":\"owned\",\"generation\":\"%s\"}\n", generation);
  if (!write_all(report, receipt, (DWORD)length)) terminate = 1;
  int forced = 0;
  for (;;) {
    DWORD state = WaitForSingleObject(child.hProcess, 0);
    if (state == WAIT_OBJECT_0) break;
    if (state != WAIT_TIMEOUT) return 70;
    if (terminate || revoked(control)) {
      if (TerminateProcess(child.hProcess, 1)) forced = 1;
      else if (WaitForSingleObject(child.hProcess, 0) != WAIT_OBJECT_0) return 71;
      if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0) return 72;
      break;
    }
    Sleep(100);
  }
  /* Signal authority ends before closing the retained kernel handle. */
  DWORD exit_code;
  if (!GetExitCodeProcess(child.hProcess, &exit_code)) return 72;
  CloseHandle(child.hProcess);
  if (!record(owner, "retired", generation)) return 73;
  length = snprintf(receipt, sizeof(receipt),
    "{\"type\":\"reaped\",\"generation\":\"%s\",\"exitCode\":%lu,\"signal\":0,\"forced\":%s}\n",
    generation, (unsigned long)exit_code, forced ? "true" : "false");
  if (!write_all(report, receipt, (DWORD)length)) return 74;
  CloseHandle(job);
  CloseHandle(owner);
  CloseHandle(directory);
  return 0;
}
