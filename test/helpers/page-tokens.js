'use strict';

/**
 * A page-kind token in hand, as the identity core mints it on an approve
 * answer to its own prompt (freedom-core design 0012, APB-4 and APB-5) and
 * hands main in a `{ send }` or `{ device }`. Main mints none itself since
 * APB-5b removed its issuer, so a test that needs one (a signer presenting
 * it, a device spending it) has the core its file mocks mint it under
 * `page`, as a core before APR-7 still does. Required lazily, so the mocks
 * of the test file that calls it apply.
 *
 * @param {{handle: string, context: object}} page the handle main approved
 *   the core's prompt on, and the request's PageContext
 * @param {object} [options] `chainId` (typed data), `remember` (a dApp send's
 *   "Always allow"), `phone`, `feeAcknowledged`
 */
async function mintPageToken(kind, accountIndex, payload, page, options = {}) {
  const { corePayload } = require('../../src/main/wallet/signing-confirmation');
  const { vaultBackend } = require('../../src/main/core/vault-backend');
  const request = corePayload(kind, accountIndex, payload, {
    chainId: options.chainId,
    remember: kind === 'dapp-send' && options.remember === true,
  });
  const params = { kind, payload: request.payload, handle: page.handle };
  if (request.account !== undefined) params.account = request.account;
  if (options.feeAcknowledged === true) params.fee_ack = true;
  if (options.phone === true) params.phone = true;
  const reply = await vaultBackend.approval.issue(params, page.context);
  const confirmation = { token: reply.token, kind, payload: request.payload, handle: page.handle, page: page.context };
  if (request.account !== undefined) confirmation.account = request.account;
  return typeof reply.hash === 'string' ? { ...confirmation, hash: reply.hash, view: reply.view } : confirmation;
}

module.exports = { mintPageToken };
