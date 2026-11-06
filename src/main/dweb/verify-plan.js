/**
 * `{ verify }` plans (freedom-core design 0009, "Verify plans"): main's copy
 * of fc-dweb's `verify.rs`, which turns a fetch plan for an external backend
 * whose verification is on into a verify plan, and of the forms its
 * validation reads. The core is the authority; this copy is checked against
 * its vectors (`vectors/dweb-verify-plans.json`) by
 * `verify-plan-vectors.test.js` whenever they are found.
 *
 * - **What stays a fetch:** an encrypted Swarm reference (128 hex digits), a
 *   DNSLink name, and an IPNS name with an inlined key other than Ed25519.
 *   Each keeps today's fetch plan, labelled `unverified`.
 * - **The root** is the reference the fetch's path names: 64 hex digits; a
 *   CID in its canonical form (a CIDv0 converted to its CIDv1 in base32,
 *   base32 lowercased); or an IPNS name whose key is an inlined Ed25519 key
 *   or a sha2-256 multihash.
 * - **The verifier's bound** (fc-dweb's `MAX_PATH`, 8 KiB): past it the
 *   plan is a 414 (the path, with a Swarm plan's query) or a 431 (a header
 *   the verifier keeps) instead, each with fixed words. An IPFS or IPNS
 *   plan's query isn't counted: the walk never reads it, and it stays in
 *   the plan only to tie it to the admitted URL.
 * - **Strict mode** (a 403 where content would be unverified) is not here
 *   yet: it comes with the profile setting.
 */

const { cidV0ToV1Base32 } = require('../../shared/cid-utils');

/** The request headers the bundled node reads, by node. */
const VERIFY_HEADERS = { ant: ['range'], ipfs: ['range', 'if-none-match'] };
/** The bundled node's response operations, by node; IPFS adds
 * `small_text` for a GET navigation. */
const VERIFY_RESPONSE_OPS = {
  ant: ['canonicalize_redirect', 'strip_page_state'],
  ipfs: ['strip_page_state'],
};
/** The labels a verified head may carry (0009, Labels). */
const VERIFIED_CONTENT = new Set(['verified', 'latest_asserted']);

/** The most bytes the verifier takes from a plan's path, with a Swarm
 * plan's query, and from each header's value (0009, Bounds). */
const MAX_VERIFY_PATH = 8192;
/** The error plans in place of a verify plan past the bound. */
const VERIFY_BOUND_ERRORS = {
  url: { status: 414, code: 414, message: 'request URL too long to verify' },
  header: { status: 431, code: 431, message: 'request header too large to verify' },
};

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
// The longest text of a CID past its multibase prefix (fc-dweb's
// MAX_CID_TEXT): four 10-byte varints and a 128-byte digest, in base32.
const MAX_CID_TEXT = Math.ceil(((4 * 10 + 128) * 8) / 5);

/** Base36, as multibase's `k` writes it: leading zeros kept. */
function base36Decode(text) {
  let n = 0n;
  for (const c of text) {
    const v = B36.indexOf(c);
    if (v < 0) return null;
    n = n * 36n + BigInt(v);
  }
  let hex = n === 0n ? '' : n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '0') zeros++;
  return Uint8Array.from(Buffer.from('00'.repeat(zeros) + hex, 'hex'));
}

/** Lowercase base32 without padding; the bits left past the last byte are
 * dropped (`rootInForm` then requires the canonical encoding). */
function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of text) {
    const v = B32.indexOf(c);
    if (v < 0) return null;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = ((value & 0xff) << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 0x1f];
  return out;
}

/** A varint of at most 9 bytes, in any encoding: `[value, next]`. */
function readVarint(bytes, at) {
  let value = 0;
  let shift = 0;
  for (let i = at; i < bytes.length && i < at + 9; i++) {
    value += (bytes[i] & 0x7f) * 2 ** shift;
    if ((bytes[i] & 0x80) === 0) return [value, i + 1];
    shift += 7;
  }
  return null;
}

