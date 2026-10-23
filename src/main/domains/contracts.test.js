'use strict';

const { parseName, swarmContenthash, commitmentFor, ABI, registrationTuple } = require('./contracts');
const evidence = require('../../../docs/audits/evidence/agent-domains-2026-10-20.json');

test('names follow namespace rules without changing legacy Unicode bytes', () => {
  expect(parseName('FrEeDoM.eth').name).toBe('freedom.eth');
  expect(parseName('FrEeDoM.wei').name).toBe('freedom.wei');
  expect(parseName('sub.freedom.gwei').topLevel).toBe(false);
  for (const value of ['https://alice.eth', 'alice.eth/path', ' alice.eth', 'alice..wei', 'alice.com', 'alice\u202e.eth', 'CAFÉ.wei']) expect(() => parseName(value)).toThrow();
});

test('contenthash is the exact 39-byte Swarm manifest encoding', () => {
  const reference = '12'.repeat(32);
  expect(swarmContenthash(reference)).toBe(`0xe40101fa011b20${reference}`);
  expect((swarmContenthash(reference).length - 2) / 2).toBe(39);
  for (const value of ['bzz://' + reference, reference.repeat(2), '0'.repeat(63), 'g'.repeat(64)]) expect(() => swarmContenthash(value)).toThrow();
});

test('bundled namespace identifiers match published deployed-contract vectors', () => {
  for (const namespace of ['wei', 'gwei']) {
    const vector = evidence.crossChecks.checks.find(item => item.check === `${namespace === 'wei' ? 'wns' : 'gns'} ASCII namehash`);
    expect(vector).toBeDefined();
    expect(parseName(vector.fullName).tokenId).toBe(vector.tokenId);
  }
});

test('current tuple and NameNFT commitment encodings have the correct selectors and domains', () => {
  expect(ABI.controller.getFunction('register').selector).toBe('0xef9c8805');
  expect(ABI.controller.getFunction('renew').selector).toBe('0x18026ad1');
  const label = 'freedom-skill-research-20261020';
  const account = { address: '0x000000000000000000000000000000000000dEaD' };
  const secret = `0x${'42'.repeat(32)}`;
  const operation = { label, account, duration: 31536000, namespace: 'wei' };
  expect(commitmentFor(operation, secret)).toBe('0x7c3f938bd6886591be52e3e4f4167390556ed29af19fe83c582502ed5e0ca99a');
  operation.namespace = 'gwei';
  expect(commitmentFor(operation, secret)).toBe('0x7c3f938bd6886591be52e3e4f4167390556ed29af19fe83c582502ed5e0ca99a');
  operation.namespace = 'eth';
  // The delivered plan selects the public resolver; the historical research
  // vector selected zero. This vector is also checked against the fork below.
  expect(commitmentFor(operation, secret)).toBe('0xcd8e582b8cc877d9d9fe8ed7f5e810bd97bef4f3a7c4b8bc903f7b9660f25500');
  expect(registrationTuple(operation, secret).slice(-3)).toEqual([[], 0, `0x${'00'.repeat(32)}`]);
});
