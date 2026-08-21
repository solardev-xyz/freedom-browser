/**
 * Trust anchor for the Swarm-distributed filter-list update channel (WP5).
 *
 * The publisher (freedom-adblock-service) writes a signed manifest to a Swarm
 * feed owned by a dedicated key. The client reads that feed by (owner, topic)
 * — hardcoded here — so it never has to trust a reference handed to it, only
 * this compiled-in anchor. Two independent checks gate an update:
 *   1. the feed's Single-Owner-Chunk signature (owner = FEED_OWNER_ADDRESS)
 *   2. the manifest's application-level `sig` (signer = MANIFEST_SIG_ADDRESS)
 * Separating them gives key-rotation headroom (see the design note).
 *
 * MANIFEST_SCHEMA / FEED_TOPIC mirror src/manifest.ts in freedom-adblock-service
 * and must stay in sync with it — this pair is a cross-repo contract.
 */

// Kept in lockstep with freedom-adblock-service/src/manifest.ts.
const MANIFEST_SCHEMA = 1;
const FEED_TOPIC = 'freedom/adblock/lists/v1';

// The production publisher's address (key ceremony 2026-07-06; the key lives
// only in the publisher's deployment secrets and the password manager — see
// research/adblock-production-key-ceremony.md). One key currently fills both
// roles; they are pinned separately for key-rotation headroom.
//
// The env overrides let a dev/E2E build point at a test publisher's feed
// without recompiling; production relies on the hardcoded constants.
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const PRODUCTION_PUBLISHER = '0xb818FF019BC15BC3DfbdaD4CE0ab66A6f74e8f1E';
const FEED_OWNER_ADDRESS = process.env.FREEDOM_ADBLOCK_FEED_OWNER || PRODUCTION_PUBLISHER;
const MANIFEST_SIG_ADDRESS = process.env.FREEDOM_ADBLOCK_SIG_ADDRESS || PRODUCTION_PUBLISHER;

/**
 * Whether real publisher-key constants have been compiled in. The update
 * manager must check this and no-op while false.
 */
function isTrustAnchorConfigured() {
  return (
    FEED_OWNER_ADDRESS.toLowerCase() !== ZERO_ADDRESS &&
    MANIFEST_SIG_ADDRESS.toLowerCase() !== ZERO_ADDRESS
  );
}

module.exports = {
  MANIFEST_SCHEMA,
  FEED_TOPIC,
  FEED_OWNER_ADDRESS,
  MANIFEST_SIG_ADDRESS,
  isTrustAnchorConfigured,
};
