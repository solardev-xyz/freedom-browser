/**
 * OpenLV protocol integration test — the REAL @openlv stack, both roles.
 *
 * Freedom's host role (what the renderer broker runs) talks to a
 * simulated phone (the openlv client role, answering wallet JSON-RPC
 * with a real test key) through a local MQTT broker started in-test, so
 * the full spec surface is exercised deterministically and offline:
 * URI encode/decode, the five-step signaling handshake, symmetric →
 * peer-key encryption, and correlated request/response envelopes.
 *
 * Node has no RTCPeerConnection, so the WebRTC transport phase is
 * replaced by a minimal in-spec relay transport that carries the
 * session envelopes through the (already end-to-end encrypted)
 * signaling channel. WebRTC itself runs in the Playwright E2E tests,
 * where both peers are real Chromium contexts.
 */

const { Wallet, verifyMessage, verifyTypedData, getBytes } = require('ethers');

const { createSession, connectSession } = require('@openlv/session');
const { encodeConnectionURL } = require('@openlv/core');
const { mqtt } = require('@openlv/signaling/mqtt');

const { startLocalMqttBroker } = require('../../../../../../test/helpers/local-mqtt-broker');

// The openlv mqtt layer uses the browser's WebSocket global, which Node
// only ships from v22 — polyfill from `ws` (already a dependency) so
// the suite runs on Node 20 (CI) too.
globalThis.WebSocket ??= require('ws').WebSocket;

jest.setTimeout(30000);

// Anvil/Hardhat-default test key — well-known, never funded on mainnet.
const TEST_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const phoneWallet = new Wallet(TEST_PRIVATE_KEY);

// ---------------------------------------------------------------------------
// Relay transport: session envelopes ride the encrypted signaling channel
// ---------------------------------------------------------------------------

function relayTransport() {
  const { EventEmitter } = require('eventemitter3');

  return ({ isHost, subsend, onmessage }) => {
    const emitter = new EventEmitter();
    let connected = false;
    let stopped = false;

    const setConnected = () => {
      if (connected) return;
      connected = true;
      emitter.emit('state_change', 'connected');
    };

    return {
      type: 'relay',
      emitter,
      // The host re-offers until the client answers — its signaling can
      // reach the encrypted state a beat before the client's does.
      setup: async () => {
        if (!isHost) return;
        for (let i = 0; i < 40 && !connected && !stopped; i++) {
          await subsend({ type: 'offer', payload: 'relay' });
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      },
      teardown: async () => {
        stopped = true;
      },
      send: async (message) => {
        // App traffic tunnels as a "candidate" negotiation frame — the
        // only free-form payload carrier in the transport message set.
        await subsend({ type: 'candidate', payload: JSON.stringify(message) });
      },
      handle: async (message) => {
        if (message.type === 'offer') {
          await subsend({ type: 'answer', payload: 'relay' });
          setConnected();
        } else if (message.type === 'answer') {
          setConnected();
        } else if (message.type === 'candidate') {
          onmessage(JSON.parse(message.payload));
        }
      },
      waitFor: async () => {},
    };
  };
}

// ---------------------------------------------------------------------------
// Simulated phone: openlv client role + wallet JSON-RPC over a test key
// ---------------------------------------------------------------------------

const FAKE_TX_HASH = '0x' + '5a'.repeat(32);

function createPhoneHandler(receivedRequests) {
  return async (payload) => {
    receivedRequests.push(payload);
    const { method, params } = payload;
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return { result: [phoneWallet.address] };
      case 'personal_sign':
        return { result: await phoneWallet.signMessage(getBytes(params[0])) };
      case 'eth_signTypedData_v4': {
        const typed = JSON.parse(params[1]);
        const types = { ...typed.types };
        delete types.EIP712Domain;
        return { result: await phoneWallet.signTypedData(typed.domain, types, typed.message) };
      }
      case 'eth_sendTransaction':
        return { result: FAKE_TX_HASH };
      default:
        return { error: { code: -32601, message: 'Method not found' } };
    }
  };
}

// ---------------------------------------------------------------------------

