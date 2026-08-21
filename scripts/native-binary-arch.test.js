const { isHostNativeBinary, machoArchs, elfArch, peArch } = require('./native-binary-arch');

// Mach-O constants (mirrored from native-binary-arch.js)
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

const EM_X86_64 = 62;
const EM_AARCH64 = 183;

const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;

// --- Synthetic binary headers -------------------------------------------

function machoThin(cpuType) {
  const buf = Buffer.alloc(32);
  buf.writeUInt32LE(MH_MAGIC_64, 0);
  buf.writeUInt32LE(cpuType, 4);
  return buf;
}

function machoFat(cpuTypes, { fat64 = false } = {}) {
  const entrySize = fat64 ? 32 : 20; // fat_arch_64 vs fat_arch
  const buf = Buffer.alloc(8 + cpuTypes.length * entrySize);
  buf.writeUInt32BE(fat64 ? FAT_MAGIC_64 : FAT_MAGIC, 0);
  buf.writeUInt32BE(cpuTypes.length, 4);
  cpuTypes.forEach((cpuType, i) => buf.writeUInt32BE(cpuType, 8 + i * entrySize));
  return buf;
}

function elf(machine, { bigEndian = false } = {}) {
  const buf = Buffer.alloc(64);
  buf.write('\x7fELF', 0, 'latin1');
  buf[4] = 2; // ELFCLASS64
  buf[5] = bigEndian ? 2 : 1; // EI_DATA
  if (bigEndian) buf.writeUInt16BE(machine, 18);
  else buf.writeUInt16LE(machine, 18);
  return buf;
}

function pe(machine) {
  const buf = Buffer.alloc(0x100);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(0x80, 0x3c); // e_lfanew
  buf.write('PE\0\0', 0x80, 'latin1');
  buf.writeUInt16LE(machine, 0x84);
  return buf;
}

// --- isHostNativeBinary: the guard build.js uses -------------------------

describe('isHostNativeBinary (darwin)', () => {
  test('keeps a thin Mach-O matching the host arch', () => {
    expect(isHostNativeBinary(machoThin(CPU_TYPE_ARM64), 'darwin', 'arm64')).toBe(true);
    expect(isHostNativeBinary(machoThin(CPU_TYPE_X86_64), 'darwin', 'x64')).toBe(true);
  });

  test('rejects a thin Mach-O for the other arch (restored)', () => {
    expect(isHostNativeBinary(machoThin(CPU_TYPE_X86_64), 'darwin', 'arm64')).toBe(false);
    expect(isHostNativeBinary(machoThin(CPU_TYPE_ARM64), 'darwin', 'x64')).toBe(false);
  });

  test('keeps a fat binary containing the host arch', () => {
    const universal = machoFat([CPU_TYPE_X86_64, CPU_TYPE_ARM64]);
    expect(isHostNativeBinary(universal, 'darwin', 'arm64')).toBe(true);
    expect(isHostNativeBinary(universal, 'darwin', 'x64')).toBe(true);
  });

  test('rejects a fat binary without the host arch (restored)', () => {
    const x64Only = machoFat([CPU_TYPE_X86_64]);
    expect(isHostNativeBinary(x64Only, 'darwin', 'arm64')).toBe(false);
    const arm64Only = machoFat([CPU_TYPE_ARM64]);
    expect(isHostNativeBinary(arm64Only, 'darwin', 'x64')).toBe(false);
  });

  test('handles 64-bit fat headers (FAT_MAGIC_64)', () => {
    const universal = machoFat([CPU_TYPE_X86_64, CPU_TYPE_ARM64], { fat64: true });
    expect(isHostNativeBinary(universal, 'darwin', 'arm64')).toBe(true);
    const x64Only = machoFat([CPU_TYPE_X86_64], { fat64: true });
    expect(isHostNativeBinary(x64Only, 'darwin', 'arm64')).toBe(false);
  });

  test('rejects non-Mach-O formats on darwin', () => {
    expect(isHostNativeBinary(elf(EM_AARCH64), 'darwin', 'arm64')).toBe(false);
    expect(isHostNativeBinary(pe(IMAGE_FILE_MACHINE_ARM64), 'darwin', 'arm64')).toBe(false);
  });
});

