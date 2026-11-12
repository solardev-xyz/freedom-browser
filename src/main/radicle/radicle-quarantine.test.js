/**
 * Radicle's repair as main shows it (radicle-quarantine.js; freedom-core
 * design 0008, "The deadline" and "The escape", Main's view; the radicled
 * step-5 plan's B13), over a fake node: the report, `rad.quarantine_list`'s
 * paging, Remove bound to the `qid` main showed, and "still repairing".
 * radicle-service-quarantine.test.js runs it with the manager and a real
 * node on a fake service.
 */

const {
  QuarantineView,
  listQuarantine,
  checkEntry,
  NOT_SHOWN_MESSAGE,
  NOT_QUARANTINED_MESSAGE,
  REMOVE_UNKNOWN_MESSAGE,
  NAME_MAX,
} = require('./radicle-quarantine');

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** The `n`th repository's ID: in the order of `n`, as the record's are. */
function rid(n) {
  let digits = '';
  for (let i = 0, v = n; i < 4; i++, v = Math.floor(v / 58)) digits = BASE58[v % 58] + digits;
  return `rad:z3gqcJUoA1n9HaHKufZs5FCS${digits}`;
}

const qid = (n, salt = 0) => (n * 7919 + salt).toString(16).padStart(32, '0');

/** The `n`th entry as the service writes it. */
function raw(n, overrides = {}) {
  return {
    rid: rid(n),
    qid: qid(n),
    kind: n % 2 ? 'namespace' : 'cache',
    step: n % 2 ? 'namespaces' : 'cache',
    unit: n % 2 ? null : 'batch',
    since: 1_700_000_000_000 + n,
    ...overrides,
  };
}

/** What main shows of `raw(n)`. */
const shown = (n, name = null) => {
  const { since: _since, ...entry } = raw(n);
  return { ...entry, name };
};

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * A running node whose record holds `records` (raw entries in ID order):
 * its report is the first 16 and the count, `rad.quarantine_list` pages
 * them 64 at a time, and `rad.remove_repo` answers `removeAnswer`.
 */
function fakeNode(records, { report = undefined, count = undefined } = {}) {
  const node = {
    generation: 1,
    records,
    pages: [],
    removals: [],
    target: { gen: { number: 1 } },
    report: report === undefined ? { count: records.length, first: records.slice(0, 16) } : report,
    count: count === undefined ? records.length : count,
    listAnswer: null,
    removeAnswer: null,
    quarantineReport: jest.fn(() => node.report),
    quarantinedCount: jest.fn(() => node.count),
    quarantineList: jest.fn(async (page) => {
      node.pages.push(page);
      if (node.listAnswer) return node.listAnswer(page);
      const entries = node.records.slice(page * 64, page * 64 + 64);
      const next = node.records.length > (page + 1) * 64 ? page + 1 : null;
      return { entries, next_page: next };
    }),
    writeTarget: jest.fn(() => node.target),
    removeRepo: jest.fn(async (target, r, q) => {
      node.removals.push({ target, rid: r, qid: q });
      if (node.removeAnswer) return node.removeAnswer(r, q);
      const index = node.records.findIndex((e) => e.rid === r && e.qid === q);
      if (index < 0)
        throw Object.assign(new Error('nothing was removed'), { code: 'not_quarantined' });
      node.records = node.records.filter((_, i) => i !== index);
      node.count = node.records.length;
      return { removed: true };
    }),
  };
  return node;
}

function newView(options = {}) {
  const broadcasts = [];
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const view = new QuarantineView({
    broadcast: (snapshot) => broadcasts.push(snapshot),
    log,
    ...options,
  });
  return { view, broadcasts, log };
}

const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);

