/**
 * Messaging Service
 *
 * PSS (point-to-point) and GSOC (topic broadcast) primitives for the
 * page-facing window.swarm messaging extension. Runs in the main process
 * only; provider-ipc owns permission checks.
 *
 * Sends and identity go through bee-js. The subscribe WebSockets are
 * hand-rolled on the Node-native WebSocket (Electron main, Node >= 22)
 * instead of bee-js's pssSubscribe/gsocSubscribe because bee-js discards
 * the close code and reason — and the Ant node signals "lurker slots
 * full" via close code 1013 (AGAIN) with a reason string, which we must
 * distinguish from a transient network close.
 *
 * Subscription liveness policy (per messaging SWIP "MUST document"):
 * an established subscription that loses its socket reconnects with
 * exponential backoff (1s..30s) until cancelled — messages published
 * while disconnected are silently missed (best-effort delivery). A
 * refusal close (1013) before the subscription is established rejects
 * the subscribe call; after establishment it is retried like any other
 * close, since slots free up as other subscriptions close.
 *
 * Delivery is at-least-once and payload-transparent: every frame the node
 * pushes is relayed to the page as-is. We deliberately do NOT suppress
 * byte-identical payloads — at the wire level a redelivery and a genuine
 * repeat (an empty PSS keep-alive ping, a second "ok" in a GSOC chat) are
 * indistinguishable, so dropping one would silently swallow the other.
 * Applications that need exactly-once semantics carry their own message
 * id, as the messaging SWIP requires.
 */

const { Topic, Identifier, Bytes } = require('@ethersphere/bee-js');
const { getBee, selectBestBatch, toHex } = require('./swarm-service');
const log = require('electron-log');

// GSOC topic → address derivation (Freedom profile v1).
//
//   identifier    = keccak256(utf8(topic))
//   targetOverlay = keccak256(utf8('freedom-gsoc-v1:' + topic))
//   signer        = gsocMine(targetOverlay, identifier, GSOC_PROXIMITY)
//   address       = SOC address of (identifier, signer) = keccak256(identifier ‖ owner)
//
// gsocMine is deterministic (fixed nonce start, sequential search), so every
// participant passing the same topic to this provider converges on the same
// signer and address. Changing any constant here breaks address stability for
// existing rooms — treat this block as frozen once shipped. Cross-provider
// convergence is not guaranteed by the SWIP; interop across implementations
// exchanges the resolved `address` out of band.
const GSOC_TARGET_CONTEXT = 'freedom-gsoc-v1:';
const GSOC_PROXIMITY = 12; // bee-js default; ~4k keccak attempts worst case

// Ant enforces 4096 − 3×32 = 4000 bytes of usable PSS/GSOC payload
// (ant-crypto MAX_PAYLOAD_SIZE). We relay payloads unframed, so the
// provider-facing limit is the same.
const MAX_MESSAGE_BYTES = 4000;
// PSS mining-prefix depth, in bytes. Two bounds, per the messaging SWIP's
// "PSS mining depth" section:
//  - MAX (3): Ant's hard cap (ant-crypto MAX_TARGET_LEN) — sender mining is
//    ~2^(8·depth) hashes, so 3 bytes caps the work.
//  - DEFAULT (2, = L=16): the network interop convention. Ant's receiver
//    (PSS_MINED_PREFIX_BITS = 16) assumes senders mine 2 bytes; a deeper
//    prefix would cost the sender ~256× per extra byte with no benefit at
//    light-node residency, so directed sends target 2 bytes.
//  - MIN (2): also the storability floor — below the network storage depth
//    (~12 bits) a trojan is not retained by any storer, so 1-byte targets
//    are rejected.
const MAX_TARGET_DEPTH = 3;
const DEFAULT_TARGET_DEPTH = 2;

