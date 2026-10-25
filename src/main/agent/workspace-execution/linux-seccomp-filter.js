'use strict';

// Classic-BPF seccomp program that Bubblewrap installs (`--seccomp FD`) on every
// sandboxed command and its descendants. It closes the host-IPC gap a
// read-only bind mount leaves open (#817): connect() on a pathname Unix socket
// only needs search permission on its directory, not write access to the
// mount, and the network namespace isolates only abstract and IP sockets.
//
// seccomp can read syscall registers but never the sockaddr a connect(),
// sendto() or sendmsg() points at, so the filter removes the endpoints those
// calls would need instead:
//
// - socket(AF_UNIX, ...) fails with EACCES, so no Unix socket can be created to
//   connect, bind, listen or address a datagram with;
// - socketpair(AF_UNIX, ...) stays available for SOCK_STREAM and
//   SOCK_SEQPACKET (libuv child-process stdio and fork() IPC and Python's
//   asyncio self-pipe use these). A connected stream/seqpacket socket refuses
//   a new peer (connect() is EISCONN, a sendmsg() address is EISCONN or
//   ignored).
//   Datagram socketpairs (and SOCK_RAW, which AF_UNIX treats as datagram) are
//   refused, because a datagram socket can be reconnected or addressed to any
//   pathname socket;
// - io_uring_setup/enter/register fail with ENOSYS, since io_uring can issue
//   IORING_OP_SOCKET/IORING_OP_CONNECT without passing through this filter;
// - a syscall from a foreign ABI (i386 compat or x32 on x64, AArch32 on arm64)
//   kills the process: those ABIs have different syscall numbers, and i386
//   multiplexes sockets through socketcall(), whose arguments live in memory.
//
// The cost: a command cannot run its own Unix-socket server either, even in
// /tmp. Python 3.14's default `forkserver` multiprocessing start method is one
// such user (it listens on an AF_UNIX socket); `fork` still works.
//
// Every other syscall is allowed; this is a host-IPC filter, not a general
// syscall allowlist. Bubblewrap applies it right before exec'ing the native
// entry gate, so the gate, the command and every descendant inherit it and
// none can remove it.

const SECCOMP_RET_KILL_PROCESS = 0x8000_0000;
const SECCOMP_RET_ERRNO = 0x0005_0000;
const SECCOMP_RET_ALLOW = 0x7fff_0000;
const EACCES = 13;
const ENOSYS = 38;
const AF_UNIX = 1;
const SOCK_STREAM = 1;
const SOCK_SEQPACKET = 5;
const SOCK_TYPE_MASK = 0xf;
const X32_SYSCALL_BIT = 0x4000_0000;

// BPF opcodes (linux/filter.h).
const BPF_LD_W_ABS = 0x20; // BPF_LD | BPF_W | BPF_ABS
const BPF_ALU_AND_K = 0x54; // BPF_ALU | BPF_AND | BPF_K
const BPF_JEQ_K = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
const BPF_JGE_K = 0x35; // BPF_JMP | BPF_JGE | BPF_K
const BPF_RET_K = 0x06; // BPF_RET | BPF_K

// struct seccomp_data offsets. Both supported architectures are little
// endian, so the low 32 bits of args[n] sit at 16 + 8n; the kernel truncates
// these int arguments to 32 bits itself.
const OFFSET_NR = 0;
const OFFSET_ARCH = 4;
const OFFSET_ARG0_LOW = 16;
const OFFSET_ARG1_LOW = 24;

const ARCHITECTURES = Object.freeze({
  x64: Object.freeze({
    auditArch: 0xc000_003e, // AUDIT_ARCH_X86_64
    rejectX32: true,
    syscalls: Object.freeze({
      socket: 41,
      socketpair: 53,
      io_uring_setup: 425,
      io_uring_enter: 426,
      io_uring_register: 427,
    }),
  }),
  arm64: Object.freeze({
    auditArch: 0xc000_00b7, // AUDIT_ARCH_AARCH64
    rejectX32: false,
    syscalls: Object.freeze({
      socket: 198,
      socketpair: 199,
      io_uring_setup: 425,
      io_uring_enter: 426,
      io_uring_register: 427,
    }),
  }),
});

class SeccompFilterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SeccompFilterError';
    this.code = code;
  }
}

function statement(code, k) {
  return { code, jt: 0, jf: 0, k };
}

// Labels are resolved after layout so the jump offsets can't drift when an
// instruction is added.
function jump(code, k, trueLabel, falseLabel) {
  return { code, k, trueLabel, falseLabel };
}

function assemble(program) {
  const labels = new Map();
  const instructions = [];
  for (const entry of program) {
    if (typeof entry === 'string') labels.set(entry, instructions.length);
    else instructions.push(entry);
  }
  const target = (label, index) => {
    if (label === undefined) return 0;
    if (!labels.has(label))
      throw new SeccompFilterError('SECCOMP_FILTER_INVALID', `Unknown label ${label}`);
    const offset = labels.get(label) - index - 1;
    if (offset < 0 || offset > 255) {
      throw new SeccompFilterError('SECCOMP_FILTER_INVALID', `Jump to ${label} is out of range`);
    }
    return offset;
  };
  return instructions.map((instruction, index) =>
    'trueLabel' in instruction
      ? {
          code: instruction.code,
          jt: target(instruction.trueLabel, index),
          jf: target(instruction.falseLabel, index),
          k: instruction.k,
        }
      : instruction
  );
}

