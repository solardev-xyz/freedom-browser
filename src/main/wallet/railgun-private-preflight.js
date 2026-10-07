/** Main-only anchored private-spend prerequisites. Input binding is data, not
 * ownership authority. Querying an unspent nullifier discloses it to the RPC;
 * callers must use only the explicitly selected operation input and transport.
 */
const { Interface } = require('ethers');
const { isProxy } = require('util').types;
const { getPrivacyContext, createPrivacyScope } = require('../networks/privacy-context');
const { createPrivateRpc } = require('../networks/private-rpc');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const {
  createRailgunShieldPreflight,
  assertRailgunShieldPreflight,
  MAX_AGE_MS,
} = require('./railgun-shield-preflight');
const { loadRailgunArtifacts, assertRailgunArtifactVerifier } = require('./railgun-artifacts');
const pins = require('./railgun-shield-pins.json');
const abi = new Interface([
  'function rootHistory(uint256,bytes32) view returns (bool)',
  'function nullifiers(uint256,bytes32) view returns (bool)',
  'function unshieldFee() view returns (uint120)',
  'function getVerificationKey(uint256,uint256) view returns ((string artifactsIPFSHash,(uint256 x,uint256 y) alpha1,(uint256[2] x,uint256[2] y) beta2,(uint256[2] x,uint256[2] y) gamma2,(uint256[2] x,uint256[2] y) delta2,(uint256 x,uint256 y)[] ic))',
]);
// Matched by the October 3 Sepolia deployment qualification. A changed fee
// requires a reviewed policy change, never silent acceptance during signing.
const UNSHIELD_FEE_BPS = 25;
// Closed deployment sub-steps of railgun-shield-preflight.js, forwarded as a
// refusal diagnostic only. Anything else is dropped, never echoed.
const DEPLOYMENT_STEPS = Object.freeze([
  'anchor',
  'code-proxy',
  'code-relayAdapt',
  'code-wrappedNative',
  'code-implementation',
  'slot-implementation',
  'slot-paused',
  'getter-railgun',
  'getter-wBase',
  'getter-shieldFee',
  'getter-tokenBlocklist',
  'anchor-recheck',
]);
// Closed TOR_REQUEST_FAILED stages from wallet-tor-transport.js, forwarded as
// a refusal diagnostic only. Anything else is dropped, never echoed. A stage
// never proves non-delivery and authorizes nothing, a retry included.
const CAUSE_STAGES = Object.freeze([
  'connect',
  'tls',
  'socket-new',
  'socket-reused',
  'response',
  'unclassified',
]);
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const sources = new WeakMap();
// Own data properties only: no getter or proxy trap runs on a foreign error.
const own = (value, key) => {
  if (!value || typeof value !== 'object' || isProxy(value)) return;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};
const fail = (reason = 'refused') =>
  Object.assign(new Error('Railgun private preflight unavailable'), {
    code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
    reason,
  });
