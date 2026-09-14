const { circuitIds } = require('./qualify-wallet-tor');
test('keeps the complete Arti circuit identifier, including channel and circuit numbers', () => {
  const log = ['Got a circuit for [scrubbed]:443 tunnel_id=Circ 2.0',
    'Got a circuit for [scrubbed]:443 tunnel_id=Circ 2.1',
    'Got a circuit for [scrubbed]:443 tunnel_id=Circ 2.2'].join('\n');
  expect(circuitIds(log)).toEqual(['Circ 2.0', 'Circ 2.1', 'Circ 2.2']);
  expect(circuitIds('Got a circuit for [scrubbed]:443 tunnel_id=changed-format')).toEqual([]);
});
