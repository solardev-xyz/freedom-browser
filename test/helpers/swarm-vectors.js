/**
 * freedom-core's Swarm vectors (design 0015, Vectors; design 0009, Files):
 * `vectors/swarm-grammar.json` (the operation grammar, with each row's
 * honest calls and forbidden alternatives), `vectors/swarm.json` (the JS
 * reference's recording: methods, trees, bodies, feeds) and
 * `vectors/dweb-verify.json` (Ant's and Bee's file trees and their chunks).
 *
 * Found as the other vector suites find theirs: FREEDOM_CORE_SWARM_VECTORS
 * names freedom-core's `vectors` directory, or it is FREEDOM_CORE_VECTORS's
 * directory, or the one in the freedom-core checkout FREEDOM_CORED_PATH was
 * built in. `swarmVectors(name)` is `null` when a file isn't found; the
 * suites skip then, unless FREEDOM_CORE_SWARM_VECTORS names the directory
 * (`swarmVectorsRequired`), as CI does at the pinned commit.
 *
 * `playScenario` plays one grammar scenario through main's Admission
 * (swarm-grammar.js), call by call, answering each admitted call with the
 * scenario's reply, and gives the first refusal `{ at, rule }` (`at` -1 for
 * the ready check), or null when every call was admitted. A scenario writes
 * a call as main sends it and its reply as the node gave it; the core's
 * `shell.swarm_api` call is read from it as the core writes one:
 * - **headers** without main's own two (`main_headers`), which every
 *   scenario call starts with;
 * - **the body** in the form the core sends: `{ stream }` for a form that
 *   only streams, `{ base64 }` for one that takes only base64, and for
 *   `bzz_file` base64 when the data rides in the params (the core's
 *   `INLINE_BODY` rule), else a stream. A part main's own params name
 *   (`{ part: k }`, fc-swarm-provider's `Piece::Part`) is always streamed,
 *   whatever its length, its bytes part k's in the scenario's `parts`
 *   (`partBytes`); a form with a body whose scenario recorded none (an
 *   empty upload) gets the empty `{ base64: '' }`;
 * - **`max_bytes`** as recorded, else the form's whole-reply cap, or B for a
 *   streamed `feed_latest` (the site's `maxBytes`, which the scenarios
 *   don't record);
 * - **replies:** a chunk's body inline or from dweb-verify.json's chunk
 *   store (`body_ref`); `bytes_up`'s reference, which the scenarios don't
 *   record, is the root the reference read back (the `feed-wrap-root`
 *   request that follows the upload in swarm.json's methods case).
 * Main's own rows' params are the scenarios' own, whole, in the wire form
 * main sends (from cored-v0.30.0's vectors, which carry `pin`, `deferred`
 * and a part's `base64` or `part` themselves: SWM-4's #497).
 *
 * Its parts (`coreCall`, `replyOf`, `uploadReferences`) are exported for the
 * suites that play a scenario through more than the Admission:
 * swarm-shell.test.js plays each through main's executor, its node answering
 * with the scenario's replies.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Admission, FORMS, MAIN_HEADERS, B } = require('../../src/main/core/swarm-grammar');
const { SwarmData, param, readTyped } = require('../../src/main/core/swarm-typed');

function swarmVectorsDir() {
  if (process.env.FREEDOM_CORE_SWARM_VECTORS) return process.env.FREEDOM_CORE_SWARM_VECTORS;
  if (process.env.FREEDOM_CORE_VECTORS) return path.dirname(process.env.FREEDOM_CORE_VECTORS);
  const binary = process.env.FREEDOM_CORED_PATH;
  if (!binary) return null;
  for (let dir = path.dirname(path.resolve(binary)); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'vectors');
    if (fs.existsSync(path.join(candidate, 'swarm-grammar.json'))) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

const dir = swarmVectorsDir();
const swarmVectorsRequired = Boolean(process.env.FREEDOM_CORE_SWARM_VECTORS);
const loaded = new Map();

/** A vectors file by name, parsed once; null when it isn't there. */
function swarmVectors(name) {
  if (!loaded.has(name)) {
    const file = dir && path.join(dir, name);
    loaded.set(
      name,
      file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
    );
  }
  return loaded.get(name);
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * content(seed, n): SHA-256(seed ‖ u64_be(i)) for i = 0, 1, …, concatenated
 * and cut to n bytes; `contentSlice` gives bytes [start, end) of it alone.
 */
function contentSlice(seed, start, end) {
  const first = Math.floor(start / 32);
  const blocks = Math.ceil(end / 32) - first;
  const out = Buffer.alloc(blocks * 32);
  const input = Buffer.alloc(Buffer.byteLength(seed) + 8);
  input.write(seed);
  for (let k = 0; k < blocks; k++) {
    input.writeBigUInt64BE(BigInt(first + k), input.length - 8);
    crypto
      .createHash('sha256')
      .update(input)
      .digest()
      .copy(out, k * 32);
  }
  return out.subarray(start - first * 32, end - first * 32);
}

const content = (seed, n) => contentSlice(seed, 0, n);

/** A vectors data spec: `{ utf8 }`, `{ hex }`, `{ base64 }` or `{ seed, length }`. */
function dataOf(spec) {
  if (spec.utf8 !== undefined) return Buffer.from(spec.utf8, 'utf8');
  if (spec.hex !== undefined) return Buffer.from(spec.hex, 'hex');
  if (spec.base64 !== undefined) return Buffer.from(spec.base64, 'base64');
  return content(spec.seed, spec.length);
}

/** The roots the reference read back after each `POST /bytes` of a scenario's methods case, in order. */
function uploadReferences(scenario, grammar, swarm) {
  let from = scenario.from;
  if (from.startsWith('honest/')) {
    from = grammar.honest.find((s) => s.id === from.slice('honest/'.length))?.from || '';
  }
  if (!from.startsWith('methods/')) return [];
  const [id, step] = from.slice('methods/'.length).split('/');
  const method = swarm.methods.find((m) => m.id === id);
  const requests = method?.steps[step === undefined ? 0 : Number(step)]?.requests || [];
  const out = [];
  requests.forEach((request, i) => {
    if (request.method !== 'POST' || request.path !== '/bytes') return;
    const back = requests[i + 1];
    out.push(back?.deviation === 'feed-wrap-root' ? back.path.slice('/chunks/'.length) : null);
  });
  return out;
}

/** The params the Admission takes: a page's typed form read back, or main's own JSON, as the scenario writes them. */
function scenarioParams(scenario) {
  if (scenario.row.startsWith('swarm.')) return structuredClone(scenario.params);
  return scenario.params === undefined ? undefined : readTyped(scenario.params);
}

/**
 * The part main's own `swarm.publish` data or file params name for its
 * `bzz_file` body (`{ bytes, part }`), or null: a page's typed form, a
 * part that rides in the params (`base64`), a collection or another row.
 */
function namedPart(c, params) {
  if (c.form !== 'bzz_file' || !Array.isArray(params?.parts) || params.parts.length !== 1) {
    return null;
  }
  const part = params.parts[0];
  return part && Number.isInteger(part.part) ? part : null;
}

/**
 * The bytes a scenario's call streams from a part its params name: part
 * k's in the scenario's `parts`, which main reads for the core
 * (`shell.swarm_part`) and the core sends back as the call's body
 * (`swarm.body`). Null for a call that streams no named part.
 */
function partBytes(scenario, params, c) {
  const part = namedPart(c, params);
  if (!part) return null;
  const source = scenario.parts?.[part.part];
  if (typeof source?.base64 !== 'string') {
    throw new Error(`${scenario.id}: no bytes for part ${part.part} in its parts`);
  }
  return Buffer.from(source.base64, 'base64');
}

/** The core's `shell.swarm_api` call for a scenario's call. */
function coreCall(c, params) {
  const form = FORMS[c.form];
  const main = Object.entries(MAIN_HEADERS);
  const headers = c.headers || [];
  if (JSON.stringify(headers.slice(0, 2)) !== JSON.stringify(main)) {
    throw new Error(`a scenario call without main's headers first: ${c.form} ${c.path}`);
  }
  const call = {
    form: c.form,
    method: c.method,
    path: c.path,
    query: c.query || [],
    headers: headers.slice(2),
  };
  if (!form) return call;
  const kinds = form.body || [];
  const part = namedPart(c, params);
  if (part) {
    call.body = { stream: c.body?.bytes ?? 0 };
  } else if (!c.body && kinds.includes('base64')) {
    call.body = { base64: '' };
  } else if (c.body) {
    if (!kinds.includes('base64')) {
      call.body = { stream: c.body.bytes };
    } else if (!kinds.includes('stream') || c.body.base64 !== undefined) {
      call.body = { base64: c.body.base64 };
    } else {
      const data = param(params, 'data');
      const inline =
        data instanceof SwarmData && data.bytes && sha256(data.bytes) === c.body.sha256;
      call.body = inline ? { base64: data.bytes.toString('base64') } : { stream: c.body.bytes };
    }
  }
  call.max_bytes = c.max_bytes ?? form.reply.whole ?? B;
  call.stream = Boolean(form.reply.stream);
  if (c.feed !== undefined) call.feed = c.feed;
  if (c.tree !== undefined) call.tree = c.tree;
  return call;
}

/** Main's answer to an admitted call, as the scenario's reply gives it. */
function replyOf(c, chunks, references) {
  if (!c.reply) return null;
  const reply = { status: c.reply.status, headers: Object.entries(c.reply.headers || {}) };
  if (c.reply.body?.base64 !== undefined) reply.body = Buffer.from(c.reply.body.base64, 'base64');
  else if (c.reply.body_ref)
    reply.body = Buffer.from(chunks[c.path.slice('/chunks/'.length)], 'base64');
  if (c.form === 'bytes_up') {
    const reference = references.shift();
    if (reference) reply.body = Buffer.from(JSON.stringify({ reference }));
  }
  return reply;
}

/**
 * Plays a scenario: the first refusal `{ at, rule }`, or null when every
 * call was admitted. `admitted` counts the calls admitted.
 */
function playScenario(scenario, { grammar, swarm, dwebVerify }) {
  const params = scenarioParams(scenario);
  const admission = new Admission({ row: scenario.row, params, key: scenario.key ?? null });
  if (scenario.ready) {
    const rule = admission.ready(scenario.ready.check);
    if (rule) return { at: -1, rule, admitted: 0 };
    admission.readyAnswered(scenario.ready.ok);
  }
  const references = uploadReferences(scenario, grammar, swarm);
  for (const [at, c] of scenario.calls.entries()) {
    const verdict = admission.admit(coreCall(c, params));
    if (verdict.rule) return { at, rule: verdict.rule, admitted: at };
    admission.settle(verdict.ticket, replyOf(c, dwebVerify.swarm.chunks, references));
  }
  return null;
}

module.exports = {
  content,
  contentSlice,
  coreCall,
  dataOf,
  partBytes,
  playScenario,
  replyOf,
  scenarioParams,
  sha256,
  swarmVectors,
  swarmVectorsDir: dir,
  swarmVectorsRequired,
  uploadReferences,
};
