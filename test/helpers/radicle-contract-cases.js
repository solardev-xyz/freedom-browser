/**
 * The golden vector cases of the Radicle backend contract (freedom-core
 * design 0008, "Tests first"), by name. Each case reads the fixture through
 * a backend and returns what it read; `vectors.json` holds what the v0.8.0
 * add-on returned, and every backend must return the same bytes.
 *
 * - `reads`: one per `rad.read` op, in the design's three classes, each
 *   the backend's `readText` exactly as it answers:
 *   - **pass-through:** the add-on export's own JSON text;
 *   - **serialized:** what main's `JSON.stringify` writes for the parsed
 *     result (`issue`, `patch`, `remotes`, `repo_stats`);
 *   - **composed:** what main composes today (`readme_at`, `repo_meta`,
 *     `repos_meta`, `issues_page`, `patches_page`), recorded from main's
 *     own code.
 *   A failed read is its error's message: `{ error }`.
 * - `handlers`: whole answers (status, headers, body) of the `rad:` and
 *   `radapi:` handlers and of the manager's `getConnections`, including the
 *   node endpoints' contracts when a read fails.
 *
 * `fx` is the fixture: its repository ID, commits and issues.
 */

const ENUMERATION_FAILED = 'injected: repository enumeration failed';
const STATUS_FAILED = 'injected: node status failed';
const UNKNOWN_OID = '0'.repeat(40);

/** The `status`, `page` and `perPage` query strings main's pages read. */
const PAGE_QUERIES = [
  '',
  '?status=open',
  '?status=closed',
  '?status=merged',
  '?status=',
  '?page=1',
  '?page=-1',
  '?page=abc',
  '?page=1.9',
  '?page=999',
  '?perPage=1',
  '?perPage=1&page=1',
  '?perPage=1&page=2',
  '?perPage=0',
  '?perPage=101',
  '?perPage=-5',
  '?perPage=2x',
  '?status=open&perPage=1&page=1',
];

/** The page op's arguments: the raw query strings, or null. */
function pageArgs(rid, query) {
  const params = new URLSearchParams(query);
  return {
    rid,
    status: params.get('status'),
    page: params.get('page'),
    per_page: params.get('perPage'),
  };
}

/**
 * A read's record: the backend's text exactly as it gave it, or its
 * error's message. Nothing is normalized here: the text is the contract.
 * An error's code is a declared deviation (the service adds one beside
 * the same message), so only the message is recorded.
 */
async function readRecord(backend, op, args) {
  try {
    return { body: await backend.readText(op, args) };
  } catch (err) {
    return { error: err.message };
  }
}

const SERIALIZED = new Set(['issue', 'patch', 'remotes', 'repo_stats']);

/** An answer's record: its status, its headers and its body text. */
async function responseRecord(res) {
  return {
    status: res.status,
    headers: [...res.headers],
    body: res.body ? await res.text() : null,
  };
}

/**
 * Every case, by name, for the fixture `fx`: `{ kind, op?, args?, run }`,
 * where `run(backend)` resolves to the case's record.
 */
