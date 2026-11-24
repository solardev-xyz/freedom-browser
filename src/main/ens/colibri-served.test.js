/**
 * fc-colibri's served rule, ported (`colibri-served.js`): #279's unit cases
 * (`crates/fc-colibri`, `block_forms`), `freedom-colibrid`'s own
 * (`served.rs`, `methods` and `block_forms`), and the refusal texts
 * freedom-core's COL-1 recording names for the forms the service refuses
 * (F-1, F-11, F-12 and the unbound forms; skipped without the vectors, see
 * `test/helpers/colibri-vectors.js`).
 */

const {
  COLIBRI_SERVED_METHODS,
  COLIBRI_UNPROVEN_METHODS,
  COLIBRI_BLOCK_PARAM,
  COLIBRI_LATEST_ONLY,
  COLIBRI_NOT_A_STRING,
  colibriRequestParams: ask,
  colibriLatestAppended,
  colibriServiceRefusal: check,
} = require('./colibri-served');
const { colibriVectors, colibriVectorsRequired } = require('../../../test/helpers/colibri-vectors');

const AS_SENT = { kind: 'as-sent' };
const LATEST_APPENDED = { kind: 'latest-appended' };
const refused = (why) => ({ kind: 'refused', why });
const notAString = refused(COLIBRI_NOT_A_STRING);
// A JSON escape, built here so no tool or editor decodes it first.
const BACKSLASH = String.fromCharCode(92);

