/**
 * Feed Service
 *
 * Feed creation and update via bee-js SOC/feeds API.
 * Runs in the main process only — provider-ipc orchestrates calls.
 */

const { PrivateKey, Topic } = require('@ethersphere/bee-js');
const { getBee, selectBestBatch, toHex } = require('./swarm-service');
const log = require('electron-log');

/**
 * Build the topic string for a feed: normalizedOrigin + "/" + feedName.
 * Used by both createFeed and updateFeed to ensure consistent topic derivation.
 * @param {string} normalizedOrigin
 * @param {string} feedName
 * @returns {string}
 */
function buildTopicString(normalizedOrigin, feedName) {
  return `${normalizedOrigin}/${feedName}`;
}

/**
 * Create a feed and its manifest.
 * The manifest provides a stable bzz:// URL that always resolves to the
 * latest feed update.
 *
 * @param {string} signerPrivateKey - 0x-prefixed hex private key
 * @param {string} topicString - Topic string (from buildTopicString)
 * @param {string} [batchId] - Postage batch ID. Auto-selected if omitted.
 * @returns {Promise<{ topic: string, owner: string, manifestReference: string, bzzUrl: string }>}
 */
async function createFeed(signerPrivateKey, topicString, batchId) {
  const bee = getBee();
  const privateKey = new PrivateKey(signerPrivateKey);
  const owner = privateKey.publicKey().address();
  const topic = Topic.fromString(topicString);

  const resolvedBatchId = batchId || await selectBestBatch(4096);
  if (!resolvedBatchId) {
    throw new Error('No usable postage batch available. Purchase stamps first.');
  }

  const manifest = await bee.createFeedManifest(resolvedBatchId, topic, owner);
  const manifestReference = toHex(manifest);

  log.info(`[FeedService] Feed created: topic=${topicString}, owner=${owner.toHex()}`);

  return {
    topic: topic.toHex(),
    owner: owner.toChecksum(),
    manifestReference,
    bzzUrl: `bzz://${manifestReference}`,
  };
}

/**
 * Update a feed to point at a new content reference.
 *
 * @param {string} signerPrivateKey - 0x-prefixed hex private key
 * @param {string} topicString - Topic string (from buildTopicString)
 * @param {string} contentReference - Swarm reference to point the feed at
 * @param {string} [batchId] - Postage batch ID. Auto-selected if omitted.
 * @returns {Promise<{ success: true }>}
 */
async function updateFeed(signerPrivateKey, topicString, contentReference, batchId) {
  const bee = getBee();
  const privateKey = new PrivateKey(signerPrivateKey);
  const topic = Topic.fromString(topicString);

  const resolvedBatchId = batchId || await selectBestBatch(4096);
  if (!resolvedBatchId) {
    throw new Error('No usable postage batch available. Purchase stamps first.');
  }

  const writer = bee.makeFeedWriter(topic, privateKey);
  await writer.upload(resolvedBatchId, contentReference);

  log.info(`[FeedService] Feed updated: topic=${topicString}, ref=${contentReference}`);

  return { success: true };
}

module.exports = {
  buildTopicString,
  createFeed,
  updateFeed,
};
