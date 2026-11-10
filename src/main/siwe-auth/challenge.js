/**
 * Sign-In with Ethereum over HTTP authentication (#1152): reading a site's
 * challenge.
 *
 * A site that wants a signed-in visitor answers `401` with
 *
 *   WWW-Authenticate: SIWE realm="club.example", nonce="8nQ2vLx0mK91abCd",
 *     uri="https://club.example/members", chain-id=1, version=1,
 *     statement="Sign in to Example Club", expiration-time="…"
 *
 * an RFC 7235 challenge whose auth-params are the ERC-4361 fields the site
 * chooses. This module finds the challenge among the response's headers and
 * checks it against the request it answered. The domain the message will
 * name is never taken from the challenge: it is the host of the page
 * Freedom actually loaded, and a challenge that names another host or URI
 * origin is refused (ERC-4361's anti-phishing rule). See
 * docs/protocols/siwe-http.md.
 */

const SCHEME = 'siwe';

// RFC 9110 token characters, and a token68 credential (`abc==`).
const TCHAR = /[!#$%&'*+.^_`|~0-9A-Za-z-]/;
const TOKEN68 = /^[A-Za-z0-9._~+/-]+=*/;
// ERC-4361's grammar: a statement is RFC 3986 reserved and unreserved
// characters plus spaces (no line breaks, no non-ASCII look-alikes); a
// request ID is `*pchar`.
const STATEMENT = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;= ]+$/;
const REQUEST_ID = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})+$/;

const MAX_STATEMENT_LENGTH = 512;
const MAX_REQUEST_ID_LENGTH = 200;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse one `WWW-Authenticate` value into its challenges (RFC 9110 §11.6.1:
 * a value can hold several, comma-separated). A challenge carries either a
 * token68 credential or auth-params; param names are lowercased. A
 * challenge that repeats a name, or whose syntax breaks, is dropped along
 * with everything after it in that value.
 * @param {string} value
 * @returns {{ scheme: string, params: Object<string, string>, token68?: string }[]}
 */
function parseChallenges(value) {
  const challenges = [];
  if (typeof value !== 'string') return challenges;
  let i = 0;
  const n = value.length;
  const skipSpace = () => {
    while (i < n && (value[i] === ' ' || value[i] === '\t')) i += 1;
  };
  const skipSeparators = () => {
    while (i < n && (value[i] === ',' || value[i] === ' ' || value[i] === '\t')) i += 1;
  };
  const readToken = () => {
    const start = i;
    while (i < n && TCHAR.test(value[i])) i += 1;
    return value.slice(start, i);
  };
  const readQuoted = () => {
    // value[i] is the opening quote
    i += 1;
    let out = '';
    while (i < n) {
      const c = value[i];
      if (c === '\\') {
        if (i + 1 >= n) return null;
        out += value[i + 1];
        i += 2;
      } else if (c === '"') {
        i += 1;
        return out;
      } else {
        out += c;
        i += 1;
      }
    }
    return null;
  };

  skipSeparators();
  while (i < n) {
    const scheme = readToken();
    if (!scheme) break;
    const params = {};
    let broken = false;
    const spaced = value[i] === ' ' || value[i] === '\t';
    skipSpace();
    // `Negotiate abc==`: a token68 credential, ended by a comma or the end.
    // (`name=value` also starts like one, but goes on after its `=`.)
    const token68 = spaced ? TOKEN68.exec(value.slice(i)) : null;
    if (token68) {
      let j = i + token68[0].length;
      while (j < n && (value[j] === ' ' || value[j] === '\t')) j += 1;
      if (j >= n || value[j] === ',') {
        challenges.push({ scheme, params, token68: token68[0] });
        i = j;
        skipSeparators();
        continue;
      }
    }
    // auth-params: name = value pairs, comma separated, until the next
    // token that isn't followed by `=` (the next challenge's scheme).
    while (i < n) {
      skipSeparators();
      if (i >= n) break;
      const save = i;
      const name = readToken();
      if (!name) {
        broken = true;
        break;
      }
      skipSpace();
      if (value[i] !== '=') {
        // A token without `=`: the next challenge starts here.
        i = save;
        break;
      }
      i += 1;
      skipSpace();
      let paramValue;
      if (value[i] === '"') {
        paramValue = readQuoted();
        if (paramValue === null) {
          broken = true;
          break;
        }
      } else {
        paramValue = readToken();
        if (!paramValue) {
          broken = true;
          break;
        }
      }
      const key = name.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(params, key)) {
        broken = true;
        break;
      }
      params[key] = paramValue;
      skipSpace();
      if (i < n && value[i] !== ',') {
        broken = true;
        break;
      }
    }
    if (broken) break;
    challenges.push({ scheme, params });
    skipSeparators();
  }
  return challenges;
}

