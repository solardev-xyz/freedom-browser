/**
 * What window.swarm's contract holds each backend to
 * (src/main/page/page-swarm.contract.test.js), case by case: a run of
 * test/helpers/swarm-contract-backends.js's `runCase` against the case's
 * recorded reference.
 *
 * `compareCase(backend, kase, record, deviations)` gives `{ problems,
 * deviations }`: every way the run differs from what the contract wants,
 * as text (empty when it holds), and the deviation ids asserted.
 */

const crypto = require('crypto');
const { heldOf } = require('./swarm-vectors');

/**
 * Canonical JSON: keys sorted, `undefined`, bigints and byte arrays named,
 * so two values compare equal whatever realm built them (the module
 * registry's or the test's).
 */
function canonical(value) {
  if (value === undefined) return '"<undefined>"';
  if (typeof value === 'bigint') return `"<bigint ${value}>"`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (ArrayBuffer.isView(value) || Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
    const tag = Object.prototype.toString.call(value);
    return `"<${tag} ${Buffer.from(ArrayBuffer.isView(value) ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value).toString('hex')}>"`;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

const isDeepStrictEqual = (a, b) => canonical(a) === canonical(b);

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const show = (value) => {
  const text = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
  return text && text.length > 600 && !process.env.SWARM_CONTRACT_FULL ? `${text.slice(0, 600)}…` : text;
};

/**
 * A typed answer with each large string (`string_digest`: its UTF-16
 * length and its UTF-8 bytes' SHA-256, as the generator writes one) as a
 * marker naming its digest.
 */
function markDigests(typed) {
  const [tag] = Object.keys(typed);
  if (tag === 'string_digest') return { string: `<digest ${typed.string_digest} ${typed.sha256}>` };
  if (tag === 'object') return { object: typed.object.map(([key, member]) => [key, markDigests(member)]) };
  if (tag === 'array') return { array: typed.array.map((item) => (item.hole ? item : markDigests(item))) };
  return typed;
}

/** `value` with each string the typed answer digests replaced by its marker, where its digest matches. */
function foldDigests(value, typed) {
  const [tag] = Object.keys(typed);
  if (tag === 'string_digest') {
    const same =
      typeof value === 'string' && value.length === typed.string_digest && sha256(Buffer.from(value, 'utf8')) === typed.sha256;
    return same ? `<digest ${typed.string_digest} ${typed.sha256}>` : value;
  }
  if (tag === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const out = { ...value };
    for (const [key, member] of typed.object) if (Object.hasOwn(out, key)) out[key] = foldDigests(out[key], member);
    return out;
  }
  if (tag === 'array' && Array.isArray(value)) {
    return value.map((item, i) => (typed.array[i] && !typed.array[i].hole ? foldDigests(item, typed.array[i]) : item));
  }
  return value;
}

/** A step's recorded answer as the page got it: `{ result }`, `{ error }`, `{ digest }`, and its typed form if any. */
function expectedAnswer(step) {
  if (step.result_typed !== undefined) return { result: heldOf(markDigests(step.result_typed), []), typed: step.result_typed };
  if (step.error_typed !== undefined) return { error: heldOf(markDigests(step.error_typed), []), typed: step.error_typed };
  if (step.result_digest !== undefined) return { digest: step.result_digest };
  if ('error' in step) return { error: step.error };
  return { result: step.result };
}

/** Whether a run's answer is `want`: a digest is a large result's JSON length and SHA-256. */
function sameAnswer(got, want) {
  if (want.digest) {
    if (!('result' in got)) return false;
    const text = JSON.stringify(got.result);
    return text.length === want.digest.json_length && sha256(Buffer.from(text, 'utf8')) === want.digest.sha256;
  }
  const { typed, ...plain } = want;
  if (typed) {
    const key = 'result' in plain ? 'result' : 'error';
    got = key in got ? { [key]: foldDigests(got[key], typed) } : got;
  }
  return isDeepStrictEqual(got, plain);
}

/**
 * A history row as SQLite hands it back: a number bound to the `name`
 * column (TEXT affinity) reads as its REAL text, `7.0`, as the reference's
 * better-sqlite3 gave it. The JS backend's run uses the in-memory fake
 * (test/helpers/fake-better-sqlite3-publishes.js: CI installs without
 * better-sqlite3's native build), which keeps the number.
 */
function sqliteName(row) {
  if (typeof row?.name !== 'number' || !Number.isFinite(row.name)) return row;
  return { ...row, name: Number.isInteger(row.name) ? `${row.name}.0` : String(row.name) };
}

// Main's own headers, which it sends first on every node call
// (core/swarm-grammar.js `MAIN_HEADERS`); the reference's bee-js sent the
// first of them on most.
const MAIN_HEADERS = [
  ['accept', 'application/json, text/plain, */*'],
  ['accept-encoding', 'identity'],
];
const isMain = ([name, value]) => MAIN_HEADERS.some(([n, v]) => n === name && v === value);

/**
 * A request as both backends are compared: what crossed to the node. On
 * `core`, main's executor makes every call, with main's own headers
 * first, so those headers are left out on both sides, and so is the
 * caller's transport (`via`).
 */
function wire(request, backend = 'js') {
  const out = backend === 'js' ? { via: request.via } : {};
  Object.assign(out, { method: request.method, path: request.path });
  if (request.query?.length) out.query = request.query;
  const headers = backend === 'js' ? request.headers || [] : (request.headers || []).filter((h) => !isMain(h));
  if (headers.length) out.headers = headers;
  if (request.body) out.body = request.body;
  out.status = request.status ?? null;
  if (request.soc_valid !== undefined) out.soc_valid = request.soc_valid;
  return out;
}

/**
 * The requests the core makes in place of the reference's, by the
 * request-level marks the vectors give (`deviation_requests` in
 * swarm-grammar.json): the second `GET /stamps` of a write
 * (`stamps-one-read`) and the `GET /chunks/<root>` after a feed entry's
 * `POST /bytes` (`feed-wrap-root`) aren't made; an index lookup's
 * `GET /feeds` asks `swarm-only-root-chunk: true` (`index-probe`); and
 * readData's whole `GET /bytes` is the verified walk's chunk reads and
 * ranged `/bytes` (`read-data-verified`, a `{ walk }` mark here).
 */
function coreWants(requests) {
  const out = [];
  for (const request of requests) {
    if (request.deviation === 'stamps-one-read' || request.deviation === 'feed-wrap-root') continue;
    if (request.deviation === 'read-data-verified') {
      out.push({ walk: request.path.slice('/bytes/'.length) });
      continue;
    }
    const want = wire(request, 'core');
    if (request.deviation === 'index-probe') want.headers = [...(want.headers || []), ['swarm-only-root-chunk', 'true']];
    out.push(want);
  }
  return out;
}

/**
 * A feed update's SOC as the reference's clock would have written it: its
 * payload is the update's time (8 bytes, seconds) and a reference, so the
 * core's clock gives another time and so another signature. Taken as the
 * reference's when only those differ, the time is the run's (`window`), and
 * the node found the signature the owner's (`soc_valid`).
 */
function retimedSoc(got, want, window) {
  if (got?.method !== 'POST' || !got.path.startsWith('/soc/') || got.path !== want?.path || !got.soc_valid) return got;
  const a = Buffer.from(got.body?.base64 ?? '', 'base64');
  const b = Buffer.from(want.body?.base64 ?? '', 'base64');
  if (a.length !== b.length || a.length < 16 || !a.subarray(0, 8).equals(b.subarray(0, 8))) return got;
  if (!a.subarray(16).equals(b.subarray(16))) return got;
  const seconds = Number(a.readBigUInt64BE(8));
  if (seconds < Math.floor(window.from / 1000) - 2 || seconds > Math.ceil(window.to / 1000) + 2) return got;
  const sig = (r) => r.query?.filter(([name]) => name !== 'sig');
  if (!isDeepStrictEqual(sig(got), sig(want))) return got;
  return { ...want };
}

// The verified walk's chunk calls the core holds open at once
// (fc-swarm-provider's read_data.rs `OPEN_AT_ONCE`; the grammar's "8 open
// at once"): those may reach the node in any order.
const OPEN_AT_ONCE = 8;

/**
 * Whether `got` is the verified walk `walk` (swarm-contract-node.js
 * `verifiedWalk`): request for request, each path, header and status, as
 * many as the walk has, in its groups' order (the tree's chunks, the
 * ranged `/bytes`, the leaves fetched again), and within a group in the
 * walk's order but for the calls open at once, which may arrive at most
 * seven places from it.
 */
function sameWalk(got, walk) {
  if (got.length !== walk.length) return false;
  const used = new Set();
  return got.every((one, i) => {
    const j = walk.findIndex(
      (w, n) =>
        !used.has(n) && w.group === walk[i].group && Math.abs(n - i) < OPEN_AT_ONCE && isDeepStrictEqual(strip(one), w.request)
    );
    if (j === -1) return false;
    used.add(j);
    return true;
  });
}

/**
 * Whether the core's requests are `wants`, each in order, a `{ walk }`
 * mark standing for that root's verified walk (`walks`, by root: the
 * step's, from runCase).
 */
function sameRequests(got, wants, { window, walks = {} } = {}) {
  let at = 0;
  for (const want of wants) {
    if (want.walk) {
      const walk = walks[want.walk];
      if (!walk || !sameWalk(got.slice(at, at + walk.length), walk)) return false;
      at += walk.length;
      continue;
    }
    const one = window ? retimedSoc(got[at], want, window) : got[at];
    if (!isDeepStrictEqual(strip(one), strip(want))) return false;
    at += 1;
  }
  return at === got.length;
}

/** Whether a node rule's `match` takes request `r` (swarm-contract-node.js `matches`). */
const ruleTakes = (match, r) =>
  (!match.method || match.method === r.method) &&
  (!match.path || match.path === r.path) &&
  (!match.prefix || r.path.startsWith(match.prefix));

/**
 * Where among `wants` (the reference's requests as the core makes them)
 * the core's own refusal is: the last request whose reply the case
 * scripts, by a node rule or by `stamps_label_bytes` (the stamps reply
 * past the cap); a `{ walk }` mark is its root's `GET /bytes`. -1 when the
 * case scripts none.
 */
function failingAt(kase, wants) {
  const rules = kase.node?.rules || [];
  const scripted = (r) =>
    rules.some(({ match }) => ruleTakes(match, r)) ||
    (kase.node?.stamps_label_bytes !== undefined && r.method === 'GET' && r.path === '/stamps');
  for (let i = wants.length - 1; i >= 0; i--) {
    if (scripted(wants[i].walk ? { method: 'GET', path: `/bytes/${wants[i].walk}` } : wants[i])) return i;
  }
  return -1;
}

/** A request without what isn't compared: the node's own SOC check. */
function strip(request) {
  if (!request || typeof request !== 'object') return request;
  const { soc_valid: _valid, ...rest } = request;
  return rest;
}

/**
 * The core's clock writes the times the reference's fixed clock did
 * (`clocks`: the case's and its steps'): a number or an ISO time the run
 * wrote within its window, where the reference has one of the clocks, is
 * taken as that clock. Walks `got` along `want`.
 */
function clockFixer(clocks, window) {
  const iso = new Set(clocks.map((t) => new Date(t).toISOString()));
  const within = (t) => t >= window.from - 1000 && t <= window.to + 1000;
  const spent = window.to - window.from + 1000;
  const fix = (got, want, key) => {
    if (typeof want === 'number' && clocks.includes(want) && typeof got === 'number' && within(got)) return want;
    // A wait the core's running clock has shortened since its window began.
    if (key === 'retryAfterMs' && typeof want === 'number' && typeof got === 'number' && got <= want && got >= want - spent) {
      return want;
    }
    if (typeof want === 'string' && iso.has(want) && typeof got === 'string' && within(Date.parse(got))) return want;
    if (Array.isArray(got) && Array.isArray(want)) return got.map((item, i) => fix(item, want[i]));
    if (got && want && typeof got === 'object' && typeof want === 'object' && !Array.isArray(got)) {
      return Object.fromEntries(Object.entries(got).map(([name, value]) => [name, fix(value, want[name], name)]));
    }
    return got;
  };
  return fix;
}

/** A store file's text with the core's times fixed, as it would read with the reference's clock. */
function fixedText(got, want, fix) {
  if (typeof got !== 'string' || typeof want !== 'string') return got;
  try {
    return JSON.stringify(fix(JSON.parse(got), JSON.parse(want)), null, 2);
  } catch {
    return got;
  }
}

/** The prompts a step's recorded events show. */
const promptsOf = (step) => (step.events || []).filter((e) => e.prompt).map((e) => e.prompt);

/**
 * The vectors' `core` answers the browser's own route test now reads
 * otherwise: the suite holds these cases to the reference's answer on both
 * backends, and counts them. Not changed here: they are freedom-core's
 * vectors to update.
 */
const KNOWN_CORE_VECTOR_DIFFERENCES = Object.freeze({
  'subscribe-gsoc-topic-remote-node-tor':
    "Tor on, no proxy, a node at a normal address: the vectors' core answer refuses it (subscribe-proxy, written " +
    'before design 0015\'s 2026-11-28 amendment, "Question 4\'s test"); Freedom\'s Tor carries `.onion` names only, so ' +
    "main's route test reads the node DIRECT and both backends subscribe, as the reference did. A core vectors update, " +
    'after the user answers U-1 (the SWM-6 to SWM-9 plan, point 14)',
});

/**
 * The deviation a case is held to on `backend`, or null for the
 * reference's answers. Every deviation is the core's; `subscribe-proxy`'s
 * refusal is main's own route test (subscription-registry.js, SWM-7's PR
 * 7.3), which both backends run, so a case with a proxy on is held to it
 * on `js` too. A known core-vectors difference
 * (`KNOWN_CORE_VECTOR_DIFFERENCES`) is held to the reference on both.
 */
function deviationOn(backend, kase) {
  if (!kase.deviation || Object.hasOwn(KNOWN_CORE_VECTOR_DIFFERENCES, kase.id)) return null;
  if (kase.deviation === 'subscribe-proxy') return 'subscribe-proxy';
  return backend === 'core' ? kase.deviation : null;
}

/** What the core answers in a deviation's place: `exact` (the case's `core`), `cancelled`, `transport`, or the reference's. */
function deviationWant(kase) {
  if (kase.core && typeof kase.core === 'object') return 'exact';
  if (kase.deviation === 'deadlines') return 'cancelled';
  if (kase.deviation === 'transport-error-text') return 'transport';
  return 'reference';
}

/**
 * A prompt's view on `core`, its Ethereum wallet identities as the
 * reference showed them: the core's vault always holds the main wallet
 * (index 0, `Main Wallet`, which can't be removed), where the generator's
 * vault listed no account, so the reference showed no owner and the label
 * `Ethereum wallet`. Only those two, only for the main wallet's identity
 * (`mainWallet`: its address in the core's vault).
 */
function walletLabels(prompt, want, mainWallet) {
  const ids = prompt?.view?.identities;
  const wanted = want?.view?.identities;
  if (!Array.isArray(ids) || !Array.isArray(wanted)) return prompt;
  const identities = ids.map((identity, i) =>
    identity?.id === 'ethereum-wallet:0' &&
    wanted[i]?.id === 'ethereum-wallet:0' &&
    wanted[i].label === 'Ethereum wallet' &&
    wanted[i].owner === null &&
    identity.owner === mainWallet
      ? { ...identity, label: wanted[i].label, owner: null }
      : identity
  );
  return { ...prompt, view: { ...prompt.view, identities } };
}

/** History rows in insertion order: the reference's fixed clock gave them all one time, so its newest-first order is by id. */
const byId = (rows) => [...rows].sort((a, b) => a.id - b.id);

// What the page gets when the core cancels its request at the page's timer
// (`deadlines`): the core's `cancelled` (service-client.js `cancelled()`),
// which page-swarm-core.js's `failure` hands on as -32603 with its text.
const CANCELLED = Object.freeze({ code: -32603, message: 'Cancelled' });
// The text a cancelled request's history row ends with (design 0015,
// "Main cancels": "A history row ends `failed` with the text
// `cancelled`").
const CANCELLED_ROW = 'cancelled';

/**
 * The stores a deviation leaves, from the recorded ones and the core's
 * answer (`answer`: the case's `core`, or for `cancelled` and `transport`,
 * what the step answered, whose code and data are already held to the
 * reference's): the case's own `core.after` where it names one; else the
 * feed store as recorded, and each history row as recorded, but ended as
 * the core's answer ends it. A failed answer fails the row: status
 * `failed`, the answer's text as its error (`cancelled` for a cancel), and
 * no reference, URL, tag or batch, as every failed row the reference
 * writes has none. A refusal before any node call (`core_before`) comes
 * before the row too, as the reference's own size refusals write none
 * (`publish-data-too-large`). The core's times are held to the run's
 * window by the caller. Every such deviation is one step, so its rows are
 * that step's.
 */
function deviationAfter(kase, how, answer) {
  if (how === 'exact' && kase.core.after) return kase.core.after;
  if (kase.core_before === 'any node call') return { feeds: kase.after.feeds, history: [] };
  if (!('error' in answer)) return kase.after;
  const text = how === 'cancelled' ? CANCELLED_ROW : answer.error.message;
  const failed = (row) => ({
    ...row,
    status: 'failed',
    reference: null,
    bzzUrl: null,
    tagUid: null,
    batchIdUsed: null,
    errorMessage: text,
  });
  return { feeds: kase.after.feeds, history: kase.after.history.map(failed) };
}

function compareCase(backend, kase, record) {
  const problems = [];
  const deviation = deviationOn(backend, kase);
  const clocks = [kase.clock, ...kase.steps.map((step) => step.clock).filter((t) => t !== undefined)];
  const fix = backend === 'core' ? clockFixer(clocks, record.window) : (got) => got;
  const how = deviation ? deviationWant(kase) : 'reference';
  const last = kase.steps.length - 1;
  // The core's answer in the deviation's place, for its stores.
  let deviated = null;
  kase.steps.forEach((step, k) => {
    const ran = record.steps[k];
    if (ran.skipped) return;
    const got = 'error' in ran ? { error: ran.error } : { result: ran.result };
    const gotRequests = ran.requests.map((r) => wire(r, backend));
    for (const r of gotRequests) if (r.soc_valid === false) problems.push(`step ${k}: a SOC whose signature isn't its owner's: ${r.path}`);
    let wantRequests = backend === 'core' ? coreWants(step.requests || []) : (step.requests || []).map((r) => wire(r));
    let want = expectedAnswer(step);
    if (how === 'exact' && k === last) {
      want = 'error' in kase.core ? { error: kase.core.error } : { result: kase.core.result };
      deviated = want;
      if (kase.core.requests) {
        // The vector names the core's requests.
        wantRequests = kase.core.requests.map((r) => wire(r, backend));
      } else if (kase.core_before === 'any node call' || deviation === 'subscribe-proxy') {
        // Refused before any node call: F-4's bound before the upload; the
        // route test before the subscribe's probe (subscription-registry.js
        // `checkRoute`, both backends).
        wantRequests = [];
      } else if ('error' in kase.core) {
        // A refusal of the core's own, mid-way: the reference's requests
        // through the one the core refuses, exactly.
        const at = failingAt(kase, wantRequests);
        if (at === -1) problems.push(`step ${k}: no request the case scripts for the core's refusal ${show(kase.core.error)}`);
        else wantRequests = wantRequests.slice(0, at + 1);
      }
    }
    if (how === 'cancelled' && k === last) {
      // The page gave up as a request reached the node: the core answers
      // cancelled, and asks nothing more. That request's own reply, which
      // comes after, is nobody's.
      const rules = (kase.node.rules || []).filter((rule) => rule.reply?.abortPage);
      const hit = (r) => rules.some(({ match }) => ruleTakes(match, r));
      const upTo = wantRequests
        .slice(0, wantRequests.findIndex(hit) + 1)
        .map((r, i, all) => (i === all.length - 1 ? { ...r, status: null } : r));
      const seen = gotRequests.map((r, i) => (i === gotRequests.length - 1 ? { ...r, status: null } : r));
      if (!upTo.length || !sameRequests(seen, upTo, { window: record.window, walks: ran.walks })) {
        problems.push(`step ${k}: requests until the page gave up: ${show(gotRequests)} against ${show(upTo)}`);
      }
      if (!isDeepStrictEqual(got, { error: CANCELLED })) {
        problems.push(`step ${k}: cancelled at the page's timer, yet answered ${show(got)} against ${show({ error: CANCELLED })}`);
      }
      deviated = got;
      return;
    }
    if (how === 'transport' && k === last) {
      // One text per failure class: the reference's code and data, the
      // core's text; and the reference's requests, which end at the failure.
      const same = 'error' in got && got.error.code === want.error?.code && typeof got.error.message === 'string';
      if (!same || !isDeepStrictEqual(got.error.data, want.error?.data)) {
        problems.push(`step ${k}: a transport failure answered ${show(got)} against code ${want.error?.code}`);
      }
      deviated = got;
    } else if (!sameAnswer(fix(got, want), want)) {
      problems.push(`step ${k} answer: ${show(got)} against ${show(want)}`);
    }
    const same =
      backend === 'core'
        ? sameRequests(gotRequests, wantRequests, { window: record.window, walks: ran.walks })
        : isDeepStrictEqual(gotRequests.map(strip), wantRequests);
    if (!same) problems.push(`step ${k} requests: ${show(gotRequests)} against ${show(wantRequests)}`);
    if (deviation === 'stamps-one-read') {
      const reads = gotRequests.filter((r) => r.method === 'GET' && r.path === '/stamps').length;
      if (reads > 1) problems.push(`step ${k}: ${reads} GET /stamps, against one`);
    }
    const wantPrompts = promptsOf(step);
    const gotPrompts = backend === 'core' ? ran.prompts.map((p, i) => walletLabels(p, wantPrompts[i], record.mainWallet)) : ran.prompts;
    if (!isDeepStrictEqual(gotPrompts, wantPrompts)) {
      problems.push(`step ${k} prompts: ${show(ran.prompts)} against ${show(wantPrompts)}`);
    }
  });
  const wantSockets = how === 'exact' && kase.core.websockets ? kase.core.websockets : kase.websockets || [];
  if (!isDeepStrictEqual(record.websockets, wantSockets)) {
    problems.push(`websockets: ${show(record.websockets)} against ${show(wantSockets)}`);
  }
  // The stores: the reference's, or what the deviation leaves.
  let wantAfter = kase.after;
  if (how !== 'reference') {
    if (kase.steps.length !== 1) problems.push(`a deviation (${how}) of ${kase.steps.length} steps: its rows can't be told apart`);
    if (deviated) wantAfter = deviationAfter(kase, how, deviated);
    else problems.push(`no answer in the deviation's place (${how})`);
  }
  if (fixedText(record.after.feeds, wantAfter.feeds, fix) !== wantAfter.feeds) {
    problems.push(`feeds after: ${show(record.after.feeds)} against ${show(wantAfter.feeds)}`);
  }
  const rows = backend === 'core' ? byId(record.after.history) : record.after.history;
  const wantRows = backend === 'core' ? byId(wantAfter.history) : wantAfter.history;
  if (!isDeepStrictEqual(fix(rows.map(sqliteName), wantRows), wantRows)) {
    problems.push(`history after: ${show(record.after.history)} against ${show(wantAfter.history)}`);
  }
  if (record.exits?.length) problems.push(`the core exited: ${show(record.exits)}`);
  const deviations = deviation ? [deviation, ...(kase.also || [])] : [];
  return { problems, deviations };
}

/**
 * The vectors' cases the core's backend can't be played on as they were
 * recorded, each with why. The suite plays them on `js` and counts them
 * left out on `core`.
 */
const LEFT_OUT_ON_CORE = Object.freeze({
  'read-chunk-request-budget-window':
    "a step at a later clock (the read budget's next window): the core keeps its own clock, which nothing here moves",
  'send-pss-targets-megabyte':
    "1 MiB of targets: past every request's 1 MiB bound (shared/page-request-bounds.js), which page-requests answers before either backend",
  'capabilities-grants-unavailable':
    "main's grant mirror not loaded: the JS backend reads the core's grants through it; the core's backend reads its own",
});

/** The run's counts, printed after the suite. */
function summary(backend, seen, outside) {
  const lines = [`[swarm contract] ${backend}: ${seen.played} cases played`];
  lines.push(`  left out (executeSwarmMethod with no page, not window.swarm through the dispatcher): ${outside.length}`);
  if (backend === 'core') {
    for (const [id, why] of Object.entries(LEFT_OUT_ON_CORE)) lines.push(`  left out on core: ${id} (${why})`);
  }
  for (const id of Object.keys(KNOWN_CORE_VECTOR_DIFFERENCES)) {
    lines.push(`  known core-vectors difference, held to the reference: ${id}`);
  }
  for (const [id, count] of [...seen.deviations].sort()) lines.push(`  deviation ${id}: ${count}`);
  return lines.join('\n');
}

module.exports = { KNOWN_CORE_VECTOR_DIFFERENCES, LEFT_OUT_ON_CORE, compareCase, deviationOn, expectedAnswer, sameAnswer, summary, wire };
