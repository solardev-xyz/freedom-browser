// history-search.js runs on the real better-sqlite3 (N-API, loads under
// jest's Node) against an in-memory database with the app's schema.
//
// The key claim (#503): the address bar's suggestions built from the bounded
// candidate set are the suggestions it used to build from the whole table.
// The equivalence test below checks that against the unchanged renderer
// ranking, `generateSuggestions`, over a few thousand generated rows.
const Database = require('better-sqlite3');
const { AUTOCOMPLETE_CANDIDATES, autocompleteHistory, historyPage } = require('./history-search');

let generateSuggestions;
beforeAll(async () => {
  ({ generateSuggestions } = await import('../renderer/lib/autocomplete-utils.js'));
});

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      title TEXT,
      timestamp INTEGER NOT NULL,
      visit_count INTEGER DEFAULT 1,
      protocol TEXT
    );
    CREATE INDEX idx_history_timestamp ON history(timestamp DESC);
    CREATE INDEX idx_history_url ON history(url);
  `);
  return db;
}

function insertRows(db, rows) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO history (url, title, timestamp, visit_count, protocol) VALUES (@url, @title, @timestamp, @visit_count, @protocol)'
  );
  db.transaction(() =>
    rows.forEach((row) => insert.run({ protocol: 'https', visit_count: 1, ...row }))
  )();
}

// What the renderer used to receive: every row, most recent first.
const wholeTable = (db) => db.prepare('SELECT * FROM history ORDER BY timestamp DESC').all();

// mulberry32
function prng(seed) {
  let state = seed;
  return {
    rnd: () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

// Deterministic generator: hosts shared by many pages (so root-domain
// suggestions and prefix matches compete), skewed visit counts, mixed case,
// dweb URLs and some missing titles. Timestamps are distinct, as real
// Date.now() visit times nearly always are — or, with `ties`, shared by runs
// of 50 rows, to pin the tie order too.
function generateRows(count, seed = 7, { ties = false } = {}) {
  const { rnd } = prng(seed);
  const words = ['alpha', 'Beta', 'news', 'Wiki', 'swarm', 'docs', 'blog', 'GitHub', 'shop', 'map'];
  const word = () => words[Math.floor(rnd() * words.length)];
  const hosts = Array.from({ length: 60 }, (_, i) => `${word().toLowerCase()}${i}.example`);
  const now = 1_700_000_000_000;
  return Array.from({ length: count }, (_, i) => {
    const host = hosts[Math.floor(rnd() ** 2 * hosts.length)];
    const kind = rnd();
    // Mostly deeper pages; some bare origins (a row that *is* a root-domain
    // suggestion) and dweb names.
    let url = `https://${host}/${word()}/${i}`;
    if (kind < 0.1) url = `bzz://${word().toLowerCase()}${i}.eth/`;
    else if (kind < 0.15) url = `https://${host}`;
    return {
      url,
      title: rnd() < 0.1 ? null : `${word()} ${word()} ${i}`,
      // 7919 is prime, so this visits every slot in [0, count) once.
      timestamp: now - Math.floor(((i * 7919) % count) / (ties ? 50 : 1)) * 1000,
      visit_count: 1 + Math.floor(rnd() ** 6 * 300),
      protocol: url.startsWith('bzz') ? 'swarm' : 'https',
    };
  });
}

