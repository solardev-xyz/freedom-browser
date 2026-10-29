'use strict';

const {
  ARCHITECTURES,
  SECCOMP_RET_ALLOW,
  SECCOMP_RET_ERRNO,
  SECCOMP_RET_KILL_PROCESS,
  buildUnixSocketSeccompFilter,
  evaluateSeccompFilter,
  unixSocketFilterInstructions,
} = require('./linux-seccomp-filter');

const EACCES = SECCOMP_RET_ERRNO | 13;
const ENOSYS = SECCOMP_RET_ERRNO | 38;
const AF_UNIX = 1;
const AF_INET = 2;
const AF_INET6 = 10;
const AF_NETLINK = 16;
const SOCK_STREAM = 1;
const SOCK_DGRAM = 2;
const SOCK_RAW = 3;
const SOCK_SEQPACKET = 5;
const SOCK_NONBLOCK = 0o4000;
const SOCK_CLOEXEC = 0o2000000;
const AUDIT_ARCH_I386 = 0x4000_0003;
const AUDIT_ARCH_ARM = 0x4000_0028;

// Syscall numbers that must stay ordinary allows, per architecture.
const ORDINARY = {
  x64: {
    read: 0,
    write: 1,
    connect: 42,
    sendto: 44,
    sendmsg: 46,
    bind: 49,
    execve: 59,
    exit_group: 231,
  },
  arm64: {
    read: 63,
    write: 64,
    connect: 203,
    sendto: 206,
    sendmsg: 211,
    bind: 200,
    execve: 221,
    exit_group: 94,
  },
};

describe.each(Object.keys(ARCHITECTURES))('Unix-socket seccomp filter for %s', (architecture) => {
  const { auditArch, syscalls } = ARCHITECTURES[architecture];
  const filter = buildUnixSocketSeccompFilter(architecture);
  const run = (nr, args = [], arch = auditArch) =>
    evaluateSeccompFilter(filter, { nr, arch, args });

  test('serializes whole little-endian sock_filter records', () => {
    const instructions = unixSocketFilterInstructions(architecture);
    expect(filter).toHaveLength(instructions.length * 8);
    instructions.forEach((instruction, index) => {
      expect(filter.readUInt16LE(index * 8)).toBe(instruction.code);
      expect(filter.readUInt32LE(index * 8 + 4)).toBe(instruction.k >>> 0);
    });
    // The first check is the architecture: nothing else is decided for a foreign ABI.
    expect(filter.readUInt16LE(0)).toBe(0x20);
    expect(filter.readUInt32LE(4)).toBe(4);
    expect(filter.readUInt32LE(12)).toBe(auditArch >>> 0);
  });

  test('refuses Unix socket creation in every type and flag combination', () => {
    for (const type of [SOCK_STREAM, SOCK_DGRAM, SOCK_RAW, SOCK_SEQPACKET]) {
      for (const flags of [0, SOCK_NONBLOCK, SOCK_CLOEXEC, SOCK_NONBLOCK | SOCK_CLOEXEC]) {
        expect(run(syscalls.socket, [AF_UNIX, type | flags, 0])).toBe(EACCES);
      }
    }
  });

  test('keeps IP, IPv6 and netlink sockets', () => {
    for (const domain of [AF_INET, AF_INET6, AF_NETLINK]) {
      for (const type of [SOCK_STREAM, SOCK_DGRAM | SOCK_CLOEXEC]) {
        expect(run(syscalls.socket, [domain, type, 0])).toBe(SECCOMP_RET_ALLOW);
      }
    }
  });

  test('keeps connected stream and seqpacket socketpairs but refuses re-addressable datagram pairs', () => {
    for (const flags of [0, SOCK_NONBLOCK | SOCK_CLOEXEC]) {
      expect(run(syscalls.socketpair, [AF_UNIX, SOCK_STREAM | flags, 0])).toBe(SECCOMP_RET_ALLOW);
      expect(run(syscalls.socketpair, [AF_UNIX, SOCK_SEQPACKET | flags, 0])).toBe(
        SECCOMP_RET_ALLOW
      );
      expect(run(syscalls.socketpair, [AF_UNIX, SOCK_DGRAM | flags, 0])).toBe(EACCES);
      // AF_UNIX treats SOCK_RAW as SOCK_DGRAM.
      expect(run(syscalls.socketpair, [AF_UNIX, SOCK_RAW | flags, 0])).toBe(EACCES);
    }
    expect(run(syscalls.socketpair, [AF_UNIX, 0xe, 0])).toBe(EACCES);
    // Other families get the kernel's own answer.
    expect(run(syscalls.socketpair, [AF_INET, SOCK_DGRAM, 0])).toBe(SECCOMP_RET_ALLOW);
  });

  test('refuses io_uring, which can create and connect sockets without a filtered syscall', () => {
    expect(run(syscalls.io_uring_setup, [8, 0])).toBe(ENOSYS);
    expect(run(syscalls.io_uring_enter)).toBe(ENOSYS);
    expect(run(syscalls.io_uring_register)).toBe(ENOSYS);
  });

  test('allows ordinary syscalls, including connect/sendto/sendmsg on sockets that pass the creation check', () => {
    for (const nr of Object.values(ORDINARY[architecture])) {
      expect(run(nr, [AF_UNIX, SOCK_STREAM, 0])).toBe(SECCOMP_RET_ALLOW);
    }
  });

  test('kills a process that enters through a foreign syscall ABI', () => {
    for (const foreign of [
      AUDIT_ARCH_I386,
      AUDIT_ARCH_ARM,
      ...Object.values(ARCHITECTURES)
        .map((entry) => entry.auditArch)
        .filter((value) => value !== auditArch),
    ]) {
      // i386 socket() is 359 and socketcall() 102; neither is inspectable here.
      for (const nr of [102, 359, syscalls.socket, 0]) {
        expect(run(nr, [AF_UNIX, SOCK_STREAM, 0], foreign)).toBe(SECCOMP_RET_KILL_PROCESS);
      }
    }
  });
});