describe("#279's block forms (fc-colibri block_forms)", () => {
  const hash = `"0x${'22'.repeat(32)}"`;
  const sixteen = `"0x1${'0'.repeat(15)}"`;
  const seventeen = `"0x1${'0'.repeat(16)}"`;
  const upperXHash = `"0X${'22'.repeat(32)}"`;
  // A method's params with `value` at its block parameter.
  const withValue = (at, value) => {
    const params = new Array(at + 1).fill('"0xabc"');
    params[at] = value;
    return params;
  };
  const text = (params) => `[${params.join(',')}]`;
  const atBlock = (value) => refused(`at block ${value}`);

  test.each(COLIBRI_BLOCK_PARAM.map(([method, at]) => [method, at]))(
    '%s (block at %i)',
    (method, at) => {
      const latestOnly = COLIBRI_LATEST_ONLY.includes(method);
      expect(latestOnly).toBe(method !== 'eth_getBlockByNumber');
      // Each string form, and whether eth_getBlockByNumber is Colibri's at
      // it; an account read is only at `latest`.
      for (const [value, byNumber] of [
        ['"0x10d4f00"', true],
        ['"0x10D4F00"', true],
        [sixteen, true],
        ['"0x0"', true],
        [hash, true],
        ['"latest"', true],
        ['"safe"', false],
        ['"finalized"', false],
        ['"justified"', false],
        ['"pending"', false],
        ['"earliest"', false],
        ['"0X10d4f00"', false],
        ['"1x10d4f00"', false],
        [upperXHash, false],
        ['"0x010d4f00"', false],
        [seventeen, false],
        ['"0x"', false],
        ['"0x10g"', false],
      ]) {
        const served = latestOnly ? value === '"latest"' : byNumber;
        expect([value, ask(method, text(withValue(at, value)))]).toEqual([
          value,
          served ? AS_SENT : atBlock(value),
        ]);
      }
      // A tag one place off is not the block: an account read with params
      // after its block is refused, a block read is Colibri's.
      const after = [...withValue(at, '"latest"'), '"pending"'];
      expect(ask(method, text(after))).toEqual(
        latestOnly ? refused(`with params of length ${at + 2}`) : AS_SENT
      );
      // Anything there that isn't a string: EIP-1898's objects first.
      for (const other of [
        '{"blockHash":"0x1111111111111111111111111111111111111111111111111111111111111111","requireCanonical":true}',
        '{"blockNumber":"0x10d4f00"}',
        'null',
        '16',
        'true',
        '["latest"]',
      ]) {
        expect([other, ask(method, text(withValue(at, other)))]).toEqual([other, notAString]);
      }
      // Without the block parameter: `latest` appended for an account read,
      // as sent for a block.
      const without = withValue(at, '"latest"').slice(0, at);
      expect(ask(method, text(without))).toEqual(latestOnly ? LATEST_APPENDED : AS_SENT);
      // Shorter still: nowhere to append it.
      if (at > 0) {
        expect(ask(method, text(without.slice(0, at - 1)))).toEqual(
          refused(`with params of length ${at - 1}`)
        );
      }
    }
  );

  test('the calls have no block rule: Colibri serves neither', () => {
    for (const method of ['eth_call', 'eth_estimateGas']) {
      expect(COLIBRI_BLOCK_PARAM.some(([name]) => name === method)).toBe(false);
      expect(COLIBRI_LATEST_ONLY).not.toContain(method);
      expect(COLIBRI_SERVED_METHODS).not.toContain(method);
      expect(COLIBRI_UNPROVEN_METHODS).toContain(method);
    }
  });

  test('exact strings only, compared after JSON decoding, in an array', () => {
    expect(ask('eth_getBalance', '["0xabc","LATEST"]')).toEqual(atBlock('"LATEST"'));
    expect(ask('eth_getBalance', '["0xabc","latest "]')).toEqual(atBlock('"latest "'));
    expect(ask('eth_getBalance', `["0xabc","lat${BACKSLASH}u0065st"]`)).toEqual(AS_SENT);
    expect(ask('eth_getBlockByNumber', `["pend${BACKSLASH}u0069ng",false]`)).toEqual(
      atBlock('"pending"')
    );
    expect(ask('eth_getBlockByNumber', '["PENDING",false]')).toEqual(atBlock('"PENDING"'));
    expect(ask('eth_getBlockByNumber', '["LATEST",false]')).toEqual(atBlock('"LATEST"'));
    expect(ask('eth_getBlockByNumber', '["0x10d4f00 ",false]')).toEqual(atBlock('"0x10d4f00 "'));
    for (const params of ['{"1":"latest"}', '"safe"', 'null']) {
      expect(ask('eth_getBalance', params)).toEqual(refused("with params that aren't an array"));
      // Null is `[]` to Colibri: `latest`.
      expect(ask('eth_getBlockByNumber', params)).toEqual(
        params === 'null' ? AS_SENT : refused("with params that aren't an array")
      );
    }
    expect(ask('eth_getBalance', 'not json')).toEqual(AS_SENT);
  });

  test('eth_getBlockByHash: a 32-byte hash only', () => {
    const byHash = (first) => ask('eth_getBlockByHash', `[${first},false]`);
    expect(byHash(hash)).toEqual(AS_SENT);
    expect(byHash(`"0x${'AB'.repeat(32)}"`)).toEqual(AS_SENT);
    for (const other of [
      `"0x${'22'.repeat(31)}"`,
      `"0x${'2'.repeat(63)}g"`,
      `"0X${'22'.repeat(32)}"`,
      '"0x10d4f00"',
      '"latest"',
      '"safe"',
      '"finalized"',
      '"justified"',
    ]) {
      expect([other, byHash(other)]).toEqual([other, atBlock(other)]);
    }
    expect(byHash('{"blockHash":"0x1"}')).toEqual(notAString);
    for (const params of ['[]', '{}', 'null']) {
      expect(ask('eth_getBlockByHash', params)).toEqual(refused('without a block hash'));
    }
  });

  test('methods that take no block parameter Colibri reads are asked as sent', () => {
    for (const method of ['eth_getTransactionReceipt', 'eth_blockNumber', 'eth_getLogs']) {
      expect(ask(method, '["pending","pending","pending"]')).toEqual(AS_SENT);
    }
  });

  test('the params Colibri is then asked with', () => {
    expect(colibriLatestAppended('["0xabc"]')).toBe('["0xabc","latest"]');
    expect(colibriLatestAppended('[]')).toBe('["latest"]');
    expect(colibriLatestAppended('[{"to":"0xabc","data":"0x1"}]')).toBe(
      '[{"to":"0xabc","data":"0x1"},"latest"]'
    );
    expect(colibriLatestAppended('{}')).toBeNull();
  });
});

