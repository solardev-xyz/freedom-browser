/**
 * The operation grammar's pieces on their own (swarm-grammar.js,
 * swarm-tree.js, swarm-typed.js; freedom-core design 0015, The operation
 * grammar): the typed-form reader, the rows' lookup, the rules the vectors'
 * scenarios don't reach (the ready check's, open calls, a parent's end, a
 * refused call's aftermath, a body's kind, a feed index past 2^53), and the
 * tree reader's refusals. Runs without the core's vectors;
 * swarm-grammar.vectors.test.js and swarm-tree.vectors.test.js hold the
 * same modules to them.
 */

const {
  Admission,
  FAILED,
  HeadProbe,
  IndexLookup,
  RULES,
  feedUpdateAddress,
  pageTopic,
  requestHeaders,
  rowFor,
} = require('./swarm-grammar');
const {
  MAX_SLOTS,
  Occurrences,
  bmtRoot,
  chunkAddress,
  decodeSpan,
  intermediate,
  maxShards,
  spanBytes,
  wireAddress,
} = require('./swarm-tree');
const { SwarmData, TypedFormError, readTyped, truthy, truthyParam } = require('./swarm-typed');

const KEY = 'https://app.example';
const OWNER = '6fac4d18c912343bf86fa7049364dd4e424ab9c0';

/** A content-addressed chunk: its wire bytes and address. */
function chunk(span, payload) {
  const wire = Buffer.concat([spanBytes(span), payload]);
  return { wire, address: wireAddress(wire) };
}
const leaf = (fill, size) => chunk(size, Buffer.alloc(size, fill));
const over = (span, children) =>
  chunk(span, Buffer.concat(children.map((c) => Buffer.from(c.address, 'hex'))));

const get = (form, path, extra = {}) => ({
  form,
  method: 'GET',
  path,
  query: [],
  headers: [],
  max_bytes: 4201,
  stream: false,
  ...extra,
});
const ok = (body) => ({ status: 200, headers: [], body });

/** A readData parent over `root`, its ready check answered and its root returned. */
function readData(root) {
  const a = new Admission({ row: 'readData', params: { reference: root.address }, key: KEY });
  expect(a.ready('reachable')).toBeNull();
  a.readyAnswered(true);
  const first = a.admit(get('chunk', `/chunks/${root.address}`));
  a.settle(first.ticket, ok(root.wire));
  return a;
}

describe('swarm-typed: the typed form read back', () => {
  test('each tag is the value JavaScript held', () => {
    const value = readTyped({
      object: [
        ['s', { string: 'x' }],
        ['n', { number: '-0' }],
        ['nan', { number: 'NaN' }],
        ['big', { bigint: '18446744073709551615' }],
        ['b', { boolean: false }],
        ['z', { null: true }],
        ['u', { undefined: true }],
        ['a', { array: [{ hole: true }, { number: '1' }] }],
        ['__proto__', { string: 'own' }],
        ['data', { bytes: 3, kind: 'Uint8Array', base64: 'AQID' }],
        ['text', { string_bytes: 0, base64: '' }],
        ['part', { bytes: 70000, kind: 'Buffer', part: 2 }],
        ['elsewhere', { bytes_elsewhere: 2, kind: 'Buffer', base64: 'aGk=' }],
      ],
    });
    expect(value.s).toBe('x');
    expect(Object.is(value.n, -0)).toBe(true);
    expect(value.nan).toBeNaN();
    expect(value.big).toBe(2n ** 64n - 1n);
    expect(value.z).toBeNull();
    expect(Object.hasOwn(value, 'u') && value.u === undefined).toBe(true);
    expect(0 in value.a).toBe(false);
    expect(value.a[1]).toBe(1);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(value.data).toBeInstanceOf(SwarmData);
    expect(value.data.bytes).toStrictEqual(Buffer.from([1, 2, 3]));
    expect(truthy(value.text)).toBe(false);
    expect(value.part).toMatchObject({ length: 70000, part: 2, bytes: null });
    expect(Buffer.isBuffer(value.elsewhere) && String(value.elsewhere)).toBe('hi');
    expect(truthyParam({ owner: '' }, 'owner')).toBeUndefined();
    expect(truthyParam({ owner: OWNER }, 'owner')).toBe(OWNER);
  });

  test('anything outside the form throws', () => {
    for (const typed of [
      null,
      [],
      {},
      { string: 1 },
      { string: 'x', extra: 1 },
      { number: '1.0' },
      { number: ' 1' },
      { bigint: '01' },
      { bigint: '-0' },
      { null: false },
      {
        object: [
          ['k', { null: true }],
          ['k', { null: true }],
        ],
      },
      { object: [['k']] },
      { bytes: 3, kind: 'Uint8Array', base64: 'AQI=' },
      { bytes: 3, kind: 'Float32Array', base64: 'AQID' },
      { bytes: 3, kind: 'Buffer', base64: 'AQID', part: 0 },
      { bytes: 3, kind: 'Buffer', base64: 'AQID==' },
      { bytes_elsewhere: 1, kind: 'Buffer', part: 0 },
      { string_json: '"x"' },
    ]) {
      expect(() => readTyped(typed)).toThrow(TypedFormError);
    }
  });
});