function unixSocketFilterInstructions(architecture = process.arch) {
  const definition = Object.hasOwn(ARCHITECTURES, architecture)
    ? ARCHITECTURES[architecture]
    : null;
  if (!definition) {
    throw new SeccompFilterError(
      'SECCOMP_ARCHITECTURE_UNSUPPORTED',
      `No reviewed seccomp filter exists for ${String(architecture)}`
    );
  }
  const { syscalls } = definition;
  return assemble([
    statement(BPF_LD_W_ABS, OFFSET_ARCH),
    jump(BPF_JEQ_K, definition.auditArch, undefined, 'kill'),
    statement(BPF_LD_W_ABS, OFFSET_NR),
    ...(definition.rejectX32 ? [jump(BPF_JGE_K, X32_SYSCALL_BIT, 'kill', undefined)] : []),
    jump(BPF_JEQ_K, syscalls.socket, 'socket', undefined),
    jump(BPF_JEQ_K, syscalls.socketpair, 'socketpair', undefined),
    jump(BPF_JEQ_K, syscalls.io_uring_setup, 'nosys', undefined),
    jump(BPF_JEQ_K, syscalls.io_uring_enter, 'nosys', undefined),
    jump(BPF_JEQ_K, syscalls.io_uring_register, 'nosys', 'allow'),
    'socket',
    statement(BPF_LD_W_ABS, OFFSET_ARG0_LOW),
    jump(BPF_JEQ_K, AF_UNIX, 'deny', 'allow'),
    'socketpair',
    statement(BPF_LD_W_ABS, OFFSET_ARG0_LOW),
    jump(BPF_JEQ_K, AF_UNIX, undefined, 'allow'),
    statement(BPF_LD_W_ABS, OFFSET_ARG1_LOW),
    statement(BPF_ALU_AND_K, SOCK_TYPE_MASK),
    jump(BPF_JEQ_K, SOCK_STREAM, 'allow', undefined),
    jump(BPF_JEQ_K, SOCK_SEQPACKET, 'allow', 'deny'),
    'allow',
    statement(BPF_RET_K, SECCOMP_RET_ALLOW),
    'deny',
    statement(BPF_RET_K, SECCOMP_RET_ERRNO | EACCES),
    'nosys',
    statement(BPF_RET_K, SECCOMP_RET_ERRNO | ENOSYS),
    'kill',
    statement(BPF_RET_K, SECCOMP_RET_KILL_PROCESS),
  ]);
}

// Serialized struct sock_filter[] in the host's (little-endian) byte order:
// u16 code, u8 jt, u8 jf, u32 k. Bubblewrap reads this from its --seccomp
// descriptor and installs it with PR_SET_NO_NEW_PRIVS already set.
function buildUnixSocketSeccompFilter(architecture = process.arch) {
  const instructions = unixSocketFilterInstructions(architecture);
  const buffer = Buffer.alloc(instructions.length * 8);
  instructions.forEach((instruction, index) => {
    const offset = index * 8;
    buffer.writeUInt16LE(instruction.code, offset);
    buffer.writeUInt8(instruction.jt, offset + 2);
    buffer.writeUInt8(instruction.jf, offset + 3);
    buffer.writeUInt32LE(instruction.k >>> 0, offset + 4);
  });
  return buffer;
}

// Reference interpreter for exactly the opcodes above, so unit tests can run
// syscalls through the generated bytes rather than re-reading the generator.
function evaluateSeccompFilter(buffer, data) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length % 8 !== 0) {
    throw new SeccompFilterError(
      'SECCOMP_FILTER_INVALID',
      'Filter must be whole sock_filter records'
    );
  }
  const word = (offset) => {
    if (offset === OFFSET_NR) return data.nr >>> 0;
    if (offset === OFFSET_ARCH) return data.arch >>> 0;
    if (offset >= 16 && offset < 64 && (offset - 16) % 8 === 0)
      return (data.args?.[(offset - 16) / 8] ?? 0) >>> 0;
    throw new SeccompFilterError('SECCOMP_FILTER_INVALID', `Unsupported load offset ${offset}`);
  };
  let accumulator = 0;
  for (let pc = 0; pc * 8 < buffer.length; pc += 1) {
    const code = buffer.readUInt16LE(pc * 8);
    const jt = buffer.readUInt8(pc * 8 + 2);
    const jf = buffer.readUInt8(pc * 8 + 3);
    const k = buffer.readUInt32LE(pc * 8 + 4);
    if (code === BPF_LD_W_ABS) accumulator = word(k);
    else if (code === BPF_ALU_AND_K) accumulator = (accumulator & k) >>> 0;
    else if (code === BPF_JEQ_K) pc += accumulator === k ? jt : jf;
    else if (code === BPF_JGE_K) pc += accumulator >= k ? jt : jf;
    else if (code === BPF_RET_K) return k;
    else throw new SeccompFilterError('SECCOMP_FILTER_INVALID', `Unsupported opcode ${code}`);
  }
  throw new SeccompFilterError('SECCOMP_FILTER_INVALID', 'Filter fell off its end');
}

module.exports = {
  ARCHITECTURES,
  SECCOMP_RET_ALLOW,
  SECCOMP_RET_ERRNO,
  SECCOMP_RET_KILL_PROCESS,
  SeccompFilterError,
  buildUnixSocketSeccompFilter,
  evaluateSeccompFilter,
  unixSocketFilterInstructions,
};