describe("the service's check (freedom-colibrid served.rs)", () => {
  test('every served method, in a served form, is served', () => {
    for (const method of COLIBRI_SERVED_METHODS) {
      const params = {
        eth_getStorageAt: '["0xabc","0x0","latest"]',
        eth_getBalance: '["0xabc","latest"]',
        eth_getCode: '["0xabc","latest"]',
        eth_getTransactionCount: '["0xabc","latest"]',
        eth_getBlockByHash: `["0x${'22'.repeat(32)}",false]`,
        eth_getBlockByNumber: '["latest",false]',
      }[method];
      expect([method, check(method, params ?? '[]')]).toEqual([method, null]);
    }
  });

  test("a method outside the list gets the C core's own text (F-1, F-11 and the rest)", () => {
    for (const method of [
      'eth_gasPrice',
      'eth_feeHistory',
      'eth_call',
      'eth_estimateGas',
      'eth_getLogs',
      'eth_sendRawTransaction',
      'eth_chainId',
      '',
    ]) {
      expect(check(method, '[]')).toBe(`Method ${method} is not supported`);
    }
  });

  test("a block form outside #279's gets #279's text", () => {
    expect(check('eth_getBalance', '["0xabc","safe"]')).toBe(
      'Colibri cannot prove eth_getBalance at block "safe"'
    );
    // The service doesn't append `latest`.
    expect(check('eth_getBalance', '["0xabc"]')).toBe(
      'Colibri cannot prove eth_getBalance with params of length 1'
    );
    expect(check('eth_getStorageAt', '["0xabc","0x0"]')).toBe(
      'Colibri cannot prove eth_getStorageAt with params of length 2'
    );
    expect(check('eth_getBlockByNumber', '["pending",false]')).toBe(
      'Colibri cannot prove eth_getBlockByNumber at block "pending"'
    );
    expect(check('eth_getBlockByHash', '[]')).toBe(
      'Colibri cannot prove eth_getBlockByHash without a block hash'
    );
    expect(
      check('eth_getBlockByNumber', '[{"blockHash":"0x1","requireCanonical":true},false]')
    ).toBe("Colibri cannot prove eth_getBlockByNumber at a block that isn't a string");
    // A lone surrogate stays one.
    expect(check('eth_getBlockByNumber', `["${BACKSLASH}ud800",false]`)).toBe(
      `Colibri cannot prove eth_getBlockByNumber at block "${String.fromCharCode(0xd800)}"`
    );
    // No block, `null`: Colibri's `latest`.
    expect(check('eth_getBlockByNumber', 'null')).toBeNull();
    expect(check('eth_getBlockByNumber', '[]')).toBeNull();
  });
});

// Named outright (CI does): they must be there, so these suites can't skip.
(colibriVectorsRequired ? test : test.skip)(
  'the vectors FREEDOM_CORE_COLIBRI_VECTORS names are there',
  () => {
    expect(colibriVectors).not.toBeNull();
  }
);

(colibriVectors ? describe : describe.skip)("the COL-1 recording's refusal texts", () => {
  const refusals = (colibriVectors?.cases ?? []).filter((entry) => entry.design?.refused);
  const served = (colibriVectors?.cases ?? []).filter(
    (entry) => entry.kind === 'request' && !entry.design?.refused
  );

  test('each form the service refuses gets the text the recording names', () => {
    expect(refusals.length).toBeGreaterThan(0);
    for (const entry of refusals) {
      expect(entry.requests).toHaveLength(1);
      const [{ method, params }] = entry.requests;
      expect([entry.id, check(method, JSON.stringify(params))]).toEqual([
        entry.id,
        entry.design.refused,
      ]);
    }
  });

  test('F-1, F-11 and F-12 are among them, on both chains', () => {
    const ids = new Set(refusals.map((entry) => entry.id));
    for (const chain of [1, 100]) {
      for (const id of [
        'gas-price',
        'fee-history',
        'call-scripted-code',
        'estimate-scripted-code',
        'unbound-block-0X10',
        'unbound-block-1x10',
        'unbound-balance-no-block',
      ]) {
        expect(ids).toContain(`${chain}-${id}`);
      }
    }
  });

  test('every other request case is served', () => {
    expect(served.length).toBeGreaterThan(0);
    for (const entry of served) {
      for (const { method, params } of entry.requests) {
        expect([entry.id, method, check(method, JSON.stringify(params))]).toEqual([
          entry.id,
          method,
          null,
        ]);
      }
    }
  });
});
