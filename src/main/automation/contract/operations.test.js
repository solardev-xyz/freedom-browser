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
  });

  test.each(['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/secret'])(
    'rejects privileged navigation URL %s',
    (url) => {
      expect(() => validateOperationInput(OPERATIONS.NAVIGATE, { tabId: 'tab_1', url })).toThrow(
        'is not allowed'
      );
    }
  );

  test('rejects relative navigation targets and unknown operations', () => {
    expect(() =>
      validateOperationInput(OPERATIONS.NAVIGATE, { tabId: 'tab_1', url: 'example.com' })
    ).toThrow('absolute URL');
    expect(() => validateOperationInput('browser_execute_javascript', {})).toThrow(
      'Unknown automation operation'
    );
  });
});
