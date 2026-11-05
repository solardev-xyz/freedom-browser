// Benign marker DLL for #779: records that it was loaded, then forwards
// every call to the real System32 fwpuclnt.dll so the host process is unaffected.
#include <windows.h>
#include <stdio.h>
typedef ULONG_PTR (WINAPI *fn8)(void*,void*,void*,void*,void*,void*,void*,void*);
static HMODULE real, self_module;
static FARPROC get(const char *n) {
  if (!real) { wchar_t p[MAX_PATH]; GetSystemDirectoryW(p, MAX_PATH); lstrcatW(p, L"\\fwpuclnt.dll"); real = LoadLibraryW(p); }
  FARPROC f = real ? GetProcAddress(real, n) : NULL;
  HMODULE owner = NULL;
  GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, (LPCWSTR)f, &owner);
  return f && owner != self_module ? f : NULL;
}
BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID r) {
  if (reason == DLL_PROCESS_ATTACH) {
    self_module = h;
    wchar_t exe[MAX_PATH] = L"?", self[MAX_PATH] = L"?";
    GetModuleFileNameW(NULL, exe, MAX_PATH);
    GetModuleFileNameW(h, self, MAX_PATH);
    HANDLE token; DWORD elevated = 0, size;
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
      TOKEN_ELEVATION e; if (GetTokenInformation(token, TokenElevation, &e, sizeof e, &size)) elevated = e.TokenIsElevated;
      CloseHandle(token);
    }
    wchar_t user[256] = L"?"; DWORD n = 256; GetEnvironmentVariableW(L"USERNAME", user, n);
    SYSTEMTIME t; GetSystemTime(&t);
    FILE *f = _wfopen(L"C:\\ProgramData\\freedom-dll-plant\\markers.log", L"a");
    if (f) { fwprintf(f, L"%04d-%02d-%02dT%02d:%02d:%02dZ planted=fwpuclnt.dll loaded pid=%lu elevated=%lu user=%ls self=%ls exe=%ls\n",
      t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, GetCurrentProcessId(), elevated, user, self, exe); fclose(f); }
  }
  return TRUE;
}
__declspec(dllexport) ULONG_PTR WINAPI FwpmSubLayerAdd0(void*a,void*b,void*c,void*d,void*e,void*f,void*g,void*h) { fn8 p = (fn8)get("FwpmSubLayerAdd0"); return p ? p(a,b,c,d,e,f,g,h) : 1; }
__declspec(dllexport) ULONG_PTR WINAPI FwpmTransactionAbort0(void*a,void*b,void*c,void*d,void*e,void*f,void*g,void*h) { fn8 p = (fn8)get("FwpmTransactionAbort0"); return p ? p(a,b,c,d,e,f,g,h) : 1; }
__declspec(dllexport) ULONG_PTR WINAPI FwpmEngineClose0(void*a,void*b,void*c,void*d,void*e,void*f,void*g,void*h) { fn8 p = (fn8)get("FwpmEngineClose0"); return p ? p(a,b,c,d,e,f,g,h) : 1; }
__declspec(dllexport) ULONG_PTR WINAPI FwpmTransactionCommit0(void*a,void*b,void*c,void*d,void*e,void*f,void*g,void*h) { fn8 p = (fn8)get("FwpmTransactionCommit0"); return p ? p(a,b,c,d,e,f,g,h) : 1; }
__declspec(dllexport) ULONG_PTR WINAPI FwpmProviderAdd0(void*a,void*b,void*c,void*d,void*e,void*f,void*g,void*h) { fn8 p = (fn8)get("FwpmProviderAdd0"); return p ? p(a,b,c,d,e,f,g,h) : 1; }
__declspec(dllexport) ULONG_PTR WINAPI FwpmTransactionBegin0(void*a,void*b,void*c,void*d,void*e,void*f,void*g,void*h) { fn8 p = (fn8)get("FwpmTransactionBegin0"); return p ? p(a,b,c,d,e,f,g,h) : 1; }
__declspec(dllexport) ULONG_PTR WINAPI FwpmFilterDeleteByKey0(void*a,void*b,void*c,void*d,void*e,void*f,void*g,void*h) { fn8 p = (fn8)get("FwpmFilterDeleteByKey0"); return p ? p(a,b,c,d,e,f,g,h) : 1; }
__declspec(dllexport) ULONG_PTR WINAPI FwpmFilterAdd0(void*a,void*b,void*c,void*d,void*e,void*f,void*g,void*h) { fn8 p = (fn8)get("FwpmFilterAdd0"); return p ? p(a,b,c,d,e,f,g,h) : 1; }
__declspec(dllexport) ULONG_PTR WINAPI FwpmEngineOpen0(void*a,void*b,void*c,void*d,void*e,void*f,void*g,void*h) { fn8 p = (fn8)get("FwpmEngineOpen0"); return p ? p(a,b,c,d,e,f,g,h) : 1; }