describe('the entries: the report, and rad.quarantine_list paged', () => {
  test('pages through 100 entries, 64 at a time, from page 0, in the order of their IDs', async () => {
    const node = fakeNode(range(0, 100).map((n) => raw(n)));
    const { view, broadcasts } = newView();

    await view.running(node);

    // The report holds 16 of 100: the listing, page 0 then page 1, whose
    // next page is null.
    expect(node.pages).toEqual([0, 1]);
    const snapshot = view.snapshot();
    expect(snapshot.count).toBe(100);
    expect(snapshot.entries).toEqual(range(0, 100).map((n) => shown(n)));
    expect(broadcasts).toEqual([snapshot]);
  });

  test('pages a listing of exactly 64 once, and of 65 twice', async () => {
    for (const [records, pages] of [
      [64, [0]],
      [65, [0, 1]],
      [128, [0, 1]],
      [129, [0, 1, 2]],
    ]) {
      const node = fakeNode(range(0, records).map((n) => raw(n)));
      const { view } = newView();
      await view.running(node);
      expect(node.pages).toEqual(pages);
      expect(view.snapshot().entries).toHaveLength(records);
    }
  });

  test('the report stands in when it holds them all: no listing', async () => {
    const node = fakeNode(range(0, 3).map((n) => raw(n)));
    const { view } = newView();

    await view.running(node);

    expect(node.quarantineList).not.toHaveBeenCalled();
    expect(view.snapshot()).toEqual({
      repairing: false,
      count: 3,
      entries: range(0, 3).map((n) => shown(n)),
    });
  });

  test("the report doesn't stand in once the stats count another number", async () => {
    const node = fakeNode(
      range(0, 4).map((n) => raw(n)),
      {
        report: { count: 3, first: range(0, 3).map((n) => raw(n)) },
        count: 4,
      }
    );
    const { view } = newView();
    await view.running(node);
    expect(node.pages).toEqual([0]);
    expect(view.snapshot().entries).toHaveLength(4);
  });

  test('a clean record: nothing listed, nothing sent', async () => {
    const node = fakeNode([]);
    const { view, broadcasts } = newView();
    await view.running(node);
    expect(node.quarantineList).not.toHaveBeenCalled();
    expect(view.snapshot()).toEqual({ repairing: false, count: 0, entries: [] });
    expect(broadcasts).toEqual([]);
  });

  test('main holds at most its pages: past them, the count says how many more', async () => {
    const node = fakeNode(range(0, 200).map((n) => raw(n)));
    const { view } = newView({ maxPages: 2 });
    await view.running(node);
    expect(node.pages).toEqual([0, 1]);
    const snapshot = view.snapshot();
    expect(snapshot.entries).toHaveLength(128);
    expect(snapshot.count).toBe(200);
  });

  test.each([
    [
      'a page over 64 entries',
      () => ({ entries: range(0, 65).map((n) => raw(n)), next_page: null }),
    ],
    ['a next page out of order', (page) => ({ entries: [raw(page)], next_page: page + 2 })],
    ['a next page that repeats', (page) => ({ entries: [raw(page)], next_page: page })],
    ['no entries', () => ({ next_page: null })],
  ])(
    '%s fails the listing: the report is shown, and only the code logged',
    async (_what, answer) => {
      const node = fakeNode(range(0, 40).map((n) => raw(n)));
      node.listAnswer = answer;
      const { view, log } = newView();

      await view.running(node);

      const snapshot = view.snapshot();
      expect(snapshot.entries).toEqual(range(0, 16).map((n) => shown(n)));
      expect(snapshot.count).toBe(40);
      expect(log.warn).toHaveBeenCalledWith(
        '[Radicle] Could not list the quarantined repositories',
        {
          code: 'invalid_reply',
        }
      );
    }
  );

  test('a listing that fails later keeps what main showed', async () => {
    const node = fakeNode(range(0, 20).map((n) => raw(n)));
    const { view } = newView();
    await view.running(node);
    const before = view.snapshot();
    node.listAnswer = async () => {
      throw Object.assign(new Error('busy'), { code: 'busy' });
    };
    node.count = 21;
    await view.changed(node);
    expect(view.snapshot()).toEqual(before);
  });

  test('malformed entries are left out, and still counted', async () => {
    const records = [
      raw(0),
      raw(1, { qid: 'not-a-qid' }),
      raw(2, { rid: 'rad:z0bad' }),
      raw(3, { kind: '' }),
      raw(4, { step: 7 }),
      raw(5),
      ...range(6, 20).map((n) => raw(n)),
    ];
    const node = fakeNode(records);
    const { view } = newView();
    await view.running(node);
    const snapshot = view.snapshot();
    expect(snapshot.entries.map((e) => e.rid)).toEqual([0, 5, ...range(6, 20)].map(rid));
    expect(snapshot.count).toBe(20);
  });

  test('checkEntry keeps what the chrome shows and Remove needs', () => {
    expect(checkEntry(raw(2))).toEqual({
      rid: rid(2),
      qid: qid(2),
      kind: 'cache',
      step: 'cache',
      unit: 'batch',
    });
    expect(checkEntry(raw(2, { qid: qid(2).toUpperCase() }))).toBeNull();
    expect(checkEntry(raw(2, { qid: '0'.repeat(31) }))).toBeNull();
    expect(checkEntry(null)).toBeNull();
  });

  test('listQuarantine on its own: entries, how many were seen, and whether it finished', async () => {
    const node = fakeNode(range(0, 70).map((n) => raw(n)));
    await expect(listQuarantine(node)).resolves.toMatchObject({ seen: 70, complete: true });
    await expect(listQuarantine(node, { maxPages: 1 })).resolves.toMatchObject({
      seen: 64,
      complete: false,
    });
  });
});

