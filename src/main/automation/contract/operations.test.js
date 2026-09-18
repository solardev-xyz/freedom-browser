'use strict';

const { OPERATIONS, validateOperationInput } = require('./operations');

describe('automation operation contract', () => {
  test('frame reads accept bounded windows but no caller authority or script', () => {
    const frameRef = 'frame_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(validateOperationInput(OPERATIONS.LIST_FRAMES, { tabId: 'tab_1' })).toEqual({ tabId: 'tab_1' });
    expect(validateOperationInput(OPERATIONS.READ_FRAME, {
      tabId: 'tab_1', frameRef, query: ' Save ', textOffset: 12000,
      authorizeFrame: true, script: 'document.body',
    })).toEqual({ tabId: 'tab_1', frameRef, query: 'Save', textOffset: 12000 });
    for (const input of [{ frameRef: 'child' }, { frameRef: '' }, { query: '' }, { textQuery: 'x'.repeat(201) }, { elementOffset: -1 }, { textOffset: 1000001 }, { textOffset: 1.5 }]) {
      expect(() => validateOperationInput(OPERATIONS.READ_FRAME, { tabId: 'tab_1', frameRef, ...input })).toThrow();
    }
  });

  test('validates bounded live snapshot search and continuation', () => {
    expect(
      validateOperationInput(OPERATIONS.SNAPSHOT, {
        tabId: 'tab_1',
        query: ' Target ',
        elementOffset: 250,
        textOffset: 12000,
        navigationId: 3,
        documentId: 'document_test',
      })
    ).toEqual({
      tabId: 'tab_1',
      query: 'Target',
      elementOffset: 250,
      textOffset: 12000,
      navigationId: 3,
      documentId: 'document_test',
    });
    expect(validateOperationInput(OPERATIONS.SNAPSHOT, { tabId: 'tab_1' })).toEqual({
      tabId: 'tab_1',
    });
    for (const input of [
      { query: '' },
      { query: 'x'.repeat(201) },
      { query: {} },
      { elementOffset: 250 },
      { elementOffset: 250, navigationId: 3 },
      { elementOffset: 250, documentId: 'document_test' },
      { documentId: '' },
      { documentId: 'x'.repeat(81) },
      { textOffset: 12000 },
      { elementOffset: -1, navigationId: 3 },
      { textOffset: 1.5, navigationId: 3 },
      { textOffset: '12000', navigationId: 3 },
      { textOffset: 1_000_001, navigationId: 3 },
      { navigationId: -1 },
      { navigationId: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() =>
        validateOperationInput(OPERATIONS.SNAPSHOT, { tabId: 'tab_1', ...input })
      ).toThrow();
    }
  });

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
    `freedom-preview://${'a'.repeat(40)}/index.html`,
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

  test('accepts only one bounded attachment, workspace, or text source for Swarm publishing', () => {
    expect(
      validateOperationInput(OPERATIONS.SWARM_PUBLISH, {
        resourceId: 'folder_aaaaaaaaaaaaaaaaaaaa',
        indexDocument: 'site/index.html',
      })
    ).toEqual({
      resourceId: 'folder_aaaaaaaaaaaaaaaaaaaa',
      indexDocument: 'site/index.html',
    });
    expect(
      validateOperationInput(OPERATIONS.SWARM_PUBLISH, {
        workspacePath: '.',
        indexDocument: 'index.html',
      })
    ).toEqual({
      workspacePath: '.',
      indexDocument: 'index.html',
    });
    expect(
      validateOperationInput(OPERATIONS.SWARM_PUBLISH, {
        workspacePath: 'dist/site',
      })
    ).toEqual({ workspacePath: 'dist/site' });
    expect(
      validateOperationInput(OPERATIONS.SWARM_PUBLISH, {
        text: 'hello',
      })
    ).toEqual({
      text: 'hello',
      contentType: 'text/plain; charset=utf-8',
    });
    expect(() =>
      validateOperationInput(OPERATIONS.SWARM_PUBLISH, {
        resourceId: '/Users/example/private-folder',
      })
    ).toThrow('attached file or folder');
    expect(() =>
      validateOperationInput(OPERATIONS.SWARM_PUBLISH, {
        resourceId: 'folder_aaaaaaaaaaaaaaaaaaaa',
        text: 'ambiguous',
      })
    ).toThrow('exactly one');
    expect(() =>
      validateOperationInput(OPERATIONS.SWARM_PUBLISH, {
        resourceId: 'folder_aaaaaaaaaaaaaaaaaaaa',
        workspacePath: '.',
      })
    ).toThrow('exactly one');
    expect(() =>
      validateOperationInput(OPERATIONS.SWARM_PUBLISH, {
        workspacePath: '../outside',
      })
    ).toThrow('safe relative path');
    expect(() =>
      validateOperationInput(OPERATIONS.SWARM_PUBLISH, {
        workspacePath: '.git/config',
      })
    ).toThrow('protected workspace metadata');
    expect(() =>
      validateOperationInput(OPERATIONS.SWARM_PUBLISH, {
        resourceId: 'folder_aaaaaaaaaaaaaaaaaaaa',
        indexDocument: '../index.html',
      })
    ).toThrow('safe relative path');
    expect(
      validateOperationInput(OPERATIONS.SWARM_PUBLICATION_STATUS, {
        publicationId: 'swarm_pub_aaaaaaaaaaaaaaaaaaaaaaaa',
      })
    ).toEqual({ publicationId: 'swarm_pub_aaaaaaaaaaaaaaaaaaaaaaaa' });
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
    [
      'wrong IPFS transport',
      { service: 'ipfs', transport: 'http', request: { method: 'GET', path: '/' } },
    ],
    [
      'mutating IPFS gateway request',
      { service: 'ipfs', transport: 'gateway', request: { method: 'POST', path: '/ipfs/bafy' } },
    ],
    [
      'unsupported service',
      { service: 'tor', transport: 'http', request: { method: 'GET', path: '/' } },
    ],
    [
      'absolute URL',
      { service: 'ant', transport: 'http', request: { method: 'GET', path: 'https://evil.test/' } },
    ],
    [
      'authority path',
      { service: 'ant', transport: 'http', request: { method: 'GET', path: '//evil.test/' } },
    ],
    [
      'authorization header',
      {
        service: 'ant',
        transport: 'http',
        request: { method: 'GET', path: '/', headers: { authorization: 'secret' } },
      },
    ],
    [
      'GET body',
      { service: 'ant', transport: 'http', request: { method: 'GET', path: '/', body: 'x' } },
    ],
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
    expect(() => validateOperationInput(OPERATIONS.APP_DIAGNOSTICS, { maxBytes: 65_537 })).toThrow(
      'maxBytes must be an integer'
    );
  });
});


describe('scroll input bounds', () => {
  test('requires an observed reference and applies bounded page defaults', () => {
    expect(validateOperationInput(OPERATIONS.SCROLL, { tabId: 'tab_1', ref: 'ref_1', direction: 'down' }))
      .toEqual({ tabId: 'tab_1', ref: 'ref_1', direction: 'down', pages: 1 });
    expect(() => validateOperationInput(OPERATIONS.SCROLL, { tabId: 'tab_1', direction: 'down' })).toThrow();
  });
  test.each([0, -1, 3.1, Infinity, NaN, '1', true])('rejects invalid pages %s', pages => {
    expect(() => validateOperationInput(OPERATIONS.SCROLL, { tabId: 'tab_1', ref: 'ref_1', direction: 'down', pages })).toThrow();
  });
  test('rejects arbitrary wheel events or directions', () => {
    expect(() => validateOperationInput(OPERATIONS.SCROLL, { tabId: 'tab_1', ref: 'ref_1', direction: 'diagonal' })).toThrow();
  });
});


test.each(['', ' '.repeat(4), 'x'.repeat(201), 42])('rejects invalid rendered-text search %j', textQuery => {
  expect(() => validateOperationInput(OPERATIONS.SNAPSHOT, { tabId: 'tab_1', textQuery })).toThrow();
});


test('element waits accept named states without selectors or arbitrary predicates', () => {
  expect(validateOperationInput(OPERATIONS.WAIT, { tabId: 'tab_1', condition: 'element', ref: 'ref_1', state: 'enabled', timeoutMs: 1500 }))
    .toEqual({ tabId: 'tab_1', condition: 'element', ref: 'ref_1', state: 'enabled', timeoutMs: 1500 });
  for (const input of [{ state: 'enabled' }, { ref: 'ref_1' }, { ref: 'ref_1', state: 'javascript' }]) {
    expect(() => validateOperationInput(OPERATIONS.WAIT, { tabId: 'tab_1', condition: 'element', ...input })).toThrow();
  }
});

test('visual targeting requires a capture handle and bounded full-image coordinates, without caller authorization', () => {
  const input = { tabId: 'tab_1', captureRef: 'capture_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', x: 0.25, y: 0.75 };
  expect(validateOperationInput(OPERATIONS.TARGET_POINT, { ...input, expectedVisualAction: { visual: true }, script: 'click()' })).toEqual(input);
  for (const override of [{ x: -0.1 }, { x: 1 }, { y: NaN }, { y: Infinity }, { x: '0.5' }, { captureRef: 'guessed' }])
    expect(() => validateOperationInput(OPERATIONS.TARGET_POINT, { ...input, ...override })).toThrow();
});