describe('the rows', () => {
  test('rowFor gives each parent its row, and none to a method without one', () => {
    expect(rowFor('swarm_readChunk', {})).toBe('readChunk');
    expect(rowFor('swarm_readFeedEntry', { name: 'x', index: 0 })).toBe('readFeedEntry_index');
    expect(rowFor('swarm_readFeedEntry', { name: 'x', index: null })).toBe('readFeedEntry_latest');
    expect(rowFor('swarm.publish', { kind: 'file' })).toBe('swarm.publish:data,file');
    expect(rowFor('swarm.publish', { kind: 'collection' })).toBe('swarm.publish:collection');
    expect(rowFor('swarm.feed', { op: 'read' })).toBe('swarm.feed:read');
    expect(rowFor('swarm.stamps', {})).toBe('swarm.stamps');
    for (const [method, params] of [
      ['swarm_unsubscribe', {}],
      ['swarm_readFeedEntry_index', {}],
      ['swarm_toString', {}],
      ['swarm.publish', { kind: 'dir' }],
      ['swarm.feed', { op: 'delete' }],
      ['swarm.identities', {}],
    ]) {
      expect(rowFor(method, params)).toBeNull();
    }
    expect(() => new Admission({ row: 'toString', params: {} })).toThrow(/No grammar row/);
  });

  test("failed has stopped, and the rules are the design's", () => {
    expect(FAILED).toContain('stopped');
    expect(RULES).toStrictEqual([
      'form',
      'order',
      'count',
      'value',
      'header',
      'query',
      'body',
      'ended',
    ]);
    expect(requestHeaders({ headers: [['range', 'bytes=0-1']] })).toStrictEqual([
      ['accept', 'application/json, text/plain, */*'],
      ['accept-encoding', 'identity'],
      ['range', 'bytes=0-1'],
    ]);
  });
});

