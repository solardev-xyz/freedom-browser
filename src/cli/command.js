'use strict';

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
  OPERATIONS,
} = require('../shared/automation-operations');
const { CliError, usageError } = require('./errors');
const { EXIT_CODES } = require('./exit-codes');
const { locateProfile } = require('./profile-locator');
const { connectRuntime } = require('./runtime-client');
const { ensureRuntime } = require('./runtime-launcher');

const HELP = `Freedom CLI

Usage:
  freedom [global options] runtime start|status|stop
  freedom [global options] tabs list
  freedom [global options] tabs open --url <url>
  freedom [global options] tabs get|close --tab <tab-id>
  freedom [global options] page snapshot --tab <tab-id>
  freedom [global options] page navigate --tab <tab-id> --url <url>
  freedom [global options] page click --tab <tab-id> --ref <ref>
  freedom [global options] page type --tab <tab-id> --ref <ref> --text <text> [--append]
  freedom [global options] page wait --tab <tab-id> --until <condition> [condition options]
  freedom [global options] page screenshot --tab <tab-id> [--output <path>] [--force]
  freedom [global options] page stop --tab <tab-id>

Global options:
  --profile <id>              Select a registered profile (default: automation)
  --profile-dir <path>        Use an explicit profile directory
  --app-root <path>           Override the Freedom app-data root
  --runtime-executable <path> Override the runtime executable
  --timeout <milliseconds>    Runtime request timeout
  --json                      Emit compact JSON
  --help                      Show this help

Wait conditions: load, navigation, text, url
`;

const VALUE_GLOBALS = new Set([
  'profile',
  'profile-dir',
  'app-root',
  'runtime-executable',
  'timeout',
]);
const BOOLEAN_GLOBALS = new Set(['json', 'help']);
const WAIT_CONDITIONS = new Set(['load', 'navigation', 'text', 'url']);
const WAIT_REQUEST_TIMEOUT_MARGIN_MS = 5_000;

function splitOption(token) {
  const equalIndex = token.indexOf('=');
  if (equalIndex === -1) return [token.slice(2), null];
  return [token.slice(2, equalIndex), token.slice(equalIndex + 1)];
}

function extractGlobalOptions(argv) {
  const options = {};
  const remaining = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      remaining.push(token);
      continue;
    }
    const [name, inlineValue] = splitOption(token);
    if (BOOLEAN_GLOBALS.has(name)) {
      if (inlineValue !== null) throw usageError(`--${name} does not accept a value`);
      options[name] = true;
      continue;
    }
    if (!VALUE_GLOBALS.has(name)) {
      remaining.push(token);
      continue;
    }
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || (inlineValue === null && value.startsWith('--'))) {
      throw usageError(`--${name} requires a value`);
    }
    if (inlineValue === null) index += 1;
    options[name] = value;
  }
  return { options, remaining };
}

function parseCommandOptions(tokens, allowedValues = [], allowedBooleans = []) {
  const valueSet = new Set(allowedValues);
  const booleanSet = new Set(allowedBooleans);
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw usageError(`Unexpected argument: ${token}`);
    const [name, inlineValue] = splitOption(token);
    if (booleanSet.has(name)) {
      if (inlineValue !== null) throw usageError(`--${name} does not accept a value`);
      options[name] = true;
      continue;
    }
    if (!valueSet.has(name)) throw usageError(`Unknown option: --${name}`);
    const value = inlineValue ?? tokens[index + 1];
    if (value === undefined || (inlineValue === null && value.startsWith('--'))) {
      throw usageError(`--${name} requires a value`);
    }
    if (inlineValue === null) index += 1;
    options[name] = value;
  }
  return options;
}

function requireOption(options, name, settings = {}) {
  const value = options[name];
  if (typeof value !== 'string' || (!settings.allowEmpty && value.length === 0)) {
    throw usageError(`--${name} is required`);
  }
  return value;
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw usageError(`--${name} must be a positive integer`);
  }
  return parsed;
}