// A subscription is "established" if the socket stays open this long —
// the node refuses (close 1013) quickly after the upgrade when the
// lurker pool is exhausted, and sends nothing on success.
const ESTABLISH_GRACE_MS = 500;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
// WS close code the Ant gateway uses for "lurker slots full, try later".
const WS_CLOSE_TRY_AGAIN = 1013;

// topic → { identifier, signer, address } — mining is deterministic, so
// this is a pure cache to avoid re-mining on every send/subscribe. Topics
// are page-controlled: bound the cache (eviction just costs a re-mine).
const GSOC_CACHE_MAX = 128;
const gsocDerivationCache = new Map();

function keccakOfUtf8(text) {
  return Bytes.keccak256(Buffer.from(text, 'utf-8')).toUint8Array();
}

/**
 * Derive the GSOC coordinates for a topic (cached).
 * @param {string} topic
 * @returns {{ identifier: Identifier, signer: import('@ethersphere/bee-js').PrivateKey, address: string }}
 */
function deriveGsoc(topic) {
  const cached = gsocDerivationCache.get(topic);
  if (cached) return cached;

  const bee = getBee();
  const identifier = new Identifier(keccakOfUtf8(topic));
  const targetOverlay = keccakOfUtf8(GSOC_TARGET_CONTEXT + topic);
  const signer = bee.gsocMine(targetOverlay, identifier, GSOC_PROXIMITY);
  const address = toHex(
    bee.calculateSingleOwnerChunkAddress(identifier, signer.publicKey().address())
  );

  const derivation = { identifier, signer, address };
  if (gsocDerivationCache.size >= GSOC_CACHE_MAX) {
    gsocDerivationCache.delete(gsocDerivationCache.keys().next().value);
  }
  gsocDerivationCache.set(topic, derivation);
  return derivation;
}

/**
 * Resolve the wire topic hex for a PSS topic string (bee `NewTopic`
 * semantics — keccak of the string, as bee-js Topic.fromString does).
 * @param {string} topic
 * @returns {string} 64-char hex
 */
function resolvePssTopicHex(topic) {
  return Topic.fromString(topic).toHex();
}

/**
 * The node's messaging identity. The PSS key is node-global (the Ant
 * lurker decrypts with the node key), so callers must treat it as
 * bee-wallet-mode: identical across origins.
 * @returns {Promise<{ pssPublicKey: string, overlay: string }>}
 */
async function getMessagingIdentity() {
  const bee = getBee();
  const addresses = await bee.getNodeAddresses();
  return {
    pssPublicKey: addresses.pssPublicKey.toCompressedHex().replace(/^0x/, ''),
    overlay: toHex(addresses.overlay),
  };
}

async function selectMessageBatch() {
  // Messages are ephemeral: a full mutable batch (rolling stamp window)
  // is an acceptable fallback here, unlike for content publishes.
  const batchId = await selectBestBatch(4096, { allowFullMutable: true });
  if (!batchId) {
    throw new Error('No usable postage batch available. Purchase stamps first.');
  }
  return batchId;
}

/**
 * Send an encrypted point-to-point PSS message.
 * @param {{ topic: string, targets: string, recipient: string, data: string|Buffer }} params
 */
async function sendPss({ topic, targets, recipient, data }) {
  const bee = getBee();
  const batchId = await selectMessageBatch();
  await bee.pssSend(batchId, Topic.fromString(topic), targets, data, recipient);
  log.info(`[MessagingService] PSS message sent: topic=${topic}, target=${targets}`);
}

/**
 * Broadcast a GSOC message on a topic.
 * @param {{ topic: string, data: string|Buffer }} params
 * @returns {Promise<{ address: string }>}
 */
async function sendGsoc({ topic, data }) {
  const bee = getBee();
  const { identifier, signer, address } = deriveGsoc(topic);
  const batchId = await selectMessageBatch();
  await bee.gsocSend(batchId, signer, identifier, data);
  log.info(`[MessagingService] GSOC message sent: topic=${topic}, address=${address}`);
  return { address };
}

function wsBaseUrl() {
  const bee = getBee();
  return bee.url.replace(/^http/, 'ws').replace(/\/$/, '');
}