describe('the rules the scenarios leave out', () => {
  const reference = 'ab'.repeat(32);
  const readChunk = () => new Admission({ row: 'readChunk', params: { reference }, key: KEY });
  const call = get('chunk', `/chunks/${reference}`);

  test("the ready check: once, the row's, before any call, and answered ok", () => {
    let a = readChunk();
    expect(a.admit(call)).toStrictEqual({ rule: 'order' });
    a = readChunk();
    expect(a.ready('publish')).toBe('value');
    a = readChunk();
    expect(a.ready('reachable')).toBeNull();
    expect(a.ready('reachable')).toBe('count');
    a = readChunk();
    a.ready('reachable');
    a.readyAnswered(false);
    expect(a.admit(call)).toStrictEqual({ rule: 'order' });
    a = new Admission({ row: 'getUploadStatus', params: { tagUid: 7 } });
    expect(a.ready('reachable')).toBe('form');
  });

  test('one open call at a time, eight under readData', () => {
    const a = new Admission({ row: 'publishData', params: {}, key: KEY });
    a.ready('publish');
    a.readyAnswered(true);
    const first = a.admit(get('stamps', '/stamps', { max_bytes: 1048576 }));
    expect(first.ticket).toBeDefined();
    expect(a.admit(get('stamps', '/stamps', { max_bytes: 1048576 }))).toStrictEqual({
      rule: 'order',
    });

    const leaves = Array.from({ length: 9 }, (_, i) => leaf(i + 1, 4096));
    const tree = readData(over(9 * 4096, leaves));
    const tickets = leaves.slice(0, 8).map((l) => {
      const verdict = tree.admit(
        get('chunk', `/chunks/${l.address}`, { tree: { length: 4096, depth: 1 } })
      );
      expect(verdict.rule).toBeUndefined();
      return verdict.ticket;
    });
    const ninth = get('chunk', `/chunks/${leaves[8].address}`, {
      tree: { length: 4096, depth: 1 },
    });
    const again = readData(over(9 * 4096, leaves));
    for (const l of leaves.slice(0, 8)) {
      again.admit(get('chunk', `/chunks/${l.address}`, { tree: { length: 4096, depth: 1 } }));
    }
    expect(again.admit(ninth)).toStrictEqual({ rule: 'order' });
    tree.settle(tickets[0], ok(leaves[0].wire));
    expect(tree.admit(ninth).rule).toBeUndefined();
  });

  test('after the parent ends, or after a refusal, nothing more is admitted', () => {
    let a = readChunk();
    a.ready('reachable');
    a.readyAnswered(true);
    a.end();
    expect(a.admit(call)).toStrictEqual({ rule: 'ended' });
    expect(a.ready('reachable')).toBe('ended');
    a = readChunk();
    a.ready('reachable');
    a.readyAnswered(true);
    expect(a.admit({ ...call, path: `/chunks/${'cd'.repeat(32)}` })).toStrictEqual({
      rule: 'value',
    });
    expect(a.admit(call)).toStrictEqual({ rule: 'ended' });
  });

  test("a call's form: its method, its path, its stream, and the row's forms", () => {
    const each = (edit) => {
      const a = readChunk();
      a.ready('reachable');
      a.readyAnswered(true);
      return a.admit(edit({ ...call })).rule;
    };
    expect(each((c) => c)).toBeUndefined();
    expect(each((c) => ({ ...c, method: 'POST' }))).toBe('form');
    expect(each((c) => ({ ...c, path: `/chunks/${reference}/x` }))).toBe('form');
    expect(each((c) => ({ ...c, path: `/bytes/${reference}` }))).toBe('form');
    expect(each((c) => ({ ...c, stream: true }))).toBe('form');
    expect(each((c) => ({ ...c, form: 'toString' }))).toBe('form');
    expect(each((c) => ({ ...c, max_bytes: 4202 }))).toBe('body');
    expect(each((c) => ({ ...c, max_bytes: 0 }))).toBe('body');
    expect(each((c) => ({ ...c, body: { base64: '' } }))).toBe('body');
    expect(
      each((c) => ({ ...c, headers: [['accept', 'application/json, text/plain, */*']] }))
    ).toBe('header');
    expect(each((c) => ({ ...c, query: [['a', 'b']] }))).toBe('query');
    expect(each((c) => ({ ...c, tree: { length: 1, depth: 1 } }))).toBe('value');
  });

  test("a body's kind is the row's: base64 for the page's own bytes, a stream for a part", () => {
    const upload = (data, body) => {
      const a = new Admission({
        row: 'publishData',
        params: { data, contentType: 'text/plain' },
        key: KEY,
      });
      a.ready('publish');
      a.readyAnswered(true);
      a.settle(
        a.admit(get('stamps', '/stamps', { max_bytes: 1048576 })).ticket,
        ok(Buffer.from('[]'))
      );
      return a.admit({
        form: 'bzz_file',
        method: 'POST',
        path: '/bzz',
        query: [['name', 'data']],
        headers: [
          ['content-type', 'text/plain'],
          ['swarm-postage-batch-id', 'a1'.repeat(32)],
          ['swarm-pin', 'true'],
          ['swarm-deferred-upload', 'false'],
        ],
        body,
        max_bytes: 65536,
        stream: false,
      }).rule;
    };
    const inline = new SwarmData('Buffer', 2, Buffer.from('hi'), null);
    const part = new SwarmData('Buffer', 70000, null, 0);
    expect(upload(inline, { base64: 'aGk=' })).toBeUndefined();
    expect(upload(inline, { stream: 2 })).toBe('body');
    expect(upload(part, { stream: 70000 })).toBeUndefined();
    expect(upload(part, { stream: 69999 })).toBe('body');
    expect(upload(part, { base64: 'aGk=' })).toBe('body');
    expect(upload(inline, { base64: 'aGk' })).toBe('body');
  });

  test('a feed index past 2^53 − 1 is named by its decimal text', () => {
    const index = 2 ** 60;
    const topic = pageTopic(KEY, 'blog');
    const read = (named) => {
      const a = new Admission({
        row: 'readFeedEntry_index',
        params: { name: 'blog', owner: `0x${OWNER.toUpperCase()}`, index },
        key: KEY,
      });
      a.ready('reachable');
      a.readyAnswered(true);
      const address = feedUpdateAddress(topic, OWNER, BigInt(index));
      return a.admit(get('chunk', `/chunks/${address}`, { feed: { owner: OWNER, index: named } }))
        .rule;
    };
    expect(read(String(2n ** 60n))).toBeUndefined();
    expect(read(index)).toBe('value');
    expect(read('0')).toBe('value');
  });

  test('swarm.stamps: a stamp for its id, the list without one', () => {
    const stamps = (params, c) => {
      const a = new Admission({ row: 'swarm.stamps', params });
      return a.admit(c).rule;
    };
    const id = 'b2'.repeat(32);
    expect(stamps({}, get('stamps', '/stamps', { max_bytes: 1048576 }))).toBeUndefined();
    expect(stamps({}, get('stamp', `/stamps/${id}`, { max_bytes: 65536 }))).toBe('value');
    expect(stamps({ id }, get('stamp', `/stamps/${id}`, { max_bytes: 65536 }))).toBeUndefined();
    expect(stamps({ id }, get('stamps', '/stamps', { max_bytes: 1048576 }))).toBe('value');
  });
});