test('x64 also kills x32-ABI syscalls, whose numbers alias the native table', () => {
  const filter = buildUnixSocketSeccompFilter('x64');
  const x32 = 0x4000_0000;
  for (const nr of [x32 + 41, x32 + 42, x32 + 0]) {
    expect(
      evaluateSeccompFilter(filter, { nr, arch: ARCHITECTURES.x64.auditArch, args: [AF_UNIX] })
    ).toBe(SECCOMP_RET_KILL_PROCESS);
  }
});

test('the architecture-specific socket numbers differ, so each filter only fits its own ABI', () => {
  expect(ARCHITECTURES.x64.syscalls.socket).toBe(41);
  expect(ARCHITECTURES.arm64.syscalls.socket).toBe(198);
  expect(buildUnixSocketSeccompFilter('x64').equals(buildUnixSocketSeccompFilter('arm64'))).toBe(
    false
  );
  // arm64's socket number is an unrelated syscall on x64 and must not be refused there.
  expect(
    evaluateSeccompFilter(buildUnixSocketSeccompFilter('x64'), {
      nr: 198,
      arch: ARCHITECTURES.x64.auditArch,
      args: [AF_UNIX],
    })
  ).toBe(SECCOMP_RET_ALLOW);
  expect(
    evaluateSeccompFilter(buildUnixSocketSeccompFilter('arm64'), {
      nr: 198,
      arch: ARCHITECTURES.arm64.auditArch,
      args: [AF_UNIX],
    })
  ).toBe(EACCES);
});

test.each(['ia32', 'arm', 'armv7l', 'riscv64', 'universal', undefined, 'constructor'])(
  'refuses to guess a filter for unsupported architecture %s',
  (architecture) => {
    expect(() => buildUnixSocketSeccompFilter(architecture ?? 'missing')).toThrow(
      expect.objectContaining({ code: 'SECCOMP_ARCHITECTURE_UNSUPPORTED' })
    );
  }
);

test('the reference interpreter rejects malformed programs instead of allowing', () => {
  expect(() => evaluateSeccompFilter(Buffer.alloc(7), { nr: 0, arch: 0 })).toThrow();
  const unknownOpcode = Buffer.alloc(8);
  unknownOpcode.writeUInt16LE(0xff, 0);
  expect(() => evaluateSeccompFilter(unknownOpcode, { nr: 0, arch: 0 })).toThrow();
  const noReturn = Buffer.alloc(8);
  noReturn.writeUInt16LE(0x20, 0);
  expect(() => evaluateSeccompFilter(noReturn, { nr: 0, arch: 0 })).toThrow(/fell off/);
});
