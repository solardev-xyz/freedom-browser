'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  commandSpec,
  parseArgs,
  requestTimeoutForSpec,
  writeScreenshot,
} = require('./command');

describe('Freedom CLI command parsing', () => {
  test('parses global options independently of the command', () => {
    expect(
      parseArgs([
        'page',
        'navigate',
        '--tab',
        'tab_1',
        '--profile=agent',
        '--url',
        'ipfs://bafy/test',
        '--json',
      ])
    ).toEqual({
      globals: expect.objectContaining({ json: true, profile: 'agent' }),
      spec: {
        name: 'page.navigate',
        operation: 'browser_navigate',
        input: { tabId: 'tab_1', url: 'ipfs://bafy/test' },
      },
    });
  });

  test('maps interaction and wait commands to the kernel contract', () => {
    expect(commandSpec('page', 'type', ['--tab=t1', '--ref=r1', '--text', 'hello', '--append']))
      .toEqual({
        name: 'page.type',
        operation: 'browser_type',
        input: { tabId: 't1', ref: 'r1', text: 'hello', replace: false },
      });
    expect(commandSpec('page', 'type', ['--tab=t1', '--ref=r1', '--text='])).toMatchObject({
      input: { text: '', replace: true },
    });
    expect(
      commandSpec('page', 'wait', [
        '--tab',
        't1',
        '--until',
        'navigation',
        '--since-navigation-id',
        '4',
        '--timeout-ms',
        '2000',
      ])
    ).toEqual({
      name: 'page.wait',
      operation: 'browser_wait',
      input: { tabId: 't1', condition: 'navigation', sinceNavigationId: 4, timeoutMs: 2000 },
    });
  });

  test('rejects missing and unknown command options', () => {
    expect(() => commandSpec('tabs', 'open', [])).toThrow('--url is required');
    expect(() => commandSpec('tabs', 'list', ['--mystery'])).toThrow(
      'Unknown option: --mystery'
    );
    expect(() => commandSpec('page', 'wait', ['--tab=t1', '--until=network-idle'])).toThrow(
      '--until must be one of'
    );
    expect(() =>
      commandSpec('page', 'wait', ['--tab=t1', '--until=load', '--timeout-ms=30001'])
    ).toThrow('--timeout-ms must not exceed 30000');
  });

  test('allows the runtime to return typed wait timeouts before the client deadline', () => {
    const maximumWait = commandSpec('page', 'wait', [
      '--tab=t1',
      '--until=text',
      '--text=never',
      '--timeout-ms=30000',
    ]);
    const defaultWait = commandSpec('page', 'wait', ['--tab=t1', '--until=load']);
    expect(requestTimeoutForSpec(maximumWait)).toBe(35_000);
    expect(requestTimeoutForSpec(defaultWait)).toBe(15_000);
    expect(requestTimeoutForSpec(maximumWait, 1_000)).toBe(1_000);
    expect(requestTimeoutForSpec(commandSpec('tabs', 'list', []))).toBeUndefined();
  });

  test('writes screenshots without overwriting unless force is explicit', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-cli-shot-'));
    const outputPath = path.join(outputDir, 'shot.png');
    const envelope = {
      ok: true,
      result: { mediaType: 'image/png', base64: Buffer.from('png-data').toString('base64') },
    };
    expect(writeScreenshot({ output: outputPath, force: false }, envelope)).toMatchObject({
      result: { path: outputPath, bytes: 8, mediaType: 'image/png' },
    });
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('png-data');
    expect(() => writeScreenshot({ output: outputPath, force: false }, envelope)).toThrow(
      'use --force to overwrite'
    );
  });
});
