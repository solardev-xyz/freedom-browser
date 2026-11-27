/* global jest */
/**
 * `@x402/evm`'s own build of an x402 authorization, the reference main's
 * rebuild (`src/main/x402/ledger-authorization.js`, freedom-core design
 * 0016, LDG-3's PR 3) is held to: the installed package's `ExactEvmScheme`
 * (x402 version 2) or `ExactEvmSchemeV1` (version 1), asked for the payload
 * of one accept entry under a fixed clock (`Date.now`) and nonce
 * (`crypto.getRandomValues`), as freedom-core's generator records its
 * vectors.
 *
 * `x402EvmBuild` answers `{ typedData, payload }`: what the package handed
 * its signer's `signTypedData`, as `JSON.stringify` writes it with each
 * BigInt as its decimal text (the form the core hands main), and the
 * scheme's payload around the signature `sign(typedData)` gave (a dummy one
 * when `sign` is omitted). Use it from a jest suite only: it replaces the
 * clock and the random source while it runs, and restores them after.
 */

const { ExactEvmScheme } = require('@x402/evm/exact/client');
const { ExactEvmSchemeV1 } = require('@x402/evm/exact/v1/client');

const DUMMY_SIGNATURE = `0x${'00'.repeat(65)}`;

function asJson(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, member) =>
      typeof member === 'bigint' ? member.toString() : member
    )
  );
}

/**
 * @param {{
 *   x402Version: 1 | 2,
 *   accept: object,
 *   address: string,       // the signer's address
 *   nowS: number,          // Date.now() / 1000 while the package builds
 *   nonceHex: string,      // the 32 random bytes, hex, with or without 0x
 *   sign?: (typedData: object) => string | Promise<string>,
 * }} input
 */
async function x402EvmBuild({ x402Version, accept, address, nowS, nonceHex, sign }) {
  const bytes = Buffer.from(nonceHex.replace(/^0x/, ''), 'hex');
  if (bytes.length !== 32) throw new Error('x402EvmBuild: the nonce is 32 bytes');
  let typedData = null;
  const signer = {
    address,
    signTypedData: async (request) => {
      typedData = asJson(request);
      return sign ? sign(typedData) : DUMMY_SIGNATURE;
    },
  };
  const scheme = x402Version === 1 ? new ExactEvmSchemeV1(signer) : new ExactEvmScheme(signer);
  const clock = jest.spyOn(Date, 'now').mockReturnValue(nowS * 1000);
  const random = jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
    array.set(bytes);
    return array;
  });
  try {
    const payload = await scheme.createPaymentPayload(x402Version, accept);
    return { typedData, payload };
  } finally {
    clock.mockRestore();
    random.mockRestore();
  }
}

module.exports = { x402EvmBuild };
