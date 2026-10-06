// Bounded, read-only history queries for the address bar and the internal
// History page (#503 item 2). Shared by the main thread (fallback) and the
// history search worker (`history-search-worker.js`), which is where they
// normally run: a scored scan over a 200k-row history takes 15-60 ms in
// Electron's Node, too long for the main thread on every keystroke.
//
// Before this, the address bar pulled the *whole* history table over IPC
// after every navigation (70 ms query + 120 ms structured clone at 200k rows,
// on main) and scored it in the renderer. These queries return a small
// candidate set instead; the renderer still ranks it with the unchanged
// `generateSuggestions` (src/renderer/lib/autocomplete-utils.js).
//
// Why the candidate set gives the same top 8 as scoring the whole table:
//   - Matching mirrors the renderer's `url.toLowerCase().includes(q) ||
//     title.toLowerCase().includes(q)`. For an ASCII query that is SQLite's
//     LIKE (ASCII case-insensitive; this SQLite has no ICU). The only
//     divergence is the two non-ASCII characters whose JS lower case is
//     ASCII (U+0130 'İ' → 'i̇', U+212A KELVIN SIGN → 'k'). A query with any
//     non-ASCII character goes through a JS `toLowerCase()` SQL function
//     instead, so e.g. "über" still finds "Über" (slower, still in the worker).
//   - The score below is `scoreSuggestion`'s formula in SQL. The best
//     AUTOCOMPLETE_CANDIDATES rows by it (ties: most recent first, the order
//     the renderer saw rows in) include every history row that can reach the
//     top 8: a row outside them has that many distinct-URL rows scoring at
//     least as high, and each of those ends up as a suggestion at least as
//     high (or replaced by a tab/bookmark for the same URL, which scores
//     higher still) — bar the case below.
//   - A synthesized root-domain suggestion ("https://host" for a matching
//     deeper page) is scored 0.8× the *most recent* matching row with that
//     root, and a history row whose URL *is* that root is hidden behind it
//     when the deeper page is newer. So for every origin among the
//     candidates, the most recent matching row under that origin is added
//     too (an indexed range on `url`; the ranges are disjoint, so together
//     they read at most the table once). Origins are cut the way
//     extractRootDomain() cuts them for the stored URL forms
//     (`scheme://host…`, `name.eth…`); a URL it would normalise differently
//     (an upper-case host, userinfo) can still diverge, as can a query where
//     more than 42 of the 50 best rows are bare origins each hidden that way.
//     Checked against whole-table ranking on generated histories in
//     history-search.test.js.
// Rows come back most-recent-first, the order the renderer iterated the full
// table in, so its tie-breaking is unchanged.

const AUTOCOMPLETE_CANDIDATES = 50;
const PAGE_SIZE_DEFAULT = 200;
const PAGE_SIZE_MAX = 1000;
const MAX_QUERY_LENGTH = 2048;

const COLUMNS = 'id, url, title, timestamp, visit_count, protocol';

// Equal timestamps keep the order the old full-table read gave them: it
// walked the `timestamp DESC` index, whose ties sit in rowid order. The
// History page then stable-sorted that list, so its ties are the same.
const RECENCY = 'timestamp DESC, id ASC';

const PAGE_ORDER = Object.freeze({
  recent: RECENCY,
  visited: `visit_count DESC, ${RECENCY}`,
  title: `lower(coalesce(nullif(title, ''), url)) ASC, ${RECENCY}`,
});

// The two match/score flavours. `@c` / `@p` are the contains / starts-with
// patterns (LIKE patterns for ASCII, the lower-cased query for Unicode).
const FLAVOURS = {
  ascii: {
    contains: (col) => `${col} LIKE @c ESCAPE '\\'`,
    startsWith: (col) => `${col} LIKE @p ESCAPE '\\'`,
  },
  unicode: {
    contains: (col) => `instr(freedom_lower(${col}), @c) > 0`,
    startsWith: (col) => `substr(freedom_lower(${col}), 1, length(@c)) = @c`,
  },
};

function matchClause(f) {
  return `(${f.contains('url')} OR ${f.contains('title')})`;
}

// scoreSuggestion() in autocomplete-utils.js, minus the bookmark bonus.
function scoreExpr(f) {
  return `(
    CASE WHEN ${f.startsWith('url')} THEN 100 WHEN ${f.contains('url')} THEN 50 ELSE 0 END
    + CASE WHEN ${f.startsWith('title')} THEN 80 WHEN ${f.contains('title')} THEN 30 ELSE 0 END
    + CASE WHEN visit_count > 0 THEN min(ln(visit_count + 1) * 10, 50) ELSE 0 END
  )`;
}

const statementCache = new WeakMap();

function registerFunctions(db) {
  db.function('freedom_lower', { deterministic: true }, (value) =>
    value == null ? '' : String(value).toLowerCase()
  );
}

