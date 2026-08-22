'use strict';

const { OPERATIONS, validateOperationInput } = require('./operations');

describe('automation operation contract', () => {
  test('normalizes supported operation inputs', () => {
    expect(
      validateOperationInput(OPERATIONS.TYPE, {
        tabId: ' tab_1 ',
        ref: ' ref_1 ',
        text: '',
      })
    ).toEqual({ tabId: 'tab_1', ref: 'ref_1', text: '', replace: true });
    expect(
      validateOperationInput(OPERATIONS.NAVIGATE, { tabId: 'tab_1', url: 'ipfs://bafy/' })
    ).toEqual({ tabId: 'tab_1', url: 'ipfs://bafy/' });
    expect(
      validateOperationInput(OPERATIONS.CREATE_TAB, { url: ' https://example.test/ ' })
    ).toEqual({ url: 'https://example.test/' });
    expect(
      validateOperationInput(OPERATIONS.CREATE_TAB, {
        url: 'https://example.test/research',
        openerTabId: ' tab_1 ',
      })
    ).toEqual({ url: 'https://example.test/research', openerTabId: 'tab_1' });
    expect(validateOperationInput(OPERATIONS.CLOSE_TAB, { tabId: ' tab_1 ' })).toEqual({
      tabId: 'tab_1',
    });
    expect(
      validateOperationInput(OPERATIONS.SELECT, {
        tabId: ' tab_1 ',
        ref: ' ref_region ',
        value: '',
      })
    ).toEqual({ tabId: 'tab_1', ref: 'ref_region', value: '' });
    expect(
      validateOperationInput(OPERATIONS.PRESS, {
        tabId: ' tab_1 ',
        ref: ' ref_environment ',
        key: ' ArrowDown ',
      })
    ).toEqual({ tabId: 'tab_1', ref: 'ref_environment', key: 'ArrowDown' });
  });

  test.each([
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///tmp/secret',
    'freedom://settings',
    'chrome://settings',
    'about:blank',
    'blob:https://example.test/id',
    'devtools://devtools/bundled/inspector.html',
    'ftp://example.test/file',
  ])('rejects privileged navigation URL %s', (url) => {
    expect(() => validateOperationInput(OPERATIONS.NAVIGATE, { tabId: 'tab_1', url })).toThrow(
      'is not allowed'
    );
  });

  test.each([
    'http://example.test/',
    'https://example.test/',
    'bzz://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/',
    'ipfs://bafybeiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/',
    'ipns://docs.ipfs.tech/',
  ])('accepts supported navigation URL %s', (url) => {
    expect(validateOperationInput(OPERATIONS.NAVIGATE, { tabId: 'tab_1', url })).toEqual({
      tabId: 'tab_1',
      url,
    });
  });

  test('rejects navigation URLs with embedded credentials', () => {
    expect(() =>
      validateOperationInput(OPERATIONS.NAVIGATE, {
        tabId: 'tab_1',
        url: 'https://user:password@example.test/',
      })
    ).toThrow('must not contain embedded credentials');
  });

  test('rejects relative navigation targets and unknown operations', () => {
    expect(() =>
      validateOperationInput(OPERATIONS.NAVIGATE, { tabId: 'tab_1', url: 'example.com' })
    ).toThrow('absolute URL');
    expect(() => validateOperationInput('browser_execute_javascript', {})).toThrow(
      'Unknown automation operation'
    );
  });

  test('validates bounded declarative waits', () => {
    expect(
      validateOperationInput(OPERATIONS.WAIT, {
        tabId: 'tab_1',
        condition: 'navigation',
        sinceNavigationId: 4,
      })
    ).toEqual({
      tabId: 'tab_1',
      condition: 'navigation',
      sinceNavigationId: 4,
      timeoutMs: 10_000,
    });
    expect(() =>
      validateOperationInput(OPERATIONS.WAIT, {
        tabId: 'tab_1',
        condition: 'script',
        timeoutMs: 100,
      })
    ).toThrow('condition must be one of');
    expect(() =>
      validateOperationInput(OPERATIONS.WAIT, {
        tabId: 'tab_1',
        condition: 'text',
        text: 'ready',
        timeoutMs: 30_001,
      })
    ).toThrow('timeoutMs must be an integer');
  });

  test('rejects arbitrary keyboard input', () => {
    expect(() =>
      validateOperationInput(OPERATIONS.PRESS, {
        tabId: 'tab_1',
        ref: 'ref_1',
        key: 'Meta+R',
      })
    ).toThrow('key must be one of');
  });
});
