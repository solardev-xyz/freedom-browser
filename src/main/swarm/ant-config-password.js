/**
 * The `password:` key of Ant's config.yaml, read and written as YAML (K-3).
 *
 * Ant (v0.5.77, `crates/antd/src/config.rs`) loads config.yaml with
 * serde_yaml 0.9 into `password: Option<String>`, so the password it opens
 * the keystore with is the decoded scalar, not the line's text:
 * `password: "abc"` and `password: abc # note` are both `abc`. Moving that
 * password into the OS keychain hands it to antd as raw `--password-file`
 * bytes, so it has to be decoded exactly as Ant would first, or the keystore
 * would no longer open.
 *
 * Only single-line scalars are decoded: plain, single-quoted and
 * double-quoted, with a trailing comment. Anything else (a block or
 * multi-line scalar, a tag, an anchor or alias, a flow collection, a
 * duplicate key) is reported as `raw`: the caller keeps that line exactly as
 * it is and lets Ant read it, rather than guess at the password.
 */

// serde_yaml's null forms: `password:` with one of these is no password.
const NULL_PLAIN = new Set(['', '~', 'null', 'Null', 'NULL']);

// A plain scalar cannot start with these indicators (YAML 1.2 §7.3.3).
// `-`, `?` and `:` may start one when a non-space follows; any other
// indicator here makes the value something other than a plain string.
const PLAIN_FORBIDDEN_START = /^[,[\]{}#&*!|>'"%@`]/;
const PLAIN_INDICATOR_START = /^[-?:](?:[ \t]|$)/;

// Double-quoted escapes, as libyaml (serde_yaml's parser) reads them.
const SIMPLE_ESCAPES = {
  0: '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  '\t': '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\u0085',
  _: ' ',
  L: ' ',
  P: ' ',
};
const HEX_ESCAPE_LENGTH = { x: 2, u: 4, U: 8 };

class Unsupported extends Error {}

// What may follow a quoted scalar on its line: nothing, or a comment after
// whitespace (`"abc"#x` is not valid YAML).
function assertTrailer(rest) {
  if (!/^(?:[ \t]+(?:#.*)?)?$/.test(rest)) throw new Unsupported('text after a quoted scalar');
}

function decodeDoubleQuoted(text) {
  let out = '';
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      assertTrailer(text.slice(i + 1));
      return out;
    }
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const esc = text[++i];
    if (esc === undefined) break; // a line-ending escape continues the scalar
    if (Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, esc)) {
      out += SIMPLE_ESCAPES[esc];
      continue;
    }
    const length = HEX_ESCAPE_LENGTH[esc];
    const hex = length ? text.slice(i + 1, i + 1 + length) : '';
    if (!length || !new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) {
      throw new Unsupported(`escape \\${esc}`);
    }
    const code = parseInt(hex, 16);
    // libyaml refuses surrogates and code points past U+10FFFF.
    if ((code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) {
      throw new Unsupported(`escape \\${esc}${hex}`);
    }
    out += String.fromCodePoint(code);
    i += length;
  }
  throw new Unsupported('a double-quoted scalar that does not end on its line');
}

function decodeSingleQuoted(text) {
  let out = '';
  for (let i = 1; i < text.length; i++) {
    if (text[i] !== "'") {
      out += text[i];
      continue;
    }
    if (text[i + 1] === "'") {
      out += "'";
      i++;
      continue;
    }
    assertTrailer(text.slice(i + 1));
    return out;
  }
  throw new Unsupported('a single-quoted scalar that does not end on its line');
}

function decodePlain(text) {
  // A comment starts at a `#` after whitespace.
  const comment = text.search(/[ \t]#/);
  const value = (comment === -1 ? text : text.slice(0, comment)).replace(/[ \t]+$/, '');
  if (PLAIN_FORBIDDEN_START.test(value) || PLAIN_INDICATOR_START.test(value)) {
    throw new Unsupported('a value that is not a plain string');
  }
  // `: ` (or a final `:`) would make the line a nested mapping.
  if (/:(?:[ \t]|$)/.test(value)) throw new Unsupported('a mapping value');
  return NULL_PLAIN.has(value) ? null : value;
}

/**
 * The keystore password a config.yaml gives Ant.
 * @param {string} configText
 * @returns {{ kind: 'none' } | { kind: 'value', value: string } |
 *   { kind: 'raw', line: string }} `none`: no password key, or a null one;
 *   `value`: the decoded password; `raw`: a password this module does not
 *   decode, kept as its exact line.
 */
function readConfigPassword(configText) {
  const lines = String(configText).split(/\r?\n/);
  const indexes = [];
  lines.forEach((line, index) => {
    if (/^(?:password|"password"|'password')[ \t]*:/.test(line)) indexes.push(index);
  });
  if (indexes.length === 0) return { kind: 'none' };
  const line = lines[indexes[0]];
  if (indexes.length > 1 || !line.startsWith('password')) return { kind: 'raw', line };
  // libyaml breaks lines at NEL, LS and PS too.
  if (/[\u0085\u2028\u2029]/.test(line)) return { kind: 'raw', line };
  // An indented line after it continues the value over several lines.
  const next = lines[indexes[0] + 1];
  if (next !== undefined && /^[ \t]+\S/.test(next) && !/^[ \t]+#/.test(next)) {
    return { kind: 'raw', line };
  }
  const text = line.replace(/^password[ \t]*:/, '');
  if (text !== '' && !/^[ \t]/.test(text)) return { kind: 'raw', line }; // `password:x` is a key
  const scalar = text.replace(/^[ \t]+/, '');
  // Nothing but a comment after the key: a null value.
  if (scalar.startsWith('#')) return { kind: 'none' };
  try {
    let value;
    if (scalar.startsWith('"')) value = decodeDoubleQuoted(scalar);
    else if (scalar.startsWith("'")) value = decodeSingleQuoted(scalar);
    else value = decodePlain(scalar);
    if (value === null) return { kind: 'none' };
    // An empty password ("") is Ant's to read; nothing Freedom would seal.
    return value === '' ? { kind: 'raw', line } : { kind: 'value', value };
  } catch (err) {
    if (err instanceof Unsupported) return { kind: 'raw', line };
    throw err;
  }
}

/**
 * `value` as a YAML scalar Ant decodes back to exactly `value`: plain when
 * it is made of characters no YAML reading can take for syntax (a generated
 * hex password, as config.yaml always had it), double-quoted otherwise (a
 * JSON string is a valid YAML one).
 */
function yamlPasswordScalar(value) {
  if (/^[0-9A-Za-z][0-9A-Za-z._+=/-]*$/.test(value) && !NULL_PLAIN.has(value)) return value;
  // libyaml reads NEL, LS and PS as line breaks, even inside quotes.
  return JSON.stringify(value).replace(
    /[\u0085\u2028\u2029]/g,
    (ch) => ({ '\u0085': '\\N', '\u2028': '\\L', '\u2029': '\\P' })[ch]
  );
}

module.exports = { readConfigPassword, yamlPasswordScalar };