/** `readVarint` in its minimal encoding only (multiformats). */
function readMinimalVarint(bytes, at) {
  const read = readVarint(bytes, at);
  if (!read || (read[1] - at > 1 && bytes[read[1] - 1] === 0)) return null;
  return read;
}

/** A CID's four varints, each minimal, and the digest that is exactly what
 * is left; null otherwise. */
function cidParts(bytes) {
  const version = readMinimalVarint(bytes, 0);
  const codec = version && readMinimalVarint(bytes, version[1]);
  const code = codec && readMinimalVarint(bytes, codec[1]);
  const len = code && readMinimalVarint(bytes, code[1]);
  if (!len || len[1] + len[0] !== bytes.length) return null;
  return { version: version[0], digest: bytes.subarray(len[1]) };
}

/** An IPNS name's bytes: base36 (`k…`) or base32 (`b…`). */
function nameBytes(name) {
  if (name.startsWith('k')) return base36Decode(name.slice(1));
  if (name.startsWith('b')) return base32Decode(name.slice(1));
  return null;
}

/**
 * What an IPNS name, as a plan's path carries it, says of its key:
 * `ed25519` (an inlined Ed25519 key), `sha256` (a hashed key: RSA, if its
 * record checks out), `other_key` (another inlined key type), or `dnslink`
 * (not a libp2p-key CID, a name longer than any CID's text included).
 */
function ipnsNameKind(name) {
  if (name.length - 1 > MAX_CID_TEXT) return 'dnslink';
  const bytes = nameBytes(name);
  if (!bytes) return 'dnslink';
  const version = readVarint(bytes, 0);
  const codec = version && readVarint(bytes, version[1]);
  const code = codec && readVarint(bytes, codec[1]);
  const len = code && readVarint(bytes, code[1]);
  if (!len || version[0] !== 1 || codec[0] !== 0x72 || len[1] + len[0] !== bytes.length) {
    return 'dnslink';
  }
  if (code[0] === 0x12 && len[0] === 32) return 'sha256';
  if (code[0] !== 0x00) return 'other_key';
  // The inlined libp2p PublicKey: field 1, the key type, first.
  return bytes[len[1]] === 0x08 && bytes[len[1] + 1] === 0x01 ? 'ed25519' : 'other_key';
}

/** A verify plan's IPFS root in its canonical form: a CIDv0 as its CIDv1
 * in base32, base32 lowercased; anything else as it is, which validation
 * then refuses. */
function canonicalCid(target) {
  const v1 = cidV0ToV1Base32(target);
  if (v1) return v1;
  return /^b[a-z2-7]+$/i.test(target) ? target.toLowerCase() : target;
}

/**
 * Whether a verify plan's root (`{ swarm | ipfs | ipns }`) is in its form:
 * 64 hex digits; a whole CIDv1, its varints minimal, in canonical lowercase
 * base32; or an IPNS name whose multihash is a sha2-256 digest, or an
 * inlined Ed25519 key as libp2p's deterministic PublicKey writes it.
 */
function rootInForm(root) {
  if (typeof root.swarm === 'string') return /^[0-9a-fA-F]{64}$/.test(root.swarm);
  if (typeof root.ipfs === 'string') {
    const text = root.ipfs;
    if (!/^b[a-z2-7]+$/.test(text) || text.length - 1 > MAX_CID_TEXT) return false;
    const bytes = base32Decode(text.slice(1));
    if (base32Encode(bytes) !== text.slice(1)) return false;
    return cidParts(bytes)?.version === 1;
  }
  if (typeof root.ipns !== 'string') return false;
  const kind = ipnsNameKind(root.ipns);
  if (kind !== 'sha256' && kind !== 'ed25519') return false;
  const cid = cidParts(nameBytes(root.ipns));
  if (!cid) return false;
  if (kind === 'sha256') return true;
  const d = cid.digest;
  return d.length === 36 && d[0] === 0x08 && d[1] === 0x01 && d[2] === 0x12 && d[3] === 0x20;
}

