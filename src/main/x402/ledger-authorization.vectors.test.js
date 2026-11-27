/**
 * Main's rebuild of a Ledger payment's x402 authorization
 * (ledger-authorization.js; freedom-core design 0016, "x402 from a Ledger
 * account", L5, D10; LDG-3's PR 3) against the pinned core's vectors:
 *
 * - `vectors/ledger.json`'s three x402 cases (over `@x402/evm` 2.29.0, the
 *   lockfile's): each rebuilt from the case's entry, `now_s`, nonce and
 *   record equals the case's typed data and hash, its recorded signature
 *   recovers to the record over main's rebuild, and the installed package
 *   builds the same typed data and, around that signature, the case's
 *   payload byte for byte.
 * - `vectors/approvals.json`'s x402 cases (0012's X402-1, over 2.28.0): each
 *   device case's typed data rebuilt, each payload case's signature made over
 *   main's rebuild, and each refused case either refused by the rebuild with
 *   its reason or one of the payment policy's refusals, which stay the
 *   core's (the rebuild then builds what the package's scheme hands its
 *   signer).
 * - `vectors/ledger-grammar.json`'s `x402_changes` (99): each form's
 *   authorization with one thing changed, the other form's schema among
 *   them, each refused by main's rebuild before the first APDU.
 *
 * Found as the other vector suites find theirs: FREEDOM_CORE_LEDGER_VECTORS
 * names freedom-core's `vectors` directory (as CI does, at the pinned
 * commit, and then the files must be there), or it is FREEDOM_CORE_VECTORS's
 * directory, or the one in the freedom-core checkout FREEDOM_CORED_PATH was
 * built in. Skipped when not found.
 */

const fs = require('fs');
const path = require('path');
const { TypedDataEncoder, Wallet, verifyTypedData } = require('ethers');
const { x402EvmBuild } = require('../../../test/helpers/x402-evm-reference');
const {
  FORMS,
  REFUSALS,
  rebuildLedgerAuthorization,
  checkLedgerAuthorization,
  nonceOf,
} = require('./ledger-authorization');