/**
 * The first SIWE challenge in a response's headers, or null.
 * @param {Object<string, string|string[]>} responseHeaders - Electron's
 *   `details.responseHeaders` (names in any case, values arrays).
 */
function findSiweChallenge(responseHeaders) {
  if (!responseHeaders || typeof responseHeaders !== 'object') return null;
  for (const [name, values] of Object.entries(responseHeaders)) {
    if (name.toLowerCase() !== 'www-authenticate') continue;
    for (const value of Array.isArray(values) ? values : [values]) {
      const found = parseChallenges(value).find((c) => c.scheme.toLowerCase() === SCHEME);
      if (found) return found;
    }
  }
  return null;
}

function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]'
  );
}

function parseTime(text) {
  if (!RFC3339.test(text)) return null;
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : time;
}

/**
 * Check a challenge against the request it answered and turn it into the
 * fields of the ERC-4361 message Freedom will build.
 * @param {Object<string, string>} params - the challenge's auth-params
 * @param {string} requestUrl - the URL Freedom loaded
 * @param {number} [now]
 * @returns {{ ok: true, challenge: Object } | { ok: false, reason: string }}
 */
function bindChallenge(params, requestUrl, now = Date.now()) {
  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  // Signing in hands the site an identity: only over HTTPS, or plain HTTP
  // to this machine for development.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    return { ok: false, reason: 'insecure_origin' };
  }
  const domain = url.host.toLowerCase();
  const p = params || {};

  if (p.realm !== undefined && p.realm.toLowerCase() !== domain) {
    return { ok: false, reason: 'realm_mismatch' };
  }

  let uri = `${url.origin}${url.pathname}${url.search}`;
  if (p.uri !== undefined) {
    let named;
    try {
      named = new URL(p.uri);
    } catch {
      return { ok: false, reason: 'uri_mismatch' };
    }
    if (named.origin !== url.origin) return { ok: false, reason: 'uri_mismatch' };
    uri = named.href;
  }

  if (typeof p.nonce !== 'string' || !/^[A-Za-z0-9]{8,}$/.test(p.nonce)) {
    return { ok: false, reason: 'invalid_nonce' };
  }

  if (p.version !== undefined && p.version !== '1') {
    return { ok: false, reason: 'unsupported_version' };
  }

  const chainIdText = p['chain-id'];
  if (
    typeof chainIdText !== 'string' ||
    !/^[1-9][0-9]{0,15}$/.test(chainIdText) ||
    !Number.isSafeInteger(Number(chainIdText))
  ) {
    return { ok: false, reason: 'invalid_chain_id' };
  }

  let statement = null;
  if (p.statement !== undefined) {
    if (p.statement.length > MAX_STATEMENT_LENGTH || !STATEMENT.test(p.statement)) {
      return { ok: false, reason: 'invalid_statement' };
    }
    statement = p.statement;
  }

  let expirationTime = null;
  if (p['expiration-time'] !== undefined) {
    const time = parseTime(p['expiration-time']);
    if (time === null) return { ok: false, reason: 'invalid_time' };
    if (time <= now) return { ok: false, reason: 'expired' };
    expirationTime = p['expiration-time'];
  }

  let notBefore = null;
  if (p['not-before'] !== undefined) {
    if (parseTime(p['not-before']) === null) return { ok: false, reason: 'invalid_time' };
    notBefore = p['not-before'];
  }

  let requestId = null;
  if (p['request-id'] !== undefined) {
    if (p['request-id'].length > MAX_REQUEST_ID_LENGTH || !REQUEST_ID.test(p['request-id'])) {
      return { ok: false, reason: 'invalid_request_id' };
    }
    requestId = p['request-id'];
  }

  return {
    ok: true,
    challenge: {
      scheme: url.protocol === 'http:' ? 'http' : 'https',
      domain,
      uri,
      version: '1',
      chainId: Number(chainIdText),
      nonce: p.nonce,
      statement,
      expirationTime,
      notBefore,
      requestId,
    },
  };
}

module.exports = {
  parseChallenges,
  findSiweChallenge,
  bindChallenge,
  isLoopbackHost,
};