/**
 * A fetch target (`/<namespace>/<reference><below>?<query>`) split as the
 * core splits it: `{ root, below, query }`, or `{ unverified }` with why the
 * content stays unverified (`encrypted`, `dnslink`, `key`).
 */
function splitTarget(node, path) {
  const at = path.indexOf('?');
  const pathPart = at < 0 ? path : path.slice(0, at);
  const query = at < 0 ? '' : path.slice(at);
  const segments = pathPart.split('/');
  const namespace = segments[1] ?? '';
  const target = segments[2] ?? '';
  const below = segments.length > 3 ? `/${segments.slice(3).join('/')}` : '';
  if (node === 'ant') {
    if (target.length === 128) return { unverified: 'encrypted' };
    return { root: { swarm: target }, below, query };
  }
  if (namespace === 'ipfs') return { root: { ipfs: canonicalCid(target) }, below, query };
  const kind = ipnsNameKind(target);
  if (kind === 'dnslink') return { unverified: 'dnslink' };
  if (kind === 'other_key') return { unverified: 'key' };
  return { root: { ipns: target }, below, query };
}

/** What of a verify plan passes the verifier's bound, in UTF-8 bytes as
 * the core counts them: `url`, `header`, or null. */
function pastBound(verify) {
  const bytes = (text) => Buffer.byteLength(text, 'utf8');
  const path = bytes(verify.path);
  if (path > MAX_VERIFY_PATH) return 'url';
  if (verify.node === 'ant' && path + bytes(verify.query) > MAX_VERIFY_PATH) return 'url';
  if (verify.headers.some(([, value]) => bytes(value) > MAX_VERIFY_PATH)) return 'header';
  return null;
}

/** Whether a fetch's target is one 0009 keeps a fetch for when
 * verification is on; any other target the core verifies. */
function staysUnverified(node, path) {
  return Boolean(splitTarget(node, path).unverified);
}

/**
 * What a fetch plan becomes for `backend`: a verify plan when its
 * verification is on and the content can be verified, else the fetch as it
 * is; a verify plan past the verifier's bound is its 414 or 431 instead.
 * `smallText` is the request's: a GET navigation.
 */
function composeVerify(plan, backend, smallText) {
  if (backend?.verify !== true || !plan.fetch) return plan;
  const { fetch } = plan;
  const split = splitTarget(fetch.node, fetch.path);
  if (split.unverified) return plan;
  const response = [...VERIFY_RESPONSE_OPS[fetch.node]];
  if (fetch.node === 'ipfs' && smallText) response.push('small_text');
  const keep = VERIFY_HEADERS[fetch.node];
  const verify = {
    node: fetch.node,
    root: split.root,
    path: split.below,
    query: split.query,
    headers: fetch.headers.filter(([name]) => keep.includes(name)),
    retry: fetch.retry,
    timers: fetch.timers,
    response,
    trust: { name: fetch.trust.name, content: 'verified' },
  };
  const past = pastBound(verify);
  return past ? { error: { ...VERIFY_BOUND_ERRORS[past] } } : { verify };
}

/** A root's reference, and its URL-space namespace. */
function rootReference(root) {
  if (typeof root.swarm === 'string') return { namespace: 'bzz', reference: root.swarm };
  if (typeof root.ipfs === 'string') return { namespace: 'ipfs', reference: root.ipfs };
  return { namespace: 'ipns', reference: root.ipns };
}

module.exports = {
  composeVerify,
  staysUnverified,
  rootInForm,
  rootReference,
  ipnsNameKind,
  canonicalCid,
  VERIFY_HEADERS,
  VERIFY_RESPONSE_OPS,
  VERIFIED_CONTENT,
  MAX_CID_TEXT,
  MAX_VERIFY_PATH,
  VERIFY_BOUND_ERRORS,
};