describe('openlv protocol round-trip (real stack, local broker)', () => {
  let broker;
  let hostSession;
  let phoneSession;
  let receivedRequests;
  let relayedFrames;

  const send = (message) => hostSession.send(message, 10000, 15000);

  beforeAll(async () => {
    // The @openlv packages log every protocol step unconditionally.
    jest.spyOn(console, 'log').mockImplementation(() => {});

    broker = await startLocalMqttBroker();
    relayedFrames = [];
    broker.aedes.on('publish', (packet) => {
      // Ignore aedes' internal $SYS topics.
      if (!packet.topic.startsWith('$SYS')) {
        relayedFrames.push(packet.payload.toString('utf8'));
      }
    });

    receivedRequests = [];

    // Freedom's role: host a session, hand out the URI (the QR content).
    hostSession = await createSession(
      { p: 'mqtt', s: broker.url },
      mqtt,
      [relayTransport()],
      async () => ({ error: { code: -32601, message: 'Method not found' } }),
    );
    const uri = encodeConnectionURL(hostSession.getHandshakeParameters());
    expect(uri).toMatch(/^openlv:\/\/[A-Za-z0-9_-]{16}@1\?/);

    // The phone's role: decode the URI and join.
    phoneSession = await connectSession(uri, createPhoneHandler(receivedRequests), [relayTransport()]);

    await hostSession.connect();
    await phoneSession.connect();
    await hostSession.waitForLink();
  });

  afterAll(async () => {
    await Promise.allSettled([hostSession?.close(), phoneSession?.close()]);
    await broker?.close();
  });

  test('discovers the phone account over eth_requestAccounts', async () => {
    const { result } = await send({ method: 'eth_requestAccounts', params: [] });
    expect(result).toEqual([phoneWallet.address]);
  });

  test('personal_sign round-trips and the signature verifies', async () => {
    const message = Buffer.from('freedom openlv test', 'utf8');
    const { result } = await send({
      method: 'personal_sign',
      params: ['0x' + message.toString('hex'), phoneWallet.address],
    });
    expect(verifyMessage(message, result)).toBe(phoneWallet.address);
  });

  test('eth_signTypedData_v4 round-trips and the signature verifies', async () => {
    const domain = { name: 'Freedom Test', version: '1', chainId: 100 };
    const types = {
      Payment: [
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
    };
    const message = { to: phoneWallet.address, amount: '42' };
    const payload = {
      domain,
      primaryType: 'Payment',
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
        ],
        ...types,
      },
      message,
    };

    const { result } = await send({
      method: 'eth_signTypedData_v4',
      params: [phoneWallet.address, JSON.stringify(payload)],
    });
    expect(verifyTypedData(domain, types, message, result)).toBe(phoneWallet.address);
  });

  test('eth_sendTransaction round-trips the phone-reported hash', async () => {
    const { result } = await send({
      method: 'eth_sendTransaction',
      params: [{ from: phoneWallet.address, to: phoneWallet.address, value: '0x1', chainId: '0x64' }],
    });
    expect(result).toBe(FAKE_TX_HASH);
    const sent = receivedRequests.find((r) => r.method === 'eth_sendTransaction');
    expect(sent.params[0]).toMatchObject({ from: phoneWallet.address, chainId: '0x64' });
  });

  test('unknown methods come back as JSON-RPC errors, not hangs', async () => {
    const { error } = await send({ method: 'eth_selfdestruct', params: [] });
    expect(error).toMatchObject({ code: -32601 });
  });

  test('the relay never sees plaintext: every frame is role-addressed ciphertext', () => {
    expect(relayedFrames.length).toBeGreaterThan(0);
    for (const frame of relayedFrames) {
      // Spec wire format: <prefix h|x><recipient h|c><base64 ciphertext>
      expect(frame).toMatch(/^[hx][hc][A-Za-z0-9+/=]+$/);
    }
    const everything = relayedFrames.join('\n');
    // Neither the signed message nor any signature ever crossed in the clear.
    expect(everything).not.toContain('freedom openlv test');
    expect(everything).not.toContain('personal_sign');
    expect(everything).not.toContain(phoneWallet.address);
  });
});