function vectorCases(fx) {
  const { rid } = fx;
  const { first, second } = fx.commits;
  const cases = new Map();
  const read = (name, op, args) =>
    cases.set(name, {
      kind: 'read',
      op,
      args,
      class: SERIALIZED.has(op) ? 'serialized' : 'pass-through',
      run: (backend) => readRecord(backend, op, args),
    });
  const composed = (name, op, args) =>
    cases.set(name, {
      kind: 'read',
      op,
      args,
      class: 'composed',
      run: (backend) => readRecord(backend, op, args),
    });
  const handler = (name, run) => cases.set(name, { kind: 'handler', run });
  const rad = (method, path) =>
    handler(`rad ${method} ${path || '(root)'}`, async (backend) =>
      responseRecord(
        await backend.rad.handleRadRequest(
          new Request(`rad://${rid.slice('rad:'.length)}${path}`, { method })
        )
      )
    );
  const radapi = (method, path, label = '', inject = null) =>
    handler(`radapi ${method} ${path}${label}`, async (backend) => {
      const restore = inject?.(backend);
      try {
        return await responseRecord(
          await backend.api.handleRadicleApiRequest(
            new Request(`radapi://local${path}`, { method })
          )
        );
      } finally {
        restore?.();
      }
    });

  // Pass-through and serialized reads.
  read('repo_info', 'repo_info', { rid });
  read('tree (root)', 'tree', { rid, path: '' });
  read('tree src', 'tree', { rid, path: 'src' });
  read('tree_at second (root)', 'tree_at', { rid, revision: second, path: '' });
  read('tree_at second src', 'tree_at', { rid, revision: second, path: 'src' });
  read('tree_at first (root)', 'tree_at', { rid, revision: first, path: '' });
  read('tree_at second missing', 'tree_at', { rid, revision: second, path: 'missing' });
  read('blob README.md', 'blob', { rid, path: 'README.md' });
  read('blob src/main.js', 'blob', { rid, path: 'src/main.js' });
  for (const file of ['README.md', 'src/main.js', 'image.png', 'empty.txt', 'link', 'notes.txt']) {
    read(`blob_at second ${file}`, 'blob_at', { rid, revision: second, path: file });
  }
  read('blob_at second missing.txt', 'blob_at', { rid, revision: second, path: 'missing.txt' });
  read('blob_at second src', 'blob_at', { rid, revision: second, path: 'src' });
  read('blob_at first notes.txt', 'blob_at', { rid, revision: first, path: 'notes.txt' });
  read('commits second 0 30', 'commits', { rid, parent: second, page: 0, per_page: 30 });
  read('commits second 0 1', 'commits', { rid, parent: second, page: 0, per_page: 1 });
  read('commits second 1 1', 'commits', { rid, parent: second, page: 1, per_page: 1 });
  read('commits second 5 1', 'commits', { rid, parent: second, page: 5, per_page: 1 });
  read('commits first 0 30', 'commits', { rid, parent: first, page: 0, per_page: 30 });
  read('commit second', 'commit', { rid, revision: second });
  read('commit first', 'commit', { rid, revision: first });
  read('commit unknown', 'commit', { rid, revision: UNKNOWN_OID });
  read('issues', 'issues', { rid });
  for (const [label, id] of Object.entries(fx.issues)) {
    read(`issue ${label}`, 'issue', { rid, id });
  }
  read('issue unknown', 'issue', { rid, id: UNKNOWN_OID });
  read('patches', 'patches', { rid });
  read('patch unknown', 'patch', { rid, id: UNKNOWN_OID });
  read('list_repos', 'list_repos', {});
  read('list_seeded_repos', 'list_seeded_repos', {});
  read('seeders', 'seeders', { rid });
  read('identity', 'identity', {});
  read('status', 'status', {});
  read('remotes', 'remotes', { rid });
  read('repo_stats second', 'repo_stats', { rid, revision: second });
  read('repo_stats first', 'repo_stats', { rid, revision: first });

  // Composed in main today.
  for (const [label, revision] of [
    ['second', second],
    ['first', first],
  ]) {
    composed(`readme_at ${label}`, 'readme_at', { rid, revision });
  }
  composed('repo_meta', 'repo_meta', { rid });
  composed('repos_meta', 'repos_meta', {});
  for (const op of ['issues_page', 'patches_page']) {
    for (const query of PAGE_QUERIES) {
      composed(`${op} ${query || '(defaults)'}`, op, pageArgs(rid, query));
    }
  }

  // The rad: handler, any page's view of a public repository.
  rad('GET', '');
  rad('HEAD', '');
  rad('GET', `/tree/${second}`);
  rad('GET', `/tree/${second}/src`);
  rad('HEAD', `/tree/${second}`);
  rad('GET', `/blob/${second}/README.md`);
  rad('GET', `/blob/${second}/image.png`);
  rad('GET', `/blob/${second}/missing.txt`);
  rad('HEAD', `/blob/${second}/README.md`);
  rad('GET', `/readme/${second}`);
  rad('GET', `/commits?parent=${second}`);
  rad('GET', `/commits?parent=${second}&page=1&perPage=1`);
  rad('GET', `/commits?parent=${second}&perPage=1000`);
  rad('GET', `/commits/${second}`);
  rad('GET', `/commits/${UNKNOWN_OID}`);
  rad('GET', `/stats/tree/${second}`);
  rad('GET', '/remotes');
  rad('GET', '/issues');
  rad('GET', '/issues?status=closed&perPage=1');
  rad('GET', `/issues/${fx.issues.open}`);
  rad('GET', `/issues/${UNKNOWN_OID}`);
  rad('GET', '/patches');

  // The radapi: handler: the viewer's node endpoints and listing.
  radapi('GET', '/');
  radapi('GET', '/api/v1/stats');
  radapi('GET', '/api/v1/repos');
  radapi('HEAD', '/api/v1/repos');
  radapi('GET', `/api/v1/repos/${encodeURIComponent(rid)}`);
  radapi('GET', `/api/v1/repos/${encodeURIComponent(rid)}/issues`);

  // node_info's contracts, as main answers today.
  const failing = (name, message) => (backend) => backend.failNext(name, message);
  radapi('GET', '/', ' (enumeration fails)', failing('listRepos', ENUMERATION_FAILED));
  radapi('GET', '/api/v1/stats', ' (enumeration fails)', failing('listRepos', ENUMERATION_FAILED));
  radapi('GET', '/', ' (status fails)', failing('status', STATUS_FAILED));
  radapi('GET', '/api/v1/stats', ' (status fails)', failing('status', STATUS_FAILED));
  const connections = (label, inject = null) =>
    handler(`manager getConnections${label}`, async (backend) => {
      const restore = inject?.(backend);
      try {
        return { body: JSON.stringify(await backend.manager.getConnections()) };
      } finally {
        restore?.();
      }
    });
  connections('');
  connections(' (enumeration fails)', failing('listRepos', ENUMERATION_FAILED));
  connections(' (status fails)', failing('status', STATUS_FAILED));

  return cases;
}

module.exports = { vectorCases, PAGE_QUERIES, UNKNOWN_OID };