const check = (v, reason) => {
  if (!v) throw fail(reason);
};
const hash = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
const quantity = (v) => typeof v === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v);
function selection(input) {
  check(
    input &&
      !Array.isArray(input) &&
      Object.keys(input).sort().join(',') ===
        'checkpointHash,merkleRoot,minimumBlock,nullifier,tree'
  );
  check(Number.isSafeInteger(input.tree) && input.tree >= 0 && input.tree <= 65535);
  check(Number.isSafeInteger(input.minimumBlock) && input.minimumBlock >= 0);
  check(typeof input.checkpointHash === 'string' && /^[0-9a-f]{64}$/.test(input.checkpointHash));
  for (const key of ['merkleRoot', 'nullifier'])
    check(hash(input[key]) && BigInt(input[key]) < FIELD);
  return Object.freeze({
    tree: input.tree,
    merkleRoot: input.merkleRoot,
    nullifier: input.nullifier,
    checkpointHash: input.checkpointHash,
    minimumBlock: input.minimumBlock,
  });
}
function createPreflight(options, relay = false) {
  check(options && !isProxy(options) && Object.getPrototypeOf(options) === Object.prototype);
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const required = ['enrollment', 'input', 'artifactDirectory'];
  const allowed = [...required, 'destinationConstraint', 'intentKind', 'admissionDeadline'];
  check(required.every((key) => Object.hasOwn(descriptors, key)));
  check(Reflect.ownKeys(descriptors).every((key) => allowed.includes(key)));
  for (const descriptor of Object.values(descriptors))
    check(Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
  const { enrollment, input, artifactDirectory, destinationConstraint, intentKind } = options;
  // Private spend only: the nullifier admission deadline, a monotonic
  // instant (performance.now()) from which the selected nullifier's request
  // is not admitted to the private RPC transport. It bounds admission, not
  // disclosure: on a reused keep-alive socket the bytes leave on the next
  // tick, but on a new SOCKS+TLS connection they leave only after the Tor
  // stream and TLS handshake, so the nullifier can leave after the deadline
  // by that connect time. A recovered submission whose late read outruns its
  // tail then refuses at its budget check before any EOA request: the
  // nullifier was disclosed, nothing is sent. Data, not authority: it can
  // only refuse earlier, and receipt ages are unchanged.
  const admissionDeadline = options.admissionDeadline;
  check(
    !Object.hasOwn(descriptors, 'admissionDeadline') ||
      (!relay && Number.isFinite(admissionDeadline))
  );
  check(
    !Object.hasOwn(descriptors, 'intentKind') ||
      (!relay &&
        ['railgun-private-transfer', 'railgun-token-unshield', 'railgun-partial-unshield'].includes(
          intentKind
        ))
  );
  // Snapshot one closed circuit choice before any asynchronous deployment or
  // artifact work; the same tuple selects local artifacts and the chain getter.
  const partial = intentKind === 'railgun-partial-unshield';
  const circuit = Object.freeze({
    variant: partial || relay ? '01x02' : '01x01',
    inputs: 1,
    outputs: partial || relay ? 2 : 1,
  });
  check(isRailgunAccountEnrollment(enrollment) && !enrollment.signal.aborted);
  if (relay)
    require('./railgun-account-enrollment').assertRailgunFencedAccountEnrollment(enrollment);
  const selected = selection(input);
  check(typeof artifactDirectory === 'string' && require('path').isAbsolute(artifactDirectory));
  const parent = enrollment.getContext(
    'protocol-rpc',
    relay ? 'relay-preflight' : 'private-preflight'
  );
  const context = getPrivacyContext(parent);
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: enrollment.signal,
    isCurrent: () => {
      getPrivacyContext(parent);
      return true;
    },
  });
  const handle = scope.getContext(context.subject);
  let deployment,
    rpc,
    closed = false,
    busy = false,
    sequence = 0;
  const receipts = new WeakMap();
  const close = () => {
    if (closed) return;
    closed = true;
    rpc?.signal.removeEventListener('abort', close);
    deployment?.signal.removeEventListener('abort', close);
    deployment?.close();
    scope.close();
    rpc?.release();
  };
  try {
    deployment = createRailgunShieldPreflight(
      enrollment,
      ...(destinationConstraint !== undefined ? [{ destinationConstraint }] : [])
    );
    rpc = createPrivateRpc(
      handle,
      'protocol-rpc',
      ...(destinationConstraint !== undefined ? [{ destinationConstraint }] : [])
    );
    rpc.signal.addEventListener('abort', close, { once: true });
    deployment.signal.addEventListener('abort', close, { once: true });
    check(!rpc.signal.aborted && !deployment.signal.aborted, 'inactive');
  } catch (error) {
    close();
    throw error;
  }
  const active = () => {
    check(!closed && !enrollment.signal.aborted && !deployment.signal.aborted, 'inactive');
    if (relay)
      require('./railgun-account-enrollment').assertRailgunFencedAccountEnrollment(enrollment);
    getPrivacyContext(handle);
    rpc.assertActive();
  };
  async function acquire() {
    active();
    check(!busy);
    busy = true;
    const serial = ++sequence,
      started = performance.now();
    let artifacts,
      step = 'deployment';
    const fresh = () => {
      const now = performance.now();
      check(now >= started && now - started < MAX_AGE_MS, 'stale');
    };
    try {
      const base = await deployment.acquire();
      const observation = assertRailgunShieldPreflight(deployment, base.receipt, enrollment);
      active();
      fresh();
      const anchor = observation.anchor;
      check(BigInt(anchor.number) >= BigInt(selected.minimumBlock), 'stale');
      const block = { blockHash: anchor.hash, requireCanonical: true };
      step = 'artifacts';
      artifacts = await loadRailgunArtifacts({
        handle: scope.getContext({ ...context.subject, role: 'artifacts' }),
        directory: artifactDirectory,
        variant: circuit.variant,
      });
      active();
      fresh();
      check(artifacts.variant === circuit.variant, 'mismatch');
      const read = async (method, params, validate, admission) => {
        active();
        fresh();
        assertRailgunShieldPreflight(deployment, base.receipt, enrollment);
        let response;
        try {
          response = await rpc.request(
            method,
            params,
            validate,
            ...(admission ? [undefined, admission] : [])
          );
        } catch (error) {
          active();
          // The RPC's own admission gate refused: the request never left.
          if (admission && error?.code === 'PRIVATE_RPC_ADMISSION_EXPIRED') throw fail('stale');
          const stage = own(error, 'stage');
          throw Object.assign(fail('rpc'), {
            causeCode: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code ?? '')
              ? error.code
              : 'UNCLASSIFIED',
            ...(own(error, 'code') === 'TOR_REQUEST_FAILED' && CAUSE_STAGES.includes(stage)
              ? { causeStage: stage }
              : {}),
          });
        }
        active();
        fresh();
        check(validate(response.result), 'rpc');
        return response.result;
      };
      const getter = async (name, args, expected, admission) => {
        step = name;
        const encoded = await read(
          'eth_call',
          [{ to: pins.proxy, data: abi.encodeFunctionData(name, args) }, block],
          hash,
          admission
        );
        const value = abi.decodeFunctionResult(name, encoded);
        check(abi.encodeFunctionResult(name, value).toLowerCase() === encoded, 'mismatch');
        check(value[0] === expected, 'mismatch');
      };
      await getter('rootHistory', [selected.tree, selected.merkleRoot], true);
      await getter('unshieldFee', [], BigInt(UNSHIELD_FEE_BPS));
      step = 'verifier';
      const encoded = await read(
        'eth_call',
        [
          {
            to: pins.proxy,
            data: abi.encodeFunctionData('getVerificationKey', [circuit.inputs, circuit.outputs]),
          },
          block,
        ],
        (v) => typeof v === 'string' && /^0x(?:[0-9a-f]{2})+$/.test(v) && v.length <= 32768
      );
      try {
        assertRailgunArtifactVerifier(artifacts, encoded);
      } catch {
        active();
        throw fail('mismatch');
      }
      // Expose the selected nullifier only after deployment, fee, root and
      // verifier checks succeed; it can link this query to a later spend.
      // The caller's admission deadline is checked here as an early refusal,
      // but the read's own checks, the RPC's awaited chain-check promise and
      // its serialization still run before the transport. The RPC therefore
      // enforces the same deadline again at its last admission gate, for
      // this one request only; the anchor recheck after it is not bounded.
      step = 'nullifiers';
      check(admissionDeadline === undefined || performance.now() < admissionDeadline, 'stale');
      const admission = admissionDeadline === undefined ? undefined : { admissionDeadline };
      await getter('nullifiers', [selected.tree, selected.nullifier], false, admission);
      step = 'anchor-recheck';
      const reread = await read(
        'eth_getBlockByNumber',
        [anchor.number, false],
        (v) => v && quantity(v.number) && hash(v.hash) && quantity(v.timestamp)
      );
      check(
        reread.number === anchor.number &&
          reread.hash === anchor.hash &&
          reread.timestamp === anchor.timestamp,
        'stale'
      );
      active();
      fresh();
      assertRailgunShieldPreflight(deployment, base.receipt, enrollment);
      const value = Object.freeze({
        anchor,
        input: selected,
        deploymentMatched: true,
        verifierMatched: true,
        rootAccepted: true,
        inputUnspent: true,
        unshieldFeeBps: UNSHIELD_FEE_BPS,
        trust: 'unverified-rpc',
        ownershipVerified: false,
        signingEnabled: false,
        ...(partial ? { intentKind: 'railgun-partial-unshield' } : {}),
        ...(relay ? { intentKind: 'railgun-relay-self-transfer' } : {}),
      });
      const receipt = Object.freeze({});
      receipts.set(receipt, { serial, started, base: base.receipt, value });
      return Object.freeze({ receipt, observation: value });
    } catch (error) {
      close();
      const reason = ['rpc', 'stale', 'inactive', 'mismatch'].includes(error.reason)
        ? error.reason
        : 'refused';
      throw Object.assign(fail(reason), {
        step,
        ...(step === 'deployment' &&
        error?.code === 'RAILGUN_SHIELD_DEPLOYMENT_REFUSED' &&
        DEPLOYMENT_STEPS.includes(error.step)
          ? { deploymentStep: error.step }
          : {}),
        ...(reason === 'rpc'
          ? {
              causeCode: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.causeCode ?? '')
                ? error.causeCode
                : 'UNCLASSIFIED',
            }
          : {}),
        ...(reason === 'rpc' && CAUSE_STAGES.includes(own(error, 'causeStage'))
          ? { causeStage: own(error, 'causeStage') }
          : {}),
      });
    } finally {
      artifacts?.wasm.fill(0);
      artifacts?.zkey.fill(0);
      busy = false;
    }
  }
  const assertResult = (receipt, minimumRemainingMs = 0) => {
    active();
    check(
      Number.isSafeInteger(minimumRemainingMs) &&
        minimumRemainingMs >= 0 &&
        minimumRemainingMs < MAX_AGE_MS
    );
    const entry = receipts.get(receipt),
      now = performance.now();
    check(
      entry &&
        !busy &&
        entry.serial === sequence &&
        now >= entry.started &&
        now - entry.started + minimumRemainingMs < MAX_AGE_MS,
      'stale'
    );
    assertRailgunShieldPreflight(deployment, entry.base, enrollment);
    return entry.value;
  };
  const source = Object.freeze({ acquire, assertResult, close, signal: scope.signal });
  sources.set(source, { enrollment, relay });
  return source;
}
function assertRailgunPrivatePreflight(source, receipt, enrollment, minimumRemainingMs = 0) {
  const entry = sources.get(source);
  check(isRailgunAccountEnrollment(enrollment) && entry?.enrollment === enrollment && !entry.relay);
  return source.assertResult(receipt, minimumRemainingMs);
}
function assertRailgunRelayPreflight(source, receipt, enrollment, minimumRemainingMs = 0) {
  const entry = sources.get(source);
  check(isRailgunAccountEnrollment(enrollment) && entry?.enrollment === enrollment && entry.relay);
  require('./railgun-account-enrollment').assertRailgunFencedAccountEnrollment(enrollment);
  return source.assertResult(receipt, minimumRemainingMs);
}
module.exports = {
  createRailgunPrivatePreflight: (options) => createPreflight(options),
  assertRailgunPrivatePreflight,
  createRailgunRelayPreflight: (options) => createPreflight(options, true),
  assertRailgunRelayPreflight,
  MAX_AGE_MS,
};
