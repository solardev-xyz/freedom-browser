'use strict';

const fs = require('fs');
const path = require('path');
const { resolveExecutableAccess } = require('./executable-access');

const PROCESS_RUNTIME_COMMANDS = Object.freeze(['node', 'npm']);

class QualificationRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QualificationRuntimeError';
    this.code = code;
  }
}

// Resolves the JavaScript runtime of the calling test or qualification process through the
// generic approved-executable contract. Only the directory holding the process's own
// executable is searched, so neither the ambient host PATH nor an assumed system Node takes
// part. A runtime that already lives in the system toolchain resolves to `available` with
// no runtime root; any other runtime becomes validated read-only runtime roots that a
// policy mounts only for the workloads that request them.
async function resolveProcessRuntimeAccess(options = {}) {
  const execPath = options.execPath ?? process.execPath;
  const commands = options.commands ?? PROCESS_RUNTIME_COMMANDS;
  let executablePath;
  try {
    executablePath = await fs.promises.realpath(execPath);
  } catch (error) {
    throw new QualificationRuntimeError(
      'RUNTIME_UNAVAILABLE',
      `The process runtime executable is not accessible (${error.code})`
    );
  }
  const request = await resolveExecutableAccess(commands, {
    hostEnvironment: { PATH: path.dirname(executablePath) },
  });
  const unavailable = request.commands
    .filter((command) => command.status === 'unavailable')
    .map((command) => command.name);
  if (unavailable.length > 0) {
    throw new QualificationRuntimeError(
      'RUNTIME_COMMAND_UNAVAILABLE',
      `The process runtime does not provide ${unavailable.join(', ')} beside its executable`
    );
  }
  return request;
}

// Returns the sandbox path at which an approved runtime command becomes visible, or null
// when the command resolved to the system toolchain and therefore needs no runtime root.
function approvedCommandPath(request, name) {
  const root = request.runtimeRoots.find((candidate) => candidate.commands.includes(name));
  if (!root) return null;
  const command = request.commands.find((candidate) => candidate.name === name);
  const relative = path.relative(root.sourcePath, command.executablePath);
  return path.posix.join(root.mountPath, ...relative.split(path.sep));
}

module.exports = {
  PROCESS_RUNTIME_COMMANDS,
  QualificationRuntimeError,
  approvedCommandPath,
  resolveProcessRuntimeAccess,
};