function commandSpec(group, action, tokens) {
  if (group === 'runtime' && ['start', 'status', 'stop'].includes(action)) {
    parseCommandOptions(tokens);
    return { name: `runtime.${action}`, kind: 'runtime', action };
  }
  if (group === 'tabs' && action === 'list') {
    parseCommandOptions(tokens);
    return { name: 'tabs.list', operation: OPERATIONS.LIST_TABS, input: {} };
  }
  if (group === 'tabs' && action === 'open') {
    const options = parseCommandOptions(tokens, ['url']);
    return {
      name: 'tabs.open',
      operation: OPERATIONS.CREATE_TAB,
      input: { url: requireOption(options, 'url') },
    };
  }
  if (group === 'tabs' && ['get', 'close'].includes(action)) {
    const options = parseCommandOptions(tokens, ['tab']);
    return {
      name: `tabs.${action}`,
      operation: action === 'get' ? OPERATIONS.GET_TAB : OPERATIONS.CLOSE_TAB,
      input: { tabId: requireOption(options, 'tab') },
    };
  }
  if (group === 'page' && ['snapshot', 'stop'].includes(action)) {
    const options = parseCommandOptions(tokens, ['tab']);
    return {
      name: `page.${action}`,
      operation: action === 'snapshot' ? OPERATIONS.SNAPSHOT : OPERATIONS.STOP_LOADING,
      input: { tabId: requireOption(options, 'tab') },
    };
  }
  if (group === 'page' && action === 'navigate') {
    const options = parseCommandOptions(tokens, ['tab', 'url']);
    return {
      name: 'page.navigate',
      operation: OPERATIONS.NAVIGATE,
      input: { tabId: requireOption(options, 'tab'), url: requireOption(options, 'url') },
    };
  }
  if (group === 'page' && action === 'click') {
    const options = parseCommandOptions(tokens, ['tab', 'ref']);
    return {
      name: 'page.click',
      operation: OPERATIONS.CLICK,
      input: { tabId: requireOption(options, 'tab'), ref: requireOption(options, 'ref') },
    };
  }
  if (group === 'page' && action === 'type') {
    const options = parseCommandOptions(tokens, ['tab', 'ref', 'text'], ['append']);
    return {
      name: 'page.type',
      operation: OPERATIONS.TYPE,
      input: {
        tabId: requireOption(options, 'tab'),
        ref: requireOption(options, 'ref'),
        text: requireOption(options, 'text', { allowEmpty: true }),
        replace: options.append !== true,
      },
    };
  }
  if (group === 'page' && action === 'wait') {
    const options = parseCommandOptions(tokens, [
      'tab',
      'until',
      'text',
      'url',
      'since-navigation-id',
      'timeout-ms',
    ]);
    const condition = requireOption(options, 'until');
    if (!WAIT_CONDITIONS.has(condition)) {
      throw usageError('--until must be one of: load, navigation, text, url');
    }
    const input = { tabId: requireOption(options, 'tab'), condition };
    if (options['timeout-ms']) {
      input.timeoutMs = parsePositiveInteger(options['timeout-ms'], 'timeout-ms');
      if (input.timeoutMs > MAX_WAIT_TIMEOUT_MS) {
        throw usageError(`--timeout-ms must not exceed ${MAX_WAIT_TIMEOUT_MS}`);
      }
    }
    if (condition === 'text') input.text = requireOption(options, 'text');
    if (condition === 'url') input.url = requireOption(options, 'url');
    if (condition === 'navigation') {
      const since = requireOption(options, 'since-navigation-id');
      const parsed = Number(since);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw usageError('--since-navigation-id must be a non-negative integer');
      }
      input.sinceNavigationId = parsed;
    }
    return { name: 'page.wait', operation: OPERATIONS.WAIT, input };
  }
  if (group === 'page' && action === 'screenshot') {
    const options = parseCommandOptions(tokens, ['tab', 'output'], ['force']);
    return {
      name: 'page.screenshot',
      operation: OPERATIONS.SCREENSHOT,
      input: { tabId: requireOption(options, 'tab') },
      output: options.output,
      force: options.force === true,
    };
  }
  throw usageError(`Unknown command: ${[group, action].filter(Boolean).join(' ') || '(none)'}`);
}