describe('again: the stats, a new generation, a stop', () => {
  test("the stats' count changing lists the quarantine again", async () => {
    const node = fakeNode(range(0, 2).map((n) => raw(n)));
    const { view, broadcasts } = newView();
    await view.running(node);
    expect(node.quarantineList).not.toHaveBeenCalled();

    // An online repair quarantined another.
    node.records = [...node.records, raw(2)];
    node.count = 3;
    await view.changed(node);

    expect(node.pages).toEqual([0]);
    expect(view.snapshot().entries).toEqual(range(0, 3).map((n) => shown(n)));
    expect(broadcasts).toHaveLength(2);
  });

  test('a change asked for during a listing lists once more after it', async () => {
    const node = fakeNode(range(0, 20).map((n) => raw(n)));
    const { view } = newView();
    let release;
    node.listAnswer = () =>
      new Promise((resolve) => {
        release = () => resolve({ entries: node.records.slice(0, 64), next_page: null });
      });
    const first = view.running(node);
    await settle();
    node.records = [...node.records, raw(20)];
    node.count = 21;
    const again = view.changed(node);
    expect(again).toBe(first);
    release();
    await settle();
    release();
    await first;
    expect(node.pages).toEqual([0, 0]);
    expect(view.snapshot().entries).toHaveLength(21);
  });

  test('a listing that ends after its generation did is dropped', async () => {
    const node = fakeNode(range(0, 20).map((n) => raw(n)));
    const { view, broadcasts } = newView();
    let release;
    node.listAnswer = () =>
      new Promise((resolve) => {
        release = () => resolve({ entries: node.records, next_page: null });
      });
    const listing = view.running(node);
    await settle();
    // A crash: the next generation runs with a clean record.
    node.generation = 2;
    node.records = [];
    node.count = 0;
    node.report = { count: 0, first: [] };
    const next = view.running(node);
    release();
    await listing;
    await next;
    expect(view.snapshot().entries).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  test("a change on another node, or another generation, isn't listed", async () => {
    const node = fakeNode(range(0, 2).map((n) => raw(n)));
    const { view } = newView();
    await view.running(node);
    expect(view.changed(fakeNode([]))).toBeNull();
    node.generation = 2;
    expect(view.changed(node)).toBeNull();
  });

  test('a stop shows nothing, and a listing in flight is dropped', async () => {
    const node = fakeNode(range(0, 20).map((n) => raw(n)));
    const { view } = newView();
    await view.running(node);
    expect(view.snapshot().entries).toHaveLength(20);
    let release;
    node.listAnswer = () =>
      new Promise((resolve) => {
        release = () => resolve({ entries: node.records, next_page: null });
      });
    node.count = 25;
    const listing = view.changed(node);
    await settle();
    view.stopped();
    release();
    await listing;
    expect(view.snapshot()).toEqual({ repairing: false, count: 0, entries: [] });
  });
});

describe('names', () => {
  test("each entry's name from the node's listing; the ID when it has none", async () => {
    const node = fakeNode(range(0, 3).map((n) => raw(n)));
    const readNames = jest.fn(
      async () =>
        new Map([
          [rid(0), 'heartwood'],
          [rid(2), '  '],
        ])
    );
    const { view } = newView({ readNames });
    await view.running(node);
    expect(readNames).toHaveBeenCalledWith([rid(0), rid(1), rid(2)]);
    expect(view.snapshot().entries.map((e) => e.name)).toEqual(['heartwood', null, null]);
  });

  test('a name is kept to its first 256 code units', async () => {
    const node = fakeNode([raw(0)]);
    const { view } = newView({ readNames: async () => new Map([[rid(0), 'x'.repeat(1000)]]) });
    await view.running(node);
    expect(view.snapshot().entries[0].name).toBe('x'.repeat(NAME_MAX));
  });

  test('a listing that fails gives no names, logged by its code alone', async () => {
    const node = fakeNode([raw(0)]);
    const readNames = async () => {
      throw Object.assign(new Error(`${rid(0)} is quarantined`), { code: 'quarantined' });
    };
    const { view, log } = newView({ readNames });
    await view.running(node);
    expect(view.snapshot().entries).toEqual([shown(0)]);
    expect(log.warn).toHaveBeenCalledWith(
      "[Radicle] Could not read the quarantined repositories' names",
      { code: 'quarantined' }
    );
  });
});

describe('Remove: bound to the qid main showed', () => {
  async function showing(records) {
    const node = fakeNode(records);
    const ctx = newView();
    await ctx.view.running(node);
    return { node, ...ctx };
  }

  test('sends rad.remove_repo { rid, qid } for the entry shown, on the generation running now, then lists again', async () => {
    const { node, view } = await showing(range(0, 20).map((n) => raw(n)));

    await expect(view.remove(rid(5), qid(5))).resolves.toEqual({ success: true, removed: true });
    expect(node.removals).toEqual([{ target: node.target, rid: rid(5), qid: qid(5) }]);
    await settle();
    expect(view.snapshot().entries.map((e) => e.rid)).not.toContain(rid(5));
    expect(view.snapshot().count).toBe(19);
  });

  test.each([
    ['another qid for a repository shown', () => [rid(5), qid(6)]],
    ['a repository not shown', () => [rid(40), qid(40)]],
    ['a qid in another case', () => [rid(5), qid(5).toUpperCase()]],
    ['no qid', () => [rid(5), undefined]],
    ['an object for the rid', () => [{ toString: () => rid(5) }, qid(5)]],
  ])('%s is refused before anything is sent', async (_what, pair) => {
    const { node, view } = await showing(range(0, 20).map((n) => raw(n)));
    const [r, q] = pair();
    await expect(view.remove(r, q)).resolves.toEqual({
      success: false,
      error: { code: 'QUARANTINE_NOT_SHOWN', message: NOT_SHOWN_MESSAGE },
    });
    expect(node.removeRepo).not.toHaveBeenCalled();
  });

  test('the binding follows the last snapshot: a qid shown before a relisting is refused after it', async () => {
    const { node, view } = await showing(range(0, 3).map((n) => raw(n)));
    // Removed elsewhere and quarantined again: a new record, a new qid.
    node.records = [raw(0), raw(1, { qid: qid(1, 1) }), raw(2)];
    node.count = 4;
    node.records.push(raw(3));
    await view.changed(node);

    await expect(view.remove(rid(1), qid(1))).resolves.toMatchObject({
      error: { code: 'QUARANTINE_NOT_SHOWN' },
    });
    expect(node.removeRepo).not.toHaveBeenCalled();
    await expect(view.remove(rid(1), qid(1, 1))).resolves.toEqual({ success: true, removed: true });
  });

  test('not_quarantined: nothing was removed, and the quarantine is listed again', async () => {
    const { node, view } = await showing(range(0, 3).map((n) => raw(n)));
    // Removed and quarantined again since main listed it.
    node.records = [raw(0), raw(1, { qid: qid(1, 1) }), raw(2)];

    await expect(view.remove(rid(1), qid(1))).resolves.toEqual({
      success: false,
      error: { code: 'NOT_QUARANTINED', message: NOT_QUARANTINED_MESSAGE },
    });
    await settle();
    expect(node.pages).toEqual([0]);
    expect(view.snapshot().entries[1]).toEqual({ ...shown(1), qid: qid(1, 1) });
  });

  test('outcome_unknown: the quarantine is listed again, which tells', async () => {
    const { node, view } = await showing(range(0, 3).map((n) => raw(n)));
    node.removeAnswer = () => {
      node.records = node.records.slice(1);
      throw Object.assign(new Error('stopped'), { code: 'outcome_unknown' });
    };
    await expect(view.remove(rid(0), qid(0))).resolves.toEqual({
      success: false,
      error: { code: 'OUTCOME_UNKNOWN', message: REMOVE_UNKNOWN_MESSAGE },
    });
    await settle();
    expect(view.snapshot().entries.map((e) => e.rid)).toEqual([rid(1), rid(2)]);
  });

  test('a failure names its step, and the record stays', async () => {
    const { node, view } = await showing(range(0, 3).map((n) => raw(n)));
    node.removeAnswer = () => {
      throw Object.assign(new Error('the storage: its directory could not be flushed'), {
        code: 'failed',
      });
    };
    await expect(view.remove(rid(0), qid(0))).resolves.toEqual({
      success: false,
      error: { code: 'REMOVE_FAILED', message: 'the storage: its directory could not be flushed' },
    });
    await settle();
    expect(view.snapshot().entries).toHaveLength(3);
  });

  test('an answer without removed: true is no proof', async () => {
    const { node, view } = await showing([raw(0)]);
    node.removeAnswer = () => ({ removed: false });
    await expect(view.remove(rid(0), qid(0))).resolves.toMatchObject({
      error: { code: 'OUTCOME_UNKNOWN' },
    });
  });

  test('with no generation running, nothing is sent', async () => {
    const { node, view } = await showing([raw(0)]);
    node.target = null;
    await expect(view.remove(rid(0), qid(0))).resolves.toMatchObject({
      error: { code: 'RADICLE_NOT_RUNNING' },
    });
    expect(node.removeRepo).not.toHaveBeenCalled();
  });

  test('nothing is shown before a node runs, so nothing can be removed', async () => {
    const { view } = newView();
    await expect(view.remove(rid(0), qid(0))).resolves.toMatchObject({
      error: { code: 'QUARANTINE_NOT_SHOWN' },
    });
  });
});

describe('"still repairing"', () => {
  test('a stop on the deadline shows it; the next start clears it', () => {
    const { view, broadcasts } = newView();
    view.stopped({ repairing: true });
    expect(view.snapshot()).toEqual({ repairing: true, count: 0, entries: [] });
    view.starting();
    expect(view.snapshot()).toEqual({ repairing: false, count: 0, entries: [] });
    expect(broadcasts.map((s) => s.repairing)).toEqual([true, false]);
  });

  test('a snapshot that changes nothing is not sent again', () => {
    const { view, broadcasts } = newView();
    view.stopped();
    view.starting();
    view.stopped({ repairing: true });
    view.stopped({ repairing: true });
    expect(broadcasts).toHaveLength(1);
  });
});