function toPayloadBuffer(wsData) {
  if (wsData instanceof ArrayBuffer) return Buffer.from(wsData);
  if (Buffer.isBuffer(wsData) || wsData instanceof Uint8Array) return Buffer.from(wsData);
  return Buffer.from(String(wsData), 'utf-8');
}

/**
 * Open a long-lived subscription socket to the node.
 *
 * @param {{ kind: 'gsoc'|'pss', key: string }} target - `key` is the 64-hex
 *   GSOC/SOC address (gsoc) or the 64-hex hashed topic (pss).
 * @param {{ onMessage: (payload: Buffer) => void }} handlers
 * @returns {{ established: Promise<void>, cancel: () => void }}
 */
function openSubscriptionSocket({ kind, key }, { onMessage }) {
  const path = kind === 'gsoc' ? `/gsoc/subscribe/${key}` : `/pss/subscribe/${key}`;
  const url = `${wsBaseUrl()}${path}`;

  let cancelled = false;
  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_BASE_DELAY_MS;

  let resolveEstablished;
  let rejectEstablished;
  const established = new Promise((resolve, reject) => {
    resolveEstablished = resolve;
    rejectEstablished = reject;
  });
  // Teardown paths (cancel, page close) reject this promise with nobody
  // awaiting it — that must not surface as an unhandled rejection.
  established.catch(() => {});
  let isEstablished = false;

  const connect = () => {
    if (cancelled) return;
    // Node-native WHATWG WebSocket (Electron main >= Node 22). It answers
    // the node's keep-alive pings automatically.
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    let graceTimer = null;

    ws.onopen = () => {
      graceTimer = setTimeout(() => {
        graceTimer = null;
        reconnectDelay = RECONNECT_BASE_DELAY_MS;
        if (!isEstablished) {
          isEstablished = true;
          resolveEstablished();
        }
      }, ESTABLISH_GRACE_MS);
    };

    ws.onmessage = (event) => {
      const payload = toPayloadBuffer(event.data);
      try {
        onMessage(payload);
      } catch (err) {
        log.error(`[MessagingService] Subscription message handler failed: ${err.message}`);
      }
    };

    // 'close' always follows 'error'; reconnect/reject logic lives there.
    ws.onerror = () => {};

    ws.onclose = (event) => {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      if (cancelled) return;

      const { code, reason } = event;
      if (!isEstablished && code === WS_CLOSE_TRY_AGAIN) {
        // Node refused the subscription (lurker pool exhausted).
        const err = new Error(reason || 'Node subscription limit reached');
        err.reason = 'node_subscription_limit';
        rejectEstablished(err);
        cancelled = true;
        return;
      }

      // Transient close (node restart, network) — reconnect with backoff.
      // Pre-establishment this also covers "node not reachable yet": the
      // establish promise stays pending until provider-ipc's own timeout.
      log.warn(
        `[MessagingService] Subscription socket closed (${kind}:${key}, code=${code}${reason ? `, ${reason}` : ''}); reconnecting in ${reconnectDelay}ms`
      );
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
    };
  };

  connect();

  return {
    established,
    cancel: () => {
      cancelled = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (!isEstablished) {
        const err = new Error('Subscription cancelled');
        err.reason = 'cancelled';
        rejectEstablished(err);
      }
      if (ws && ws.readyState !== 3 /* CLOSED */) {
        try {
          ws.close(1000);
        } catch {
          // already closing
        }
      }
    },
  };
}

// Exported for testing
function _resetGsocCache() {
  gsocDerivationCache.clear();
}

module.exports = {
  getMessagingIdentity,
  deriveGsoc,
  resolvePssTopicHex,
  sendPss,
  sendGsoc,
  openSubscriptionSocket,
  MAX_MESSAGE_BYTES,
  MAX_TARGET_DEPTH,
  DEFAULT_TARGET_DEPTH,
  _resetGsocCache,
};
