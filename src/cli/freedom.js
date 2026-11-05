#!/usr/bin/env node
'use strict';

const { executeParsed, parseArgs } = require('./command');
const { CliError } = require('./errors');
const { EXIT_CODES } = require('./exit-codes');

function writeJson(stream, value, compact) {
  stream.write(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`);
}

async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let parsed;
  try {
    parsed = parseArgs(argv);
    const result = await executeParsed(parsed, io);
    if (result.help) {
      stdout.write(result.help);
    } else {
      writeJson(stdout, { ok: true, ...result }, parsed.globals.json);
    }
    return EXIT_CODES.SUCCESS;
  } catch (error) {
    const failure = error instanceof CliError
      ? error
      : new CliError('INTERNAL_ERROR', 'Freedom CLI failed unexpectedly', {
          exitCode: EXIT_CODES.INTERNAL,
          cause: error,
        });
    writeJson(
      stderr,
      {
        ok: false,
        error: {
          code: failure.code,
          message: failure.message,
          ...(failure.details !== undefined && { details: failure.details }),
        },
      },
      parsed?.globals?.json === true
    );
    return failure.exitCode;
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = { main };