function getStatements(db) {
  let cached = statementCache.get(db);
  if (cached) return cached;
  registerFunctions(db);
  cached = { total: db.prepare('SELECT COUNT(*) AS count FROM history') };
  for (const [name, f] of Object.entries(FLAVOURS)) {
    const match = matchClause(f);
    cached[name] = {
      byScore: db.prepare(
        `SELECT ${COLUMNS} FROM history WHERE ${match}
         ORDER BY ${scoreExpr(f)} DESC, ${RECENCY} LIMIT @limit`
      ),
      // The most recent match under one origin: the origin itself, or it
      // followed by '/', '?' or '#' (each the next byte up bounds a range).
      latestUnderOrigin: db.prepare(
        `SELECT ${COLUMNS} FROM history
         WHERE (url = @o OR (url >= @o1 AND url < @o2) OR (url >= @o3 AND url < @o4)
                OR (url >= @o5 AND url < @o6))
           AND ${match}
         ORDER BY ${RECENCY} LIMIT 1`
      ),
      latestUnderPrefix: db.prepare(
        `SELECT ${COLUMNS} FROM history
         WHERE url >= @o AND url < @o1 AND ${match}
         ORDER BY ${RECENCY} LIMIT 1`
      ),
      count: db.prepare(`SELECT COUNT(*) AS count FROM history WHERE ${match}`),
      page: Object.fromEntries(
        Object.entries(PAGE_ORDER).map(([sort, order]) => [
          sort,
          db.prepare(
            `SELECT ${COLUMNS} FROM history WHERE ${match}
             ORDER BY ${order} LIMIT @limit OFFSET @offset`
          ),
        ])
      ),
    };
  }
  cached.pageAll = Object.fromEntries(
    Object.entries(PAGE_ORDER).map(([sort, order]) => [
      sort,
      db.prepare(`SELECT ${COLUMNS} FROM history ORDER BY ${order} LIMIT @limit OFFSET @offset`),
    ])
  );
  statementCache.set(db, cached);
  return cached;
}

const isAscii = (s) => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
};
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function normalizeQuery(query) {
  if (typeof query !== 'string') return '';
  return query.trim().slice(0, MAX_QUERY_LENGTH);
}

// Statement set + bound parameters for a non-empty query.
function bindQuery(db, query) {
  const statements = getStatements(db);
  if (isAscii(query)) {
    const escaped = escapeLike(query);
    return { set: statements.ascii, params: { c: `%${escaped}%`, p: `${escaped}%` } };
  }
  return { set: statements.unicode, params: { c: query.toLowerCase() } };
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const SCHEME_ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i;
// extractRootDomain()'s name form: the root is this match, whatever follows.
const NAME_ROOT = /^[a-zA-Z0-9-]+\.(?:eth|box|wei|gwei)/;
const MAX_CODE_POINT = String.fromCodePoint(0x10ffff);

// The most recent row matching the query under `url`'s origin, or null.
function latestUnderOriginOf(set, params, url) {
  const origin = SCHEME_ORIGIN.exec(url)?.[0];
  if (origin) {
    return set.latestUnderOrigin.get({
      ...params,
      o: origin,
      o1: `${origin}/`,
      o2: `${origin}0`,
      o3: `${origin}?`,
      o4: `${origin}@`,
      o5: `${origin}#`,
      o6: `${origin}$`,
    });
  }
  const name = NAME_ROOT.exec(url)?.[0];
  if (name) {
    return set.latestUnderPrefix.get({ ...params, o: name, o1: `${name}${MAX_CODE_POINT}` });
  }
  return null;
}

const mostRecentFirst = (a, b) => b.timestamp - a.timestamp || a.id - b.id;

/**
 * History candidates for the address bar's suggestions: the best rows by
 * the renderer's score, plus the most recent match under each of their
 * origins; most recent first.
 * @param {import('better-sqlite3').Database} db
 * @param {string} query - what the user typed
 * @returns {Array<object>} at most 2 × AUTOCOMPLETE_CANDIDATES rows
 */
function autocompleteHistory(db, query) {
  const q = normalizeQuery(query);
  if (!q) return [];
  const { set, params } = bindQuery(db, q);
  const limit = AUTOCOMPLETE_CANDIDATES;
  const byScore = set.byScore.all({ ...params, limit });
  // Fewer than `limit` rows means that was every match.
  if (byScore.length < limit) return byScore.sort(mostRecentFirst);
  const byId = new Map(byScore.map((row) => [row.id, row]));
  const origins = new Set();
  for (const row of byScore) {
    const origin = SCHEME_ORIGIN.exec(row.url)?.[0] ?? NAME_ROOT.exec(row.url)?.[0];
    if (!origin || origins.has(origin)) continue;
    origins.add(origin);
    const latest = latestUnderOriginOf(set, params, row.url);
    if (latest) byId.set(latest.id, latest);
  }
  return [...byId.values()].sort(mostRecentFirst);
}

/**
 * One page of the History page's list.
 * @param {import('better-sqlite3').Database} db
 * @param {{ query?: string, sort?: 'recent'|'visited'|'title', offset?: number, limit?: number }} options
 * @returns {{ entries: Array<object>, matched: number, total: number }}
 *   `matched` counts every row the query matches (all rows without one),
 *   `total` every row in the table.
 */
function historyPage(db, options = {}) {
  const q = normalizeQuery(options.query);
  const sort = Object.hasOwn(PAGE_ORDER, options.sort) ? options.sort : 'recent';
  const limit = clampInt(options.limit, PAGE_SIZE_DEFAULT, 1, PAGE_SIZE_MAX);
  const offset = clampInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const statements = getStatements(db);
  const total = statements.total.get().count;
  if (!q) {
    return {
      entries: statements.pageAll[sort].all({ limit, offset }),
      matched: total,
      total,
    };
  }
  const { set, params } = bindQuery(db, q);
  return {
    entries: set.page[sort].all({ ...params, limit, offset }),
    matched: set.count.get(params).count,
    total,
  };
}

module.exports = {
  AUTOCOMPLETE_CANDIDATES,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  autocompleteHistory,
  historyPage,
};
