/**
 * Native addon (.node) header parsing for scripts/build.js.
 *
 * Detects whether a compiled native binary matches the host platform AND CPU
 * architecture by reading the actual file headers (Mach-O incl. fat/universal
 * slices, ELF, Windows PE). A format-only magic-byte check is not enough:
 * an x64 Mach-O produced by `--mac --x64` on an arm64 host is still Mach-O,
 * but useless to the host Electron.
 */

// Mach-O magics
const MH_MAGIC_64 = 0xfeedfacf; // thin 64-bit Mach-O
const FAT_MAGIC = 0xcafebabe; // universal binary (big-endian header)
const FAT_MAGIC_64 = 0xcafebabf; // universal binary, 64-bit fat_arch entries

// Mach-O CPU types (CPU_ARCH_ABI64 flag included)
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

// ELF e_machine values
const EM_X86_64 = 62;
const EM_AARCH64 = 183;

// PE/COFF machine values
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;

function machoCpuToNodeArch(cpuType) {
  if (cpuType === CPU_TYPE_X86_64) return 'x64';
  if (cpuType === CPU_TYPE_ARM64) return 'arm64';
  return null;
}

/**
 * Node-style architectures ('x64' / 'arm64') contained in a Mach-O buffer,
 * including every slice of a fat/universal binary. Empty array if the buffer
 * is not Mach-O or contains no recognized architecture.
 */
function machoArchs(buffer) {
  if (buffer.length < 8) return [];

  // Thin 64-bit Mach-O; the magic is stored in the file's own byte order.
  if (buffer.readUInt32LE(0) === MH_MAGIC_64) {
    const arch = machoCpuToNodeArch(buffer.readUInt32LE(4));
    return arch ? [arch] : [];
  }
  if (buffer.readUInt32BE(0) === MH_MAGIC_64) {
    const arch = machoCpuToNodeArch(buffer.readUInt32BE(4));
    return arch ? [arch] : [];
  }

  // Fat/universal binary: header and fat_arch entries are always big-endian.
  const magic = buffer.readUInt32BE(0);
  if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
    const entrySize = magic === FAT_MAGIC_64 ? 32 : 20; // fat_arch_64 vs fat_arch
    const count = buffer.readUInt32BE(4);
    const archs = [];
    for (let i = 0; i < count; i++) {
      const offset = 8 + i * entrySize;
      if (offset + 4 > buffer.length) break;
      const arch = machoCpuToNodeArch(buffer.readUInt32BE(offset));
      if (arch && !archs.includes(arch)) archs.push(arch);
    }
    return archs;
  }

  return [];
}

/** Node-style architecture of an ELF buffer, or null. */
function elfArch(buffer) {
  if (buffer.length < 20 || buffer.toString('latin1', 0, 4) !== '\x7fELF') return null;
  const machine = buffer[5] === 2 ? buffer.readUInt16BE(18) : buffer.readUInt16LE(18); // EI_DATA
  if (machine === EM_X86_64) return 'x64';
  if (machine === EM_AARCH64) return 'arm64';
  return null;
}

/** Node-style architecture of a Windows PE buffer, or null. */
function peArch(buffer) {
  if (buffer.length < 0x40 || buffer.toString('latin1', 0, 2) !== 'MZ') return null;
  const peOffset = buffer.readUInt32LE(0x3c); // e_lfanew
  if (peOffset + 6 > buffer.length) return null;
  if (buffer.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') return null;
  const machine = buffer.readUInt16LE(peOffset + 4);
  if (machine === IMAGE_FILE_MACHINE_AMD64) return 'x64';
  if (machine === IMAGE_FILE_MACHINE_ARM64) return 'arm64';
  return null;
}

/**
 * True when `buffer` is a native binary loadable on the given platform AND
 * CPU architecture (a fat Mach-O counts when any slice matches). Defaults to
 * the current host.
 */
function isHostNativeBinary(buffer, platform = process.platform, arch = process.arch) {
  if (!buffer || buffer.length < 4) return false;
  if (platform === 'darwin') return machoArchs(buffer).includes(arch);
  if (platform === 'linux') return elfArch(buffer) === arch;
  if (platform === 'win32') return peArch(buffer) === arch;
  return false;
}

module.exports = { isHostNativeBinary, machoArchs, elfArch, peArch };
