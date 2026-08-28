'use strict';

const {
  DiagnosticLogBuffer,
  installDiagnosticLogTransport,
} = require('./diagnostic-log-buffer');

describe('DiagnosticLogBuffer', () => {
  test('captures raw node and Freedom lines with trusted source classification', () => {
    const buffer = new DiagnosticLogBuffer({ maxEntries: 10 });
    buffer.capture({
      date: new Date('2026-08-28T12:00:00.000Z'),
      level: 'error',
      data: ['[Ant stderr]: peer 16Uiu2H\nsecond line\u001b[31m red\u001b[0m'],
    });
    buffer.capture({ level: 'info', data: ['[Agent] ordinary Freedom log'] });

    expect(buffer.read({ service: 'ant', maxLines: 10, maxBytes: 10_000 })).toEqual({
      entries: [
        {
          sequence: 1,
          timestamp: '2026-08-28T12:00:00.000Z',
          level: 'error',
          source: 'node_stderr',
          service: 'ant',
          text: '[Ant stderr]: peer 16Uiu2H',
        },
        {
          sequence: 2,
          timestamp: '2026-08-28T12:00:00.000Z',
          level: 'error',
          source: 'node_stderr',
          service: 'ant',
          text: 'second line red',
        },
      ],
      lineCount: 2,
      bytes: 41,
      truncated: false,
    });
    expect(buffer.read({ maxLines: 10, maxBytes: 10_000 }).lineCount).toBe(3);
  });

  test('returns only the newest bounded evidence and never accepts a path', () => {
    const buffer = new DiagnosticLogBuffer({ maxEntries: 3 });
    for (const value of ['one', 'two', 'three', 'four']) {
      buffer.capture({ level: 'info', data: [`[IPFS] ${value}`] });
    }

    const result = buffer.read({
      service: 'ipfs',
      maxLines: 2,
      maxBytes: 1_000,
      path: '/arbitrary/file',
    });
    expect(result.entries.map((entry) => entry.text)).toEqual(['[IPFS] three', '[IPFS] four']);
    expect(result.truncated).toBe(true);
    expect(result).not.toHaveProperty('path');
  });

  test('installs one in-memory logger transport', () => {
    const buffer = new DiagnosticLogBuffer();
    const log = { transports: {} };
    installDiagnosticLogTransport(log, buffer);
    installDiagnosticLogTransport(log, buffer);

    log.transports.diagnostics({ level: 'warn', data: ['[Tor] bootstrap stalled'] });
    expect(buffer.read({ service: 'tor', maxLines: 10, maxBytes: 1_000 }).lineCount).toBe(1);
    expect(log.transports.diagnostics.level).toBe('info');
  });
});