function vectorsDir() {
  if (process.env.FREEDOM_CORE_LEDGER_VECTORS) return process.env.FREEDOM_CORE_LEDGER_VECTORS;
  if (process.env.FREEDOM_CORE_VECTORS) return path.dirname(process.env.FREEDOM_CORE_VECTORS);
  const binary = process.env.FREEDOM_CORED_PATH;
  if (!binary) return null;
  for (let dir = path.dirname(path.resolve(binary)); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'vectors');
    if (fs.existsSync(path.join(candidate, 'ledger.json'))) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

const dir = vectorsDir();
const required = Boolean(process.env.FREEDOM_CORE_LEDGER_VECTORS);
const FILES = ['ledger.json', 'ledger-grammar.json', 'approvals.json'];

function load(name) {
  const file = dir && path.join(dir, name);
  return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

const ledger = load('ledger.json');
const grammar = load('ledger-grammar.json');
const approvals = load('approvals.json');

(required ? test : test.skip)('the vectors FREEDOM_CORE_LEDGER_VECTORS names are there', () => {
  for (const name of FILES) expect(fs.existsSync(path.join(dir, name))).toBe(true);
});

const describeIf = (value) => (value ? describe : describe.skip);

/** The form an entry is paid in, as the package routes it. */
function formOf(x402Version, accept) {
  if (x402Version === 1) return FORMS.EIP3009_V1;
  return accept?.extra?.assetTransferMethod === 'permit2' ? FORMS.PERMIT2 : FORMS.EIP3009;
}

/** The core's 32 random bytes (hex) as the form writes its nonce. */
function formNonce(form, hex) {
  const bytes32 = `0x${hex.replace(/^0x/, '')}`;
  return form === FORMS.PERMIT2 ? BigInt(bytes32).toString() : bytes32;
}

const hashOf = (typedData) =>
  TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message);

const LEDGER_CASES = ledger ? ledger.cases.filter((c) => c.family === 'x402') : [];

/** Main's inputs for a ledger.json x402 case. */
function ledgerInput(c) {
  const { version, requirements, now_s: nowS, nonce } = c.x402;
  return {
    x402Version: version,
    accept: requirements,
    from: c.record.address,
    nowS,
    nonce: formNonce(formOf(version, requirements), nonce),
  };
}

describeIf(ledger)("ledger.json's x402 cases", () => {
  test('are the three forms', () => {
    expect(LEDGER_CASES.map((c) => c.id)).toEqual([
      'x402-eip3009-v2',
      'x402-eip3009-v1',
      'x402-permit2-v2',
    ]);
  });

  test.each(LEDGER_CASES.map((c) => [c.id, c]))(
    '%s: main rebuilds the case typed data',
    (_id, c) => {
      const input = ledgerInput(c);
      const result = checkLedgerAuthorization({ ...input, authorization: c.request.typed_data });
      expect(result).toMatchObject({
        accepted: true,
        form: formOf(input.x402Version, input.accept),
      });
      expect(result.typedData).toEqual(c.request.typed_data);
      expect(hashOf(result.typedData)).toBe(c.request.expected_hash);
      expect(nonceOf(c.request.typed_data)).toBe(input.nonce);
    }
  );

  test.each(LEDGER_CASES.map((c) => [c.id, c]))(
    "%s: the recorded signature is over main's rebuild, and @x402/evm builds the case payload around it",
    async (_id, c) => {
      const input = ledgerInput(c);
      const { typedData } = rebuildLedgerAuthorization(input);
      const { signature } = JSON.parse(c.result.payload).payload;
      expect(verifyTypedData(typedData.domain, typedData.types, typedData.message, signature)).toBe(
        c.record.address
      );
      const reference = await x402EvmBuild({
        x402Version: input.x402Version,
        accept: input.accept,
        address: c.record.address,
        nowS: input.nowS,
        nonceHex: c.x402.nonce,
        sign: () => signature,
      });
      expect(JSON.stringify(reference.typedData)).toBe(JSON.stringify(typedData));
      expect(JSON.stringify(reference.payload)).toBe(c.result.payload);
    }
  );
});

const X402 = approvals?.x402;

/** Main's inputs for an approvals.json x402 case (a payload's or a device's). */
function approvalsInput(c, from) {
  const { x402Version } = c.requirements;
  const accept = c.requirements.accepts[c.accept_index];
  return {
    x402Version,
    accept,
    from,
    nowS: c.now,
    nonce: formNonce(formOf(x402Version, accept), c.nonce),
  };
}

// The approvals reference's refused payments (`js.error`), each refused by
// main's rebuild with its reason, as the core refuses it at
// `x402.authorize`...
const FORM_REFUSALS = {
  'v2-amount-hex': REFUSALS.AMOUNT,
  'v2-amount-decimal': REFUSALS.AMOUNT,
  'v2-amount-negative': REFUSALS.AMOUNT,
  'v2-asset-upper-x': REFUSALS.ASSET,
  'v2-network-padded': REFUSALS.NETWORK,
  'v2-network-solana': REFUSALS.NETWORK,
  'v2-scheme-other': REFUSALS.SCHEME,
  'v2-no-version': REFUSALS.DOMAIN,
  'v2-extra-null': REFUSALS.DOMAIN,
  'v2-name-not-string': REFUSALS.DOMAIN,
  'v2-version-not-string': REFUSALS.DOMAIN,
  'v2-timeout-fraction': REFUSALS.TIMEOUT,
  'v2-pay-to-invalid': REFUSALS.PAY_TO,
  'v1-polygon': REFUSALS.NETWORK,
};
// ...or by the payment's policy, which is the core's alone (`x402.authorize`
// refuses it before any typed data exists): the rebuild has a form to build.
const POLICY_REFUSALS = {
  'v2-amount-over-limit': "the client's $1 limit",
  'v2-asset-not-default': "the client's default assets",
  'v2-network-not-default': "the client's default assets",
  'v2-flow-unknown': 'an unknown paymentFlow',
  'v2-runway-19': 'the 20 s runway',
  'v1-runway-19': 'the 20 s runway',
};

describeIf(X402)("approvals.json's x402 cases", () => {
  const devices = X402 ? X402.devices : [];
  const payloads = X402 ? X402.payloads.filter((c) => c.js.payload) : [];
  const refused = X402 ? X402.payloads.filter((c) => c.js.error) : [];

  test('has device, payload and refused cases', () => {
    expect(devices.length).toBeGreaterThan(0);
    expect(payloads.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
  });

  test.each(devices.map((c) => [c.id, c]))(
    '%s: main rebuilds the typed data the package handed its signer',
    (_id, c) => {
      const authorization = JSON.parse(c.typedData);
      const result = checkLedgerAuthorization({ ...approvalsInput(c, c.address), authorization });
      expect(result.accepted).toBe(true);
      expect(result.typedData).toEqual(authorization);
      expect(hashOf(result.typedData)).toBe(c.hash);
    }
  );

  test.each(payloads.map((c) => [c.id, c]))(
    "%s: the payload's signature is the signer's over main's rebuild",
    async (_id, c) => {
      const input = approvalsInput(c, c.signer.address);
      const result = rebuildLedgerAuthorization(input);
      expect(result.ok).toBe(true);
      const { domain, types, message } = result.typedData;
      const signature = await new Wallet(c.signer.privateKey).signTypedData(domain, types, message);
      const inner = JSON.parse(c.js.payload).payload;
      expect(signature).toBe(inner.signature);
      const authorization = inner.authorization ?? inner.permit2Authorization;
      expect(authorization.from).toBe(c.signer.address);
      const reference = await x402EvmBuild({
        x402Version: input.x402Version,
        accept: input.accept,
        address: c.signer.address,
        nowS: c.now,
        nonceHex: c.nonce,
      });
      expect(JSON.stringify(reference.typedData)).toBe(JSON.stringify(result.typedData));
    }
  );

  test('each refused case is a form refusal or the core policy', () => {
    const ids = refused.map((c) => c.id).sort();
    expect(ids).toEqual([...Object.keys(FORM_REFUSALS), ...Object.keys(POLICY_REFUSALS)].sort());
    for (const c of refused) expect(c.core).toBe('refused');
  });

  test.each(refused.filter((c) => FORM_REFUSALS[c.id]).map((c) => [c.id, c]))(
    '%s: refused by the rebuild',
    (_id, c) => {
      const input = approvalsInput(c, c.signer.address);
      expect(rebuildLedgerAuthorization(input)).toEqual({ ok: false, reason: FORM_REFUSALS[c.id] });
    }
  );

  test.each(
    refused.filter((c) => POLICY_REFUSALS[c.id]).map((c) => [c.id, POLICY_REFUSALS[c.id], c])
  )(
    "%s (%s, the core's): the rebuild builds what the package's scheme hands its signer",
    async (_id, _policy, c) => {
      const input = approvalsInput(c, c.signer.address);
      const result = rebuildLedgerAuthorization(input);
      expect(result.ok).toBe(true);
      const reference = await x402EvmBuild({
        x402Version: input.x402Version,
        accept: input.accept,
        address: c.signer.address,
        nowS: c.now,
        nonceHex: c.nonce,
      });
      expect(JSON.stringify(reference.typedData)).toBe(JSON.stringify(result.typedData));
    }
  );
});

const CHANGES = grammar ? grammar.x402_changes : [];
const OTHER_SCHEMA = "the other form's schema for the same accept entry";

describeIf(grammar && ledger)("ledger-grammar.json's x402_changes", () => {
  const caseOf = (change) => LEDGER_CASES.find((c) => c.id === change.case);

  test('are 99: 29 for each EIP-3009 form, 41 for Permit2, the other schema in each', () => {
    expect(CHANGES).toHaveLength(99);
    const count = (id) => CHANGES.filter((change) => change.case === id).length;
    expect(count('x402-eip3009-v2')).toBe(29);
    expect(count('x402-eip3009-v1')).toBe(29);
    expect(count('x402-permit2-v2')).toBe(41);
    expect(
      CHANGES.filter((change) => change.change === OTHER_SCHEMA).map((change) => change.case)
    ).toEqual(['x402-eip3009-v2', 'x402-eip3009-v1', 'x402-permit2-v2']);
    for (const change of CHANGES) {
      expect(change.refused_by).toBe("main's rebuild, before the first APDU");
      expect(caseOf(change)).toBeDefined();
    }
  });

  test.each(CHANGES.map((change) => [change.case, change.change, change]))(
    '%s, %s: refused',
    (_id, _what, change) => {
      const c = caseOf(change);
      // A real change: its typed data hashes as the vector says, not as the case.
      expect(hashOf(change.typed_data)).toBe(change.hash);
      expect(change.hash).not.toBe(c.request.expected_hash);
      expect(
        checkLedgerAuthorization({ ...ledgerInput(c), authorization: change.typed_data })
      ).toEqual({ accepted: false, reason: REFUSALS.MISMATCH });
    }
  );

  test('with the nonce read from the core typed data, as sign-flow reads it, only a changed nonce passes', () => {
    // The nonce is the one value main takes from the core (design 0016): a
    // changed one is only another nonce the core could have drawn. Every
    // other change is still refused.
    const passed = [];
    for (const change of CHANGES) {
      const c = caseOf(change);
      const result = checkLedgerAuthorization({
        ...ledgerInput(c),
        nonce: nonceOf(change.typed_data),
        authorization: change.typed_data,
      });
      if (result.accepted) passed.push(`${change.case}: ${change.change}`);
      else expect([REFUSALS.MISMATCH, REFUSALS.NONCE]).toContain(result.reason);
    }
    expect(passed).toEqual([
      'x402-eip3009-v2: message.nonce',
      'x402-eip3009-v1: message.nonce',
      'x402-permit2-v2: message.nonce',
    ]);
  });
});
