/** Strict historical receipt-policy baseline, NOT an inclusion-state proof or
 * runtime/deployment pin. A different treasury requires separate policy review.
 * Two unverified RPC observations: docs/qualification/railgun-sepolia-deployment-2026-10-02.json
 * Report SHA-256: bc5e558e858fcc87c23d9eb00cfc7e09497255e3fe29b090ccfb70cb7ee6036f.
 */
module.exports = Object.freeze({
  id: 'railgun-sepolia-partial-receipt-v1',
  treasury: '0x0dce0fe955222a3ed1b756b1d962dd0a1615e1af',
  observedBlock: 11829346,
  chainId: 11155111,
  trust: 'unverified-rpc',
});
