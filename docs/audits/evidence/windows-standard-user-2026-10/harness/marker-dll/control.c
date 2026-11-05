// Positive control for #779: an ordinary exe (no /DEPENDENTLOADFLAG) that
// statically imports netapi32 and fwpuclnt, so the loader's default search
// finds DLLs planted beside it first.
#include <windows.h>
#include <lm.h>
#include <fwpmu.h>
int main(int argc, char **argv) {
  NetApiBufferFree(NULL);
  if (argc > 5) { HANDLE e; FwpmEngineOpen0(NULL, RPC_C_AUTHN_DEFAULT, NULL, NULL, &e); }
  return 0;
}
