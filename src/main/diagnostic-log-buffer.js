'use strict';

const util = require('util');

const DEFAULT_MAX_ENTRIES = 5_000;
const MAX_CAPTURE_LINE_BYTES = 16_384;
// eslint-disable-next-line no-control-regex -- ANSI escape sequences are removed mechanically.
const ANSI_ESCAPE_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
// Preserve tabs; line breaks are handled before this expression is applied.
// eslint-disable-next-line no-control-regex -- Remaining terminal control bytes are not useful evidence.
const UNSAFE_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const SERVICE_PATTERNS = Object.freeze([
  Object.freeze({ service: 'ant', pattern: /^\[Ant(?:\s|\]|-)/i }),
  Object.freeze({ service: 'ipfs', pattern: /^\[(?:IPFS|freedom-ipfs)(?:\s|\]|-)/i }),
  Object.freeze({ service: 'radicle', pattern: /^\[Radicle(?:\s|\]|-)/i }),
  Object.freeze({ service: 'tor', pattern: /^\[(?:Tor|arti)(?:\s|\]|-)/i }),
  Object.freeze({ service: 'myotis', pattern: /^\[myotis(?:\s|\]|-)/i }),
]);

function truncateUtf8(value, maxBytes) {
  const buffer = Buffer.from(String(value), 'utf8');
  if (buffer.length <= maxBytes) return String(value);
  let truncated = buffer.subarray(0, maxBytes).toString('utf8');
  if (truncated.endsWith('\ufffd')) truncated = truncated.slice(0, -1);
  return truncated;
}

function formatLogData(data) {
  try {
    return util.formatWithOptions(
      {
        breakLength: Infinity,
        colors: false,
        compact: true,
        depth: 5,
        maxArrayLength: 100,
        maxStringLength: 65_536,
      },
      ...(Array.isArray(data) ? data : [data])
    );
  } catch {
    return '[Log entry could not be formatted]';
  }
}

function normalizeLogText(value) {
  return String(value || '')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replace(ANSI_ESCAPE_RE, '')
    .replace(UNSAFE_CONTROL_RE, '');
}

function classifyService(text) {
  return SERVICE_PATTERNS.find(({ pattern }) => pattern.test(text))?.service || null;
}

function classifySource(text) {
  if (/^\[(?:Ant|Radicle-(?:node|httpd)) stdout\]/i.test(text)) return 'node_stdout';
  if (/^\[(?:Ant|Radicle-(?:node|httpd)) stderr\]/i.test(text)) return 'node_stderr';
  if (/^\[arti stdout\]/i.test(text)) return 'node_stdout';
  if (/^\[arti stderr\]/i.test(text)) return 'node_stderr';
  if (/^\[myotis-engine\]/i.test(text)) return 'node_output';
  return 'freedom';
}

class DiagnosticLogBuffer {
  constructor(options = {}) {
    this.maxEntries =
      Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0
        ? options.maxEntries
        : DEFAULT_MAX_ENTRIES;
    this.entries = [];
    this.sequence = 0;
  }

  capture(message = {}) {
    const formatted = normalizeLogText(formatLogData(message.data));
    const service = classifyService(formatted);
    const source = classifySource(formatted);
    const timestamp =
      message.date instanceof Date && !Number.isNaN(message.date.valueOf())
        ? message.date.toISOString()
        : new Date().toISOString();
    const level = ['error', 'warn', 'info', 'verbose', 'debug', 'silly'].includes(message.level)
      ? message.level
      : 'info';
    for (const rawLine of formatted.split('\n')) {
      if (!rawLine) continue;
      this.sequence += 1;
      this.entries.push(
        Object.freeze({
          sequence: this.sequence,
          timestamp,
          level,
          source,
          ...(service && { service }),
          text: truncateUtf8(rawLine, MAX_CAPTURE_LINE_BYTES),
        })
      );
    }
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  read(options = {}) {
    const service = typeof options.service === 'string' ? options.service : null;
    const maxLines = Number.isSafeInteger(options.maxLines) ? options.maxLines : 200;
    const maxBytes = Number.isSafeInteger(options.maxBytes) ? options.maxBytes : 49_152;
    const matching = service
      ? this.entries.filter((entry) => entry.service === service)
      : this.entries;
    const selected = [];
    let bytes = 0;
    let truncated = false;
    for (let index = matching.length - 1; index >= 0 && selected.length < maxLines; index -= 1) {
      const entry = matching[index];
      const available = maxBytes - bytes;
      if (available <= 0) {
        truncated = true;
        break;
      }
      const entryBytes = Buffer.byteLength(entry.text, 'utf8');
      if (entryBytes > available) {
        if (selected.length === 0) {
          selected.push(Object.freeze({ ...entry, text: truncateUtf8(entry.text, available) }));
          bytes = maxBytes;
        }
        truncated = true;
        break;
      }
      selected.push(entry);
      bytes += entryBytes;
    }
    if (selected.length < matching.length) truncated = true;
    return Object.freeze({
      entries: Object.freeze(selected.reverse()),
      lineCount: selected.length,
      bytes,
      truncated,
    });
  }

  clear() {
    this.entries = [];
    this.sequence = 0;
  }
}

const diagnosticLogBuffer = new DiagnosticLogBuffer();

function installDiagnosticLogTransport(log, buffer = diagnosticLogBuffer) {
  if (!log?.transports || log.transports.diagnostics?.freedomDiagnosticTransport === true) {
    return;
  }
  const transport = (message) => buffer.capture(message);
  transport.level = 'info';
  transport.freedomDiagnosticTransport = true;
  log.transports.diagnostics = transport;
}

module.exports = {
  DiagnosticLogBuffer,
  diagnosticLogBuffer,
  installDiagnosticLogTransport,
  normalizeLogText,
  truncateUtf8,
};
