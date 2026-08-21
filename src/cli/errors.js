'use strict';

const { EXIT_CODES } = require('./exit-codes');

class CliError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = options.exitCode ?? EXIT_CODES.COMMAND_FAILED;
    this.details = options.details;
  }
}

function usageError(message, details) {
  return new CliError('USAGE', message, { exitCode: EXIT_CODES.USAGE, details });
}

module.exports = { CliError, usageError };
