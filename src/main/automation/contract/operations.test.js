'use strict';

const { OPERATIONS, validateOperationInput } = require('./operations');

describe('automation operation contract', () => {
  test('normalizes supported operation inputs', () => {
    expect(
      validateOperationInput(OPERATIONS.TYPE, {
        tabId: ' tab_1 ',
        ref: ' ref_1 ',
        text: '',
        intent: ' Draft the response ',
      })
    ).toEqual({
      tabId: 'tab_1',
      ref: 'ref_1',
      text: '',
      replace: true,
      intent: 'Draft the response',
    });
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

  test('bounds optional website interaction intent', () => {
    expect(
      validateOperationInput(OPERATIONS.CLICK, {
        tabId: 'tab_1',
        ref: 'ref_publish',
        intent: 'Publish the comment',
      })
    ).toEqual({
      tabId: 'tab_1',
      ref: 'ref_publish',
      intent: 'Publish the comment',
    });
    expect(() =>
      validateOperationInput(OPERATIONS.CLICK, {
        tabId: 'tab_1',
        ref: 'ref_publish',
        intent: 'x'.repeat(241),
      })
    ).toThrow('intent cannot exceed 240 characters');
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

  test('normalizes a bounded Ant HTTP node request', () => {
    expect(
      validateOperationInput(OPERATIONS.NODE_REQUEST, {
        service: ' ant ',
        transport: ' http ',
        request: {
          method: ' post ',
          path: ' /tags?limit=1 ',
          headers: {
            'Content-Type': 'application/json',
            'Swarm-Postage-Batch-Id': 'batch-id',
          },
          body: '{"address":"abc"}',
        },
      })
    ).toEqual({
      service: 'ant',
      transport: 'http',
      request: {
        method: 'POST',
        path: '/tags?limit=1',
        headers: {
          'content-type': 'application/json',
          'swarm-postage-batch-id': 'batch-id',
        },
        body: '{"address":"abc"}',
      },
    });
  });

  test('normalizes Radicle HTTP and native IPFS gateway requests', () => {
    expect(
      validateOperationInput(OPERATIONS.NODE_REQUEST, {
        service: 'radicle',
        transport: 'http',
        request: { method: 'GET', path: '/api/v1/repos' },
      })
    ).toEqual({
      service: 'radicle',
      transport: 'http',
      request: { method: 'GET', path: '/api/v1/repos' },
    });
    expect(
      validateOperationInput(OPERATIONS.NODE_REQUEST, {
        service: 'ipfs',
        transport: 'gateway',
        request: { method: 'HEAD', path: '/ipfs/bafy-test' },
      })
    ).toEqual({
      service: 'ipfs',
      transport: 'gateway',
      request: { method: 'HEAD', path: '/ipfs/bafy-test' },
    });
  });

  test.each([
    ['wrong IPFS transport', { service: 'ipfs', transport: 'http', request: { method: 'GET', path: '/' } }],
    ['mutating IPFS gateway request', { service: 'ipfs', transport: 'gateway', request: { method: 'POST', path: '/ipfs/bafy' } }],
    ['unsupported service', { service: 'tor', transport: 'http', request: { method: 'GET', path: '/' } }],
    ['absolute URL', { service: 'ant', transport: 'http', request: { method: 'GET', path: 'https://evil.test/' } }],
    ['authority path', { service: 'ant', transport: 'http', request: { method: 'GET', path: '//evil.test/' } }],
    ['authorization header', { service: 'ant', transport: 'http', request: { method: 'GET', path: '/', headers: { authorization: 'secret' } } }],
    ['GET body', { service: 'ant', transport: 'http', request: { method: 'GET', path: '/', body: 'x' } }],
  ])('rejects unsafe node request input: %s', (_label, input) => {
    expect(() => validateOperationInput(OPERATIONS.NODE_REQUEST, input)).toThrow();
  });

  test('accepts exact or discovery-mode node operation status input', () => {
    expect(validateOperationInput(OPERATIONS.NODE_OPERATION_STATUS, {})).toEqual({});
    expect(
      validateOperationInput(OPERATIONS.NODE_OPERATION_STATUS, {
        operationId: ' node_op_aaaaaaaaaaaaaaaaaaaaaaaa ',
      })
    ).toEqual({ operationId: 'node_op_aaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(() =>
      validateOperationInput(OPERATIONS.NODE_OPERATION_STATUS, { operationId: 'node_op_guess' })
    ).toThrow('Freedom node operation ID');
  });

  test('normalizes and constrains node lifecycle actions', () => {
    expect(
      validateOperationInput(OPERATIONS.NODE_LIFECYCLE, {
        service: ' myotis-gnosis ',
        action: ' restart ',
      })
    ).toEqual({ service: 'myotis-gnosis', action: 'restart' });
    expect(() =>
      validateOperationInput(OPERATIONS.NODE_LIFECYCLE, {
        service: 'ant',
        action: 'reset',
      })
    ).toThrow('action must be one of');
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

  test('normalizes and bounds direct wallet transfer intent without a tab', () => {
    expect(
      validateOperationInput(OPERATIONS.WALLET_TRANSFER, {
        recipient: ' meinhard.eth ',
        amount: ' 0.01 ',
        asset: ' GNO ',
        chainId: 100,
        walletIndex: 2,
      })
    ).toEqual({
      recipient: 'meinhard.eth',
      amount: '0.01',
      asset: 'GNO',
      chainId: 100,
      walletIndex: 2,
    });
    expect(() =>
      validateOperationInput(OPERATIONS.WALLET_TRANSFER, {
        recipient: '0x3333333333333333333333333333333333333333',
        amount: '1',
        asset: 'ETH',
        chainId: 0,
      })
    ).toThrow('chainId must be a positive integer');
    expect(() =>
      validateOperationInput(OPERATIONS.WALLET_TRANSFER, {
        recipient: '0x3333333333333333333333333333333333333333',
        amount: '1',
        asset: 'ETH',
        walletIndex: -1,
      })
    ).toThrow('walletIndex must be a non-negative integer');
  });

  test('normalizes read-only node status without a browser tab', () => {
    expect(validateOperationInput(OPERATIONS.NODE_STATUS, {})).toEqual({});
  });

  test('bounds node and application diagnostic requests without accepting paths', () => {
    expect(
      validateOperationInput(OPERATIONS.NODE_DIAGNOSTICS, {
        service: 'myotis-gnosis',
        maxLines: 25,
        maxBytes: 4_096,
        path: '/not/accepted',
      })
    ).toEqual({ service: 'myotis-gnosis', maxLines: 25, maxBytes: 4_096 });
    expect(validateOperationInput(OPERATIONS.APP_DIAGNOSTICS, {})).toEqual({
      maxLines: 200,
      maxBytes: 49_152,
    });
    expect(() =>
      validateOperationInput(OPERATIONS.NODE_DIAGNOSTICS, { service: 'arbitrary-process' })
    ).toThrow('service must be one of');
    expect(() =>
      validateOperationInput(OPERATIONS.APP_DIAGNOSTICS, { maxBytes: 65_537 })
    ).toThrow('maxBytes must be an integer');
  });
});