describe('autocompleteHistory', () => {
  test('gives the same suggestions as ranking the whole table', () => {
    const db = createDb();
    const rows = generateRows(4000);
    insertRows(db, rows);
    const all = wholeTable(db);
    const openTabs = [
      { id: 1, url: rows[10].url, title: rows[10].title },
      { id: 2, url: 'https://alpha3.example/x', title: 'An open tab' },
    ];
    const bookmarks = [
      { label: 'News bookmark', target: rows[20].url },
      { label: 'Docs', target: 'https://docs.example/' },
    ];

    const queries = [
      'a',
      'n',
      'e',
      'al',
      'ne',
      'wi',
      'git',
      'news',
      'Wiki',
      'BETA',
      'docs',
      'swarm',
      'https://',
      'https://news',
      'bzz://',
      '.eth',
      'example/',
      '/12',
      '3',
      '42',
      '999',
      'shop1',
      'map 1',
      'alpha beta',
      'no-such-thing',
    ];
    let compared = 0;
    for (const query of queries) {
      const candidates = autocompleteHistory(db, query);
      expect(candidates.length).toBeLessThanOrEqual(2 * AUTOCOMPLETE_CANDIDATES);
      const expected = generateSuggestions(query, { openTabs, historyItems: all, bookmarks });
      const actual = generateSuggestions(query, { openTabs, historyItems: candidates, bookmarks });
      expect({ query, suggestions: actual }).toEqual({ query, suggestions: expected });
      compared += expected.length;
    }
    // The comparison was not vacuous.
    expect(compared).toBeGreaterThan(150);
    db.close();
  });

  test('gives the same suggestions for random fragments of stored URLs and titles', () => {
    for (const [seed, ties] of [
      [11, false],
      [12, false],
      [13, true],
    ]) {
      const db = createDb();
      insertRows(db, generateRows(4000, seed, { ties }));
      const all = wholeTable(db);
      const { rnd } = prng(seed * 31);
      let compared = 0;
      for (let k = 0; k < 150; k++) {
        const row = all[Math.floor(rnd() * all.length)];
        const source = rnd() < 0.5 ? row.url : row.title || row.url;
        const length = 1 + Math.floor(rnd() * 6);
        const start = Math.floor(rnd() * Math.max(1, source.length - length));
        // Trimmed, as the address bar trims what it looks up.
        let query = source.slice(start, start + length).trim();
        if (!query) continue;
        if (rnd() < 0.3) query = query.toUpperCase();
        const expected = generateSuggestions(query, { historyItems: all });
        const actual = generateSuggestions(query, {
          historyItems: autocompleteHistory(db, query),
        });
        expect({ query, suggestions: actual }).toEqual({ query, suggestions: expected });
        compared += 1;
      }
      expect(compared).toBeGreaterThan(100);
      db.close();
    }
  });

  test('keeps the old read order for rows visited in the same millisecond', () => {
    // The old full-table read walked the timestamp index: ties in rowid order.
    const db = createDb();
    insertRows(
      db,
      ['c', 'a', 'b'].map((name) => ({
        url: `https://${name}.example/`,
        title: 'Tie',
        timestamp: 5,
      }))
    );
    const order = ['https://c.example/', 'https://a.example/', 'https://b.example/'];
    expect(wholeTable(db).map((row) => row.url)).toEqual(order);
    expect(autocompleteHistory(db, 'tie').map((row) => row.url)).toEqual(order);
    expect(historyPage(db, {}).entries.map((row) => row.url)).toEqual(order);
    expect(historyPage(db, { sort: 'visited' }).entries.map((row) => row.url)).toEqual(order);
    db.close();
  });

  test('a bare origin stays hidden behind its newer, lower-scoring page', () => {
    // generateSuggestions synthesises "https://hub.example" from the most
    // recent matching page under it, at 0.8× that page's score, and then
    // skips the real row for the same URL. That newer page scores too low to
    // be a candidate on its own; it has to be fetched for its origin.
    const db = createDb();
    insertRows(db, [
      ...Array.from({ length: AUTOCOMPLETE_CANDIDATES + 10 }, (_, i) => ({
        url: `https://f${i}.example/hub-page`,
        title: `Hub page ${i}`,
        timestamp: 1000 + i,
      })),
      { url: 'https://hub.example', title: 'Hub home', timestamp: 10, visit_count: 1000 },
      { url: 'https://hub.example/old', title: 'old', timestamp: 20 },
      // Same prefix, different origins: not "under" https://hub.example.
      { url: 'https://hub.example.evil/x', title: 'x', timestamp: 30 },
      { url: 'https://hub.example:8080/x', title: 'x', timestamp: 31 },
      { url: 'https://hub.examples/x', title: 'x', timestamp: 32 },
    ]);
    const all = wholeTable(db);
    const expected = generateSuggestions('hub', { historyItems: all });
    expect(expected.map((s) => s.url)).not.toContain('https://hub.example');
    const candidates = autocompleteHistory(db, 'hub');
    expect(candidates.map((row) => row.url)).toContain('https://hub.example/old');
    for (const other of [
      'https://hub.example.evil/x',
      'https://hub.example:8080/x',
      'https://hub.examples/x',
    ]) {
      expect(candidates.map((row) => row.url)).not.toContain(other);
    }
    expect(generateSuggestions('hub', { historyItems: candidates })).toEqual(expected);
    db.close();
  });

  test('returns every match, most recent first, when there are few', () => {
    const db = createDb();
    insertRows(db, [
      { url: 'https://old.example/', title: 'Needle old', timestamp: 1, visit_count: 50 },
      { url: 'https://new.example/', title: 'Needle new', timestamp: 3, visit_count: 1 },
      { url: 'https://other.example/', title: 'Other', timestamp: 2, visit_count: 1 },
    ]);
    expect(autocompleteHistory(db, '  needle ').map((row) => row.url)).toEqual([
      'https://new.example/',
      'https://old.example/',
    ]);
    expect(autocompleteHistory(db, '')).toEqual([]);
    expect(autocompleteHistory(db, '   ')).toEqual([]);
    db.close();
  });

  test('matches case-insensitively, including non-ASCII text', () => {
    const db = createDb();
    insertRows(db, [
      { url: 'https://de.example/', title: 'Über uns', timestamp: 1 },
      { url: 'https://EXAMPLE.org/Path', title: null, timestamp: 2 },
    ]);
    expect(autocompleteHistory(db, 'über').map((row) => row.title)).toEqual(['Über uns']);
    expect(autocompleteHistory(db, 'ÜBER').map((row) => row.title)).toEqual(['Über uns']);
    expect(autocompleteHistory(db, 'example.ORG/path').map((row) => row.url)).toEqual([
      'https://EXAMPLE.org/Path',
    ]);
    db.close();
  });

  test('treats LIKE wildcards in the query as literal text', () => {
    const db = createDb();
    insertRows(db, [
      { url: 'https://a.example/100%25', title: '100% done', timestamp: 1 },
      { url: 'https://b.example/', title: '1000 done', timestamp: 2 },
      { url: 'https://c.example/a_b', title: 'under_score', timestamp: 3 },
      { url: 'https://d.example/axb', title: 'axb', timestamp: 4 },
      { url: 'https://e.example/back\\slash', title: 'back\\slash', timestamp: 5 },
    ]);
    expect(autocompleteHistory(db, '100%').map((row) => row.title)).toEqual(['100% done']);
    expect(autocompleteHistory(db, 'a_b').map((row) => row.title)).toEqual(['under_score']);
    expect(autocompleteHistory(db, 'k\\s').map((row) => row.title)).toEqual(['back\\slash']);
    db.close();
  });
});

