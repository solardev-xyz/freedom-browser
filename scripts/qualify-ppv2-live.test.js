const { assertReadMethod } = require('./qualify-ppv2-live');

test('the live qualification reads transaction receipts', () => {
  expect(() => assertReadMethod('eth_getTransactionReceipt')).not.toThrow();
  for (const method of ['eth_chainId', 'eth_getBlockByNumber', 'eth_call', 'eth_getLogs'])
    expect(() => assertReadMethod(method)).not.toThrow();
});

test.each([
  'eth_sendRawTransaction',
  'eth_sendTransaction',
  'eth_sign',
  'eth_signTransaction',
  'eth_estimateGas',
  'eth_getTransactionCount',
  'eth_getTransactionByHash',
  'debug_traceTransaction',
  '',
  undefined,
])('the live qualification refuses %p', (method) => {
  expect(() => assertReadMethod(method)).toThrow('Live qualification cannot submit transactions');
});