describe("the tree reader's arithmetic and refusals", () => {
  test("the empty chunk's address, the level byte and Bee's shard counts", () => {
    // An empty file's reference (vectors/dweb-verify.json, file-0).
    expect(chunkAddress(spanBytes(0), Buffer.alloc(0))).toBe(
      'b34ca8c22b9e982354f9c7f50b470d66db428d880c8a904d5fe4ec9713171526'
    );
    expect(bmtRoot(Buffer.alloc(4097))).toBeNull();
    expect(wireAddress(Buffer.alloc(7))).toBeNull();
    const span = spanBytes(8192);
    span[7] = 0x81;
    expect(decodeSpan(span)).toStrictEqual({ level: 1, size: 8192n });
    span[7] = 0x80;
    expect(decodeSpan(span).level).toBe(0);
    expect([0, 1, 2, 3, 4].map(maxShards)).toStrictEqual([128, 119, 107, 97, 39]);
  });

  test('an intermediate the core refuses gives no children', () => {
    const a = leaf(1, 4096);
    expect(intermediate(Buffer.concat([spanBytes(8192), Buffer.alloc(31)]), 8192n)).toBeNull();
    expect(intermediate(Buffer.concat([spanBytes(8192), Buffer.alloc(64)]), 8192n)).toBeNull();
    const many = Buffer.concat(Array.from({ length: 129 }, () => Buffer.from(a.address, 'hex')));
    expect(intermediate(Buffer.concat([spanBytes(8192), many]), 8192n)).toBeNull();
    // A level-4 span over 8,193 bytes asks more parities than its one reference.
    const coded = spanBytes(8193);
    coded[7] = 0x84;
    expect(intermediate(Buffer.concat([coded, Buffer.from(a.address, 'hex')]), 8193n)).toBeNull();
    const occurrences = new Occurrences();
    expect(occurrences.addChildren(Buffer.alloc(40), 8192n, 0)).toBe(false);
    expect(occurrences.slots).toBe(0);
  });

  test('no intermediate at depth 8, no zero-length child, no padding; a leaf at depth 8 is one', () => {
    const leafA = leaf(1, 4096);
    const inner = over(8192, [leafA, leaf(2, 4096)]);
    // A lone-reference wrapper at depth 7: its intermediate child would sit at 8.
    const wrapper = over(8192, [inner]);
    const occurrences = new Occurrences();
    occurrences.addChildren(wrapper.wire, 8192n, 7);
    expect(occurrences.take(inner.address, 8192, 8)).toBe('value');
    // An intermediate's leaves may: one at depth 8.
    occurrences.addChildren(inner.wire, 8192n, 7);
    expect(occurrences.take(leafA.address, 4096, 8)).toBeNull();
    expect(occurrences.take(leafA.address, 4096, 8)).toBe('count');
    // Three references over 4,097 bytes: the third gets no length, and a
    // trailing all-zero reference is padding.
    const padded = Buffer.concat([
      spanBytes(4097),
      Buffer.from(leafA.address, 'hex'),
      Buffer.from(inner.address, 'hex'),
      Buffer.from(inner.address, 'hex'),
      Buffer.alloc(32),
    ]);
    const fresh = new Occurrences();
    fresh.addChildren(padded, 4097n, 0);
    expect(fresh.slots).toBe(2);
    expect(fresh.take('00'.repeat(32), 0, 1)).toBe('value');
    expect(fresh.take(inner.address, 0, 1)).toBe('value');
    expect(fresh.take(inner.address, 1, 1)).toBeNull();
  });

  test(`past ${MAX_SLOTS} slots the tree is refused`, () => {
    const leaves = Array.from({ length: 128 }, (_, i) => leaf(i, 4096));
    const full = over(128 * 4096, leaves);
    const occurrences = new Occurrences();
    let added = 0;
    while (occurrences.addChildren(full.wire, BigInt(128 * 4096), 1) && !occurrences.over)
      added += 1;
    expect(added).toBe(Math.floor(MAX_SLOTS / 128));
    expect(occurrences.take(leaves[0].address, 4096, 2)).toBe('count');
  });
});