describe('historyPage', () => {
  const rows = [
    { url: 'https://b.example/', title: 'banana', timestamp: 30, visit_count: 2 },
    { url: 'https://a.example/', title: 'Apple', timestamp: 10, visit_count: 9 },
    { url: 'https://c.example/', title: '', timestamp: 20, visit_count: 2 },
    { url: 'https://d.example/apple-pie', title: 'Pie', timestamp: 40, visit_count: 1 },
  ];

  test('sorts like the page did, in SQL', () => {
    const db = createDb();
    insertRows(db, rows);
    const urls = (sort) => historyPage(db, { sort }).entries.map((row) => row.url);
    expect(urls('recent')).toEqual([
      'https://d.example/apple-pie',
      'https://b.example/',
      'https://c.example/',
      'https://a.example/',
    ]);
    // Visit count, ties most recent first.
    expect(urls('visited')).toEqual([
      'https://a.example/',
      'https://b.example/',
      'https://c.example/',
      'https://d.example/apple-pie',
    ]);
    // Title, case-insensitive, falling back to the URL for an empty title.
    expect(urls('title')).toEqual([
      'https://a.example/',
      'https://b.example/',
      'https://c.example/',
      'https://d.example/apple-pie',
    ]);
    expect(urls('bogus')).toEqual(urls('recent'));
    db.close();
  });

  test('pages with offset/limit and reports matched and total counts', () => {
    const db = createDb();
    insertRows(db, rows);
    expect(historyPage(db, { limit: 2 })).toEqual({
      entries: [
        expect.objectContaining({ url: 'https://d.example/apple-pie' }),
        expect.objectContaining({ url: 'https://b.example/' }),
      ],
      matched: 4,
      total: 4,
    });
    expect(historyPage(db, { limit: 2, offset: 2 }).entries.map((row) => row.url)).toEqual([
      'https://c.example/',
      'https://a.example/',
    ]);
    const search = historyPage(db, { query: 'APPLE' });
    expect(search.entries.map((row) => row.url)).toEqual([
      'https://d.example/apple-pie',
      'https://a.example/',
    ]);
    expect(search).toEqual(expect.objectContaining({ matched: 2, total: 4 }));
    db.close();
  });

  test('clamps the page size', () => {
    const db = createDb();
    insertRows(
      db,
      Array.from({ length: 1205 }, (_, i) => ({
        url: `https://x.example/${i}`,
        title: 'x',
        timestamp: i,
      }))
    );
    expect(historyPage(db, { limit: 1e9 }).entries).toHaveLength(1000);
    expect(historyPage(db, {}).entries).toHaveLength(200);
    expect(historyPage(db, { limit: -5 }).entries).toHaveLength(1);
    db.close();
  });
});