describe('isHostNativeBinary (linux)', () => {
  test('keeps an ELF matching the host arch', () => {
    expect(isHostNativeBinary(elf(EM_AARCH64), 'linux', 'arm64')).toBe(true);
    expect(isHostNativeBinary(elf(EM_X86_64), 'linux', 'x64')).toBe(true);
  });

  test('rejects an ELF for the other arch (restored)', () => {
    expect(isHostNativeBinary(elf(EM_X86_64), 'linux', 'arm64')).toBe(false);
    expect(isHostNativeBinary(elf(EM_AARCH64), 'linux', 'x64')).toBe(false);
  });

  test('rejects non-ELF formats on linux', () => {
    expect(isHostNativeBinary(machoThin(CPU_TYPE_X86_64), 'linux', 'x64')).toBe(false);
    expect(isHostNativeBinary(pe(IMAGE_FILE_MACHINE_AMD64), 'linux', 'x64')).toBe(false);
  });
});

describe('isHostNativeBinary (win32)', () => {
  test('keeps a PE matching the host arch', () => {
    expect(isHostNativeBinary(pe(IMAGE_FILE_MACHINE_AMD64), 'win32', 'x64')).toBe(true);
    expect(isHostNativeBinary(pe(IMAGE_FILE_MACHINE_ARM64), 'win32', 'arm64')).toBe(true);
  });

  test('rejects a PE for the other arch (restored)', () => {
    expect(isHostNativeBinary(pe(IMAGE_FILE_MACHINE_ARM64), 'win32', 'x64')).toBe(false);
    expect(isHostNativeBinary(pe(IMAGE_FILE_MACHINE_AMD64), 'win32', 'arm64')).toBe(false);
  });

  test('rejects non-PE formats on win32', () => {
    expect(isHostNativeBinary(elf(EM_X86_64), 'win32', 'x64')).toBe(false);
  });
});

describe('isHostNativeBinary (edge cases)', () => {
  test('rejects null, empty, and truncated buffers', () => {
    expect(isHostNativeBinary(null, 'darwin', 'arm64')).toBe(false);
    expect(isHostNativeBinary(Buffer.alloc(0), 'darwin', 'arm64')).toBe(false);
    expect(isHostNativeBinary(Buffer.from([0xcf]), 'darwin', 'arm64')).toBe(false);
    // Fat header that claims more entries than the buffer holds
    const truncated = machoFat([CPU_TYPE_ARM64]).subarray(0, 10);
    expect(isHostNativeBinary(truncated, 'darwin', 'arm64')).toBe(false);
  });

  test('rejects arbitrary non-binary content', () => {
    expect(isHostNativeBinary(Buffer.from('not a binary at all'), 'darwin', 'arm64')).toBe(false);
    expect(isHostNativeBinary(Buffer.from('not a binary at all'), 'linux', 'x64')).toBe(false);
    expect(isHostNativeBinary(Buffer.from('not a binary at all'), 'win32', 'x64')).toBe(false);
  });

  test('rejects unrecognized platforms even with a valid binary', () => {
    expect(isHostNativeBinary(pe(IMAGE_FILE_MACHINE_ARM64), 'freebsd', 'arm64')).toBe(false);
    expect(isHostNativeBinary(machoThin(CPU_TYPE_ARM64), 'aix', 'arm64')).toBe(false);
  });
});

// --- Lower-level parsers --------------------------------------------------

describe('machoArchs', () => {
  test('lists every slice of a universal binary once', () => {
    expect(machoArchs(machoFat([CPU_TYPE_X86_64, CPU_TYPE_ARM64]))).toEqual(['x64', 'arm64']);
  });

  test('ignores unknown CPU types', () => {
    const CPU_TYPE_POWERPC = 0x12;
    expect(machoArchs(machoFat([CPU_TYPE_POWERPC, CPU_TYPE_ARM64]))).toEqual(['arm64']);
    expect(machoArchs(machoThin(CPU_TYPE_POWERPC))).toEqual([]);
  });
});

describe('elfArch', () => {
  test('parses e_machine in both byte orders', () => {
    expect(elfArch(elf(EM_AARCH64))).toBe('arm64');
    expect(elfArch(elf(EM_X86_64, { bigEndian: true }))).toBe('x64');
  });

  test('returns null for unknown machines', () => {
    expect(elfArch(elf(0x28 /* EM_ARM (32-bit) */))).toBeNull();
  });
});

describe('peArch', () => {
  test('returns null when the PE signature is missing or out of range', () => {
    const noSig = pe(IMAGE_FILE_MACHINE_AMD64);
    noSig.write('XX\0\0', 0x80, 'latin1');
    expect(peArch(noSig)).toBeNull();

    const badOffset = pe(IMAGE_FILE_MACHINE_AMD64);
    badOffset.writeUInt32LE(0xffff, 0x3c);
    expect(peArch(badOffset)).toBeNull();
  });

  test('returns null for 32-bit x86', () => {
    expect(peArch(pe(0x014c /* IMAGE_FILE_MACHINE_I386 */))).toBeNull();
  });
});