// Codex round 1 on #1336: /stamps without a batch, the `stream` member,
// and core-supplied values that must be refused by a rule, never thrown.
describe("main's own writes without a batch: /stamps first", () => {
  const BATCH = 'a1'.repeat(32);
  const GIVEN = 'b2'.repeat(32);
  const TOPIC = 'cd'.repeat(32);
  const post = (form, path, headers, extra = {}) => ({
    form,
    method: 'POST',
    path,
    query: [],
    headers,
    max_bytes: 65536,
    stream: false,
    ...extra,
  });
  const ROWS_WITHOUT_BATCH = {
    'swarm.publish:data,file': {
      params: { kind: 'data', parts: [{ bytes: 1, base64: 'eA==' }], pin: true, deferred: false },
      call: (batch) =>
        post(
          'bzz_file',
          '/bzz',
          [
            ['content-type', 'text/plain'],
            ['swarm-postage-batch-id', batch],
            ['swarm-pin', 'true'],
            ['swarm-deferred-upload', 'false'],
          ],
          { query: [['name', 'data']], body: { base64: 'eA==' } }
        ),
    },
    'swarm.publish:collection': {
      params: {
        kind: 'collection',
        parts: [{ path: 'a.txt', bytes: 1 }],
        pin: true,
        deferred: true,
      },
      call: (batch) =>
        post(
          'bzz_tar',
          '/bzz',
          [
            ['content-type', 'application/x-tar'],
            ['swarm-collection', 'true'],
            ['swarm-postage-batch-id', batch],
            ['swarm-pin', 'true'],
            ['swarm-deferred-upload', 'true'],
          ],
          { body: { stream: 3072 } }
        ),
    },
    'swarm.feed:create': {
      params: { op: 'create', key: { kind: 'bee_wallet' }, topic: TOPIC },
      call: (batch) =>
        post('feed_manifest', `/feeds/${OWNER}/${TOPIC}`, [['swarm-postage-batch-id', batch]]),
    },
    'swarm.feed:update': {
      params: {
        op: 'update',
        key: { kind: 'bee_wallet' },
        topic: TOPIC,
        reference: 'ef'.repeat(32),
      },
      call: () =>
        get('feed_head', `/feeds/${OWNER}/${TOPIC}`, {
          headers: [['swarm-only-root-chunk', 'true']],
        }),
    },
  };

  test.each(Object.keys(ROWS_WITHOUT_BATCH))(
    '%s: a call before /stamps is refused by order',
    (row) => {
      const { params, call } = ROWS_WITHOUT_BATCH[row];
      expect(new Admission({ row, params }).admit(call(BATCH))).toStrictEqual({ rule: 'order' });
      // After the /stamps it is the row's next call.
      const a = new Admission({ row, params });
      const stamps = a.admit(get('stamps', '/stamps', { max_bytes: 1048576 }));
      expect(stamps.rule).toBeUndefined();
      a.settle(stamps.ticket, ok(Buffer.from('[]')));
      expect(a.admit(call(BATCH)).rule).toBeUndefined();
      // With the parent's own batch, the row leaves /stamps out.
      const given = new Admission({ row, params: { ...params, batch: GIVEN } });
      expect(given.admit(call(GIVEN)).rule).toBeUndefined();
    }
  );
});