function parseArgs(argv) {
  const { options: globals, remaining } = extractGlobalOptions(argv);
  if (globals.help || remaining[0] === 'help') return { help: true, globals };
  if (remaining.length < 2) throw usageError('A command group and action are required');
  const requestTimeoutMs = globals.timeout
    ? parsePositiveInteger(globals.timeout, 'timeout')
    : undefined;
  return {
    globals: {
      json: globals.json === true,
      profile: globals.profile,
      profileDir: globals['profile-dir'],
      appRoot: globals['app-root'],
      runtimeExecutable: globals['runtime-executable'],
      requestTimeoutMs,
    },
    spec: commandSpec(remaining[0], remaining[1], remaining.slice(2)),
  };
}

function unwrapAutomationResult(envelope) {
  if (envelope?.ok === true) return envelope;
  throw new CliError(
    envelope?.error?.code || 'AUTOMATION_FAILED',
    envelope?.error?.message || 'Automation command failed',
    { exitCode: EXIT_CODES.COMMAND_FAILED, details: envelope?.error?.details }
  );
}

function requestTimeoutForSpec(spec, configuredTimeoutMs) {
  if (configuredTimeoutMs !== undefined) return configuredTimeoutMs;
  if (spec.operation !== OPERATIONS.WAIT) return undefined;
  return (spec.input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS) + WAIT_REQUEST_TIMEOUT_MARGIN_MS;
}

function writeScreenshot(spec, envelope) {
  if (!spec.output) return envelope;
  const screenshot = envelope?.result;
  if (screenshot?.mediaType !== 'image/png' || typeof screenshot.base64 !== 'string') {
    throw new CliError('INVALID_SCREENSHOT', 'Runtime returned an invalid screenshot', {
      exitCode: EXIT_CODES.COMMAND_FAILED,
    });
  }
  const outputPath = path.resolve(spec.output);
  let descriptor;
  try {
    const flags = fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      (spec.force ? fs.constants.O_TRUNC : fs.constants.O_EXCL) |
      (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(outputPath, flags, 0o600);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('Screenshot output is not a regular file');
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, Buffer.from(screenshot.base64, 'base64'));
  } catch (error) {
    const message = error?.code === 'EEXIST'
      ? `Screenshot already exists: ${outputPath} (use --force to overwrite)`
      : `Unable to write screenshot: ${outputPath}`;
    throw new CliError('SCREENSHOT_WRITE_FAILED', message, {
      exitCode: EXIT_CODES.COMMAND_FAILED,
      cause: error,
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return {
    ...envelope,
    result: { mediaType: screenshot.mediaType, path: outputPath, bytes: Buffer.byteLength(screenshot.base64, 'base64') },
  };
}

async function executeParsed(parsed, options = {}) {
  if (parsed.help) return { help: HELP };
  const profile = locateProfile({
    ...parsed.globals,
    env: options.env,
    repoRoot: options.repoRoot,
    platform: options.platform,
  });
  const connectionOptions = {
    env: options.env,
    repoRoot: options.repoRoot,
    runtimeExecutable: parsed.globals.runtimeExecutable,
    requestTimeoutMs: parsed.globals.requestTimeoutMs,
    startTimeoutMs: options.startTimeoutMs,
  };

  let connection;
  if (parsed.spec.kind === 'runtime') {
    if (parsed.spec.action === 'start') {
      connection = await ensureRuntime(profile, { ...connectionOptions, persistent: true });
      try {
        return { command: parsed.spec.name, result: connection.status };
      } finally {
        connection.client.close();
      }
    }
    connection = await connectRuntime(profile, connectionOptions);
    try {
      const method = parsed.spec.action === 'stop' ? 'runtime.shutdown' : 'runtime.status';
      return { command: parsed.spec.name, result: await connection.client.request(method) };
    } finally {
      connection.client.close();
    }
  }

  connection = await ensureRuntime(profile, connectionOptions);
  try {
    const envelope = unwrapAutomationResult(
      await connection.client.request(
        'automation.execute',
        {
          operation: parsed.spec.operation,
          input: parsed.spec.input,
        },
        {
          timeoutMs: requestTimeoutForSpec(parsed.spec, parsed.globals.requestTimeoutMs),
        }
      )
    );
    return {
      command: parsed.spec.name,
      result: writeScreenshot(parsed.spec, envelope),
    };
  } finally {
    connection.client.close();
  }
}

module.exports = {
  HELP,
  commandSpec,
  executeParsed,
  extractGlobalOptions,
  parseArgs,
  requestTimeoutForSpec,
  writeScreenshot,
};