describe('core-supplied values are refused by a rule, never thrown', () => {
  const topic = pageTopic(KEY, 'blog');
  const big = over(4097, [leaf(1, 4096), leaf(2, 1)]);
  /** A readData parent whose root declares 4,097 bytes, and its stream call. */
  const streamCall = () => ({
    admission: readData(big),
    call: get('bytes', `/bytes/${big.address}`, {
      headers: [['range', 'bytes=0-4096']],
      max_bytes: 4097,
      stream: true,
    }),
  });
  /** A readFeedEntry_index parent whose SOC wraps a 4,097-byte root, and its stream call. */
  const feedStreamCall = () => {
    const wrapped = chunk(4097, Buffer.alloc(64, 7));
    const a = new Admission({
      row: 'readFeedEntry_index',
      params: { name: 'blog', owner: OWNER, index: 0 },
      key: KEY,
    });
    a.ready('reachable');
    a.readyAnswered(true);
    const soc = a.admit(
      get('chunk', `/chunks/${feedUpdateAddress(topic, OWNER, 0n)}`, {
        feed: { owner: OWNER, index: 0 },
      })
    );
    a.settle(soc.ticket, ok(Buffer.concat([Buffer.alloc(97), wrapped.wire])));
    return {
      admission: a,
      call: get('bytes', `/bytes/${wrapped.address}`, { max_bytes: 4097, stream: true }),
    };
  };
  const wholeCall = () => {
    const reference = 'ab'.repeat(32);
    const a = new Admission({ row: 'readChunk', params: { reference }, key: KEY });
    a.ready('reachable');
    a.readyAnswered(true);
    return { admission: a, call: get('chunk', `/chunks/${reference}`) };
  };
  const latestCall = () => {
    const a = new Admission({
      row: 'readFeedEntry_latest',
      params: { name: 'blog', owner: OWNER },
      key: KEY,
    });
    a.ready('reachable');
    a.readyAnswered(true);
    return {
      admission: a,
      call: get('feed_latest', `/feeds/${OWNER}/${topic}`, { max_bytes: 4096, stream: true }),
    };
  };
  const leafCall = () => ({
    admission: readData(big),
    call: get('chunk', `/chunks/${leaf(1, 4096).address}`, { tree: { length: 4096, depth: 1 } }),
  });

  test('each base call is admitted as it stands', () => {
    for (const make of [streamCall, feedStreamCall, wholeCall, latestCall, leafCall]) {
      const { admission, call } = make();
      expect(admission.admit(call).rule).toBeUndefined();
    }
  });

  test('a call without its stream member, whole or streamed, is refused by form', () => {
    for (const make of [wholeCall, streamCall, latestCall]) {
      const { admission, call } = make();
      delete call.stream;
      expect(admission.admit(call)).toStrictEqual({ rule: 'form' });
    }
    const { admission, call } = streamCall();
    expect(admission.admit({ ...call, stream: 'true' })).toStrictEqual({ rule: 'form' });
  });

  const MALFORMED = [
    undefined,
    null,
    1.5,
    'x',
    '4097',
    [],
    [4097],
    {},
    { n: 4097 },
    -1,
    0,
    NaN,
    Infinity,
    2 ** 53,
    true,
  ];

  test('a malformed max_bytes is refused by body, on whole and streamed calls alike', () => {
    for (const make of [streamCall, feedStreamCall, wholeCall, latestCall, leafCall]) {
      for (const max of MALFORMED) {
        const { admission, call } = make();
        if (max === undefined) delete call.max_bytes;
        else call.max_bytes = max;
        expect({ max, verdict: admission.admit(call) }).toStrictEqual({
          max,
          verdict: { rule: 'body' },
        });
      }
    }
  });

  test("a max_bytes past its bound is refused by the bound's rule", () => {
    const past = [
      [wholeCall, 4202, 'body'],
      [latestCall, 5 * 1024 * 1024 + 1, 'body'],
      [streamCall, 4098, 'value'],
      [streamCall, 4096, 'value'],
      [feedStreamCall, 4098, 'value'],
    ];
    for (const [make, max, rule] of past) {
      const { admission, call } = make();
      expect(admission.admit({ ...call, max_bytes: max })).toStrictEqual({ rule });
    }
  });

  const JUNK = [
    undefined,
    null,
    true,
    0,
    -1,
    1.5,
    NaN,
    2 ** 60,
    '',
    'x',
    '1e3',
    '18446744073709551616',
    [],
    [[]],
    [['a']],
    [[1, 2]],
    [['range', 7]],
    {},
    { base64: 5 },
    { base64: 'eA==', stream: 1 },
    { stream: '1' },
    { stream: -1 },
    { length: 'x', depth: [] },
    { length: 2 ** 60, depth: 1 },
    { length: 4096, depth: 1.5 },
    { owner: 5, index: {} },
    { owner: OWNER, index: '0x1' },
    { owner: OWNER, index: -1 },
    { owner: OWNER, index: 2 ** 60 },
  ];
  const MEMBERS = [
    'form',
    'method',
    'path',
    'query',
    'headers',
    'body',
    'max_bytes',
    'stream',
    'feed',
    'tree',
  ];

  test('every member of a call, replaced by junk, gives a rule or an admission, never a throw', () => {
    let refused = 0;
    for (const make of [streamCall, feedStreamCall, wholeCall, latestCall, leafCall]) {
      for (const member of MEMBERS) {
        for (const junk of JUNK) {
          const { admission, call } = make();
          if (junk === undefined) delete call[member];
          else call[member] = junk;
          let verdict;
          expect(() => {
            verdict = admission.admit(call);
          }).not.toThrow();
          if (verdict.rule) {
            expect(RULES).toContain(verdict.rule);
            refused += 1;
          } else {
            expect(verdict.ticket).toBeDefined();
          }
        }
      }
    }
    expect(refused).toBeGreaterThan(1000);
    for (const call of [null, undefined, [], 'x', 7, { form: { toString: () => 'chunk' } }]) {
      const { admission } = wholeCall();
      expect(admission.admit(call)).toStrictEqual({ rule: 'form' });
    }
    const a = new Admission({ row: 'readChunk', params: {}, key: KEY });
    expect(a.ready({})).toBe('value');
  });

  // Values whose primitive conversion throws, or that relational operators refuse.
  const unconvertible = () => ({ toString: 1, valueOf: 1 });
  const throwing = () =>
    Object.defineProperty({}, 'status', {
      enumerable: true,
      get() {
        throw new Error('no status');
      },
    });
  const BAD_STATUS = [
    null,
    undefined,
    'x',
    7,
    throwing(),
    { status: 'x' },
    { status: '200' },
    { status: unconvertible() },
    { status: Symbol('status') },
    { status: 200n },
    { status: [200] },
    { status: 200.5 },
    { status: NaN },
    { status: 99 },
    { status: 600 },
  ];
  const BAD_MEMBERS = [
    { status: 200, headers: {}, body: 'not bytes' },
    { status: 200, headers: 'x', body: [1, 2] },
    { status: 200, headers: { length: 1, 0: ['swarm-feed-index', '0000000000000001'] } },
    { status: 200, headers: [[1, 2], 'x', [Symbol('name'), 'x'], [unconvertible(), 'v']] },
    {
      status: 200,
      headers: [
        ['swarm-feed-index', unconvertible()],
        ['swarm-feed-index-next', Symbol('next')],
      ],
    },
    {
      status: 200,
      headers: [
        ['swarm-feed-index', 'zz'],
        ['swarm-feed-index-next', 7],
      ],
    },
    { status: 200, headers: [], body: unconvertible() },
    { status: 200, headers: [], body: Symbol('body') },
    { status: 200, headers: [], body: 5n },
  ];
  const feedRead = () => {
    const topicHex = 'cd'.repeat(32);
    const head = new Admission({
      row: 'swarm.feed:read',
      params: { op: 'read', key: { kind: 'bee_wallet' }, topic: topicHex },
    });
    const lookup = head.admit(
      get('feed_head', `/feeds/${OWNER}/${topicHex}`, {
        headers: [['swarm-only-root-chunk', 'true']],
      })
    );
    const probe = (index) =>
      get('chunk', `/chunks/${feedUpdateAddress(topicHex, OWNER, BigInt(index))}`, {
        feed: { owner: OWNER, index },
      });
    return { head, lookup, probe };
  };

  test("main's answers are read for their shape: any other is a failed answer, and none throws", () => {
    for (const reply of [...BAD_STATUS, ...BAD_MEMBERS]) {
      const failed = BAD_STATUS.includes(reply);
      // readData's root: no size is read from it, so no stream follows.
      const { admission, call } = streamCall();
      const root = new Admission({ row: 'readData', params: { reference: big.address }, key: KEY });
      root.ready('reachable');
      root.readyAnswered(true);
      const first = root.admit(get('chunk', `/chunks/${big.address}`));
      expect(() => root.settle(first.ticket, reply)).not.toThrow();
      expect(root.admit(call)).toStrictEqual({ rule: 'order' });
      expect(admission.admit(call).rule).toBeUndefined();
      // feed_head: no index from it; only a 404 starts the probe.
      const { head, lookup } = feedRead();
      expect(() => head.settle(lookup.ticket, reply)).not.toThrow();
      expect(head.lookup.writeIndex).toBeUndefined();
      expect(head.lookup.probing).toBe(false);
      // A probe read: a failed answer ends the probe.
      const run = feedRead();
      run.head.settle(run.lookup.ticket, { status: 404, headers: [] });
      const zero = run.head.admit(run.probe(0));
      expect(zero.rule).toBeUndefined();
      expect(() => run.head.settle(zero.ticket, reply)).not.toThrow();
      expect(run.head.lookup.probe.failed).toBe(failed);
      expect(run.head.admit(run.probe(1)).rule).toBe(failed ? 'value' : undefined);
    }
    // HeadProbe and IndexLookup take such values directly as well.
    for (const status of [unconvertible(), Symbol('s'), 200n, [200], '404']) {
      const probe = new HeadProbe();
      probe.asked();
      expect(() => probe.answer(status)).not.toThrow();
      expect(probe.failed).toBe(true);
      const lookup = new IndexLookup({ probeOn: [404] });
      expect(() => lookup.answerHead({ status, headers: [] })).not.toThrow();
      expect(lookup.writeIndex).toBeUndefined();
    }
  });

  test('a page param with no string (an own toString or valueOf that is no function) binds nothing, and throws nothing', () => {
    const unconvertible = readTyped({
      object: [
        ['toString', { string: 'x' }],
        ['valueOf', { string: 'y' }],
      ],
    });
    expect(() => String(unconvertible)).toThrow(TypeError);
    const data = new SwarmData('Buffer', 2, Buffer.from('hi'), null);
    const make = (row, params) => {
      const a = new Admission({ row, params, key: KEY });
      a.ready('publish');
      a.readyAnswered(true);
      a.settle(
        a.admit(get('stamps', '/stamps', { max_bytes: 1048576 })).ticket,
        ok(Buffer.from('[]'))
      );
      return a;
    };
    const batch = ['swarm-postage-batch-id', 'a1'.repeat(32)];
    let a = make('publishData', { data, contentType: 'text/plain', name: unconvertible });
    expect(
      a.admit({
        form: 'bzz_file',
        method: 'POST',
        path: '/bzz',
        query: [['name', '[object Object]']],
        headers: [
          ['content-type', 'text/plain'],
          batch,
          ['swarm-pin', 'true'],
          ['swarm-deferred-upload', 'false'],
        ],
        body: { base64: 'aGk=' },
        max_bytes: 65536,
        stream: false,
      })
    ).toStrictEqual({ rule: 'value' });
    expect(() => make('createFeed', { name: unconvertible })).not.toThrow();
    a = make('createFeed', { name: unconvertible });
    expect(
      a.admit({
        ...get('feed_manifest', `/feeds/${OWNER}/${'cd'.repeat(32)}`),
        method: 'POST',
        headers: [batch],
        max_bytes: 65536,
      })
    ).toStrictEqual({ rule: 'value' });
    a = make('publishFiles', {
      files: [{ path: 'a.txt', bytes: data }],
      indexDocument: unconvertible,
    });
    expect(
      a.admit({
        form: 'bzz_tar',
        method: 'POST',
        path: '/bzz',
        query: [],
        headers: [
          ['content-type', 'application/x-tar'],
          ['swarm-collection', 'true'],
          batch,
          ['swarm-pin', 'true'],
          ['swarm-deferred-upload', 'true'],
        ],
        body: { stream: 3072 },
        max_bytes: 65536,
        stream: false,
      })
    ).toStrictEqual({ rule: 'header' });
    for (const row of ['readFeedEntry_latest', 'updateFeed', 'writeFeedEntry']) {
      expect(
        () =>
          new Admission({ row, params: { name: unconvertible, feedId: unconvertible }, key: KEY })
      ).not.toThrow();
    }
  });

  test('the occurrences refuse a length or depth that is no number', () => {
    const occurrences = new Occurrences();
    for (const [length, depth] of [
      ['x', 1],
      [1.5, 1],
      [4096, '1'],
      [null, 1],
      [{}, 1],
    ]) {
      expect(occurrences.take('ab'.repeat(32), length, depth)).toBe('value');
    }
    expect(occurrences.take(null, 4096, 1)).toBe('value');
  });
});
