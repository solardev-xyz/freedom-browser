#!/usr/bin/env node
/**
 * Reference server for Sign-In with Ethereum over HTTP authentication
 * (#1152, docs/protocols/siwe-http.md). Small enough to read in one sitting;
 * used by the end-to-end test and for trying the feature by hand:
 *
 *   node scripts/siwe-reference-server.js [port]     (default 8787)
 *
 * then open http://localhost:8787/members in Freedom.
 *
 *   GET /             public page linking to /members
 *   GET /members      401 + `WWW-Authenticate: SIWE …` until signed in, then
 *                     the members page; a valid `Authorization: SIWE …` signs
 *                     in and sets a session cookie
 *   GET /logout       ends the session
 *
 * What a real server must check, and this one does: the message parses as
 * ERC-4361; its domain is this server's host; its URI is on this origin; its
 * nonce is one this server issued, unused and unexpired (single use); its
 * chain ID and times are as issued; and the signature recovers to the
 * address the message names. An ERC-1271 smart-account signature would need
 * an RPC call; this server accepts only EOA signatures.
 */

const http = require('http');
const crypto = require('crypto');
const { verifyMessage, getAddress } = require('ethers');

const NONCE_TTL_MS = 5 * 60 * 1000;
const CHAIN_ID = 1;

/** Parse an ERC-4361 message into its fields, or null. */
function parseSiweMessage(message) {
  const lines = String(message).split('\n');
  const header = lines[0]?.match(
    /^(?:(https?):\/\/)?(\S+) wants you to sign in with your Ethereum account:$/
  );
  if (!header) return null;
  const fields = { scheme: header[1] || 'https', domain: header[2], address: lines[1] };
  let i = 2;
  if (lines[i] !== '') return null;
  i += 1;
  if (lines[i] !== '' && !lines[i]?.startsWith('URI: ')) {
    fields.statement = lines[i];
    i += 1;
  }
  if (lines[i] !== '') return null;
  i += 1;
  const names = {
    URI: 'uri',
    Version: 'version',
    'Chain ID': 'chainId',
    Nonce: 'nonce',
    'Issued At': 'issuedAt',
    'Expiration Time': 'expirationTime',
    'Not Before': 'notBefore',
    'Request ID': 'requestId',
  };
  for (; i < lines.length; i += 1) {
    const match = lines[i].match(/^([A-Za-z ]+): (.*)$/);
    if (!match || !names[match[1]] || fields[names[match[1]]] !== undefined) return null;
    fields[names[match[1]]] = match[2];
  }
  return fields;
}

function parseAuthorization(header) {
  const match = /^SIWE\s+result="([A-Za-z0-9_-]+)"$/i.exec(String(header || '').trim());
  if (!match) return null;
  try {
    const { message, signature } = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    return typeof message === 'string' && typeof signature === 'string'
      ? { message, signature }
      : null;
  } catch {
    return null;
  }
}

function cookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([k, v]) => k && v)
  );
}

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}code{word-break:break-all}</style>
${body}`;
}

/**
 * @param {{ statement?: string, chainId?: number }} [options]
 * @returns {http.Server & { sessions: Map, nonces: Map }}
 */
function createSiweReferenceServer({
  statement = 'Sign in to the Freedom SIWE reference server',
  chainId = CHAIN_ID,
} = {}) {
  const nonces = new Map(); // nonce → { expiresAt, issuedFor }
  const sessions = new Map(); // session id → address

  function challenge(res, host, origin, reason) {
    const nonce = crypto.randomBytes(16).toString('hex'); // 128 bits, as the doc asks
    const expiresAt = Date.now() + NONCE_TTL_MS;
    nonces.set(nonce, { expiresAt });
    const params = [
      `realm="${host}"`,
      `nonce="${nonce}"`,
      `uri="${origin}/members"`,
      `chain-id=${chainId}`,
      'version=1',
      `statement="${statement.replace(/["\\]/g, '\\$&')}"`,
      `expiration-time="${new Date(expiresAt).toISOString()}"`,
    ];
    res.writeHead(401, {
      'Content-Type': 'text/html; charset=utf-8',
      'WWW-Authenticate': `SIWE ${params.join(', ')}`,
      'Cache-Control': 'no-store',
    });
    res.end(
      page(
        'Sign in required',
        `<h1>Sign in required</h1>
<p>This page is for members. A browser that speaks Sign-In with Ethereum over HTTP offers to sign you in.</p>
${reason ? `<p id="reason">Last attempt refused: ${reason}</p>` : ''}`
      )
    );
  }

  /** Check a signed message; returns the address or throws with a reason. */
  function verify(auth, host, origin) {
    const fields = parseSiweMessage(auth.message);
    if (!fields) throw new Error('not an ERC-4361 message');
    if (fields.domain !== host) throw new Error('wrong domain');
    if (`${fields.scheme}://${fields.domain}` !== origin) throw new Error('wrong scheme');
    let uri;
    try {
      uri = new URL(fields.uri);
    } catch {
      throw new Error('bad URI');
    }
    if (uri.origin !== origin) throw new Error('URI on another origin');
    if (fields.version !== '1') throw new Error('unsupported version');
    if (Number(fields.chainId) !== chainId) throw new Error('wrong chain');
    const issued = nonces.get(fields.nonce);
    if (!issued) throw new Error('unknown or used nonce');
    nonces.delete(fields.nonce);
    if (Date.now() > issued.expiresAt) throw new Error('expired nonce');
    if (fields.expirationTime && Date.now() > Date.parse(fields.expirationTime))
      throw new Error('expired message');
    if (fields.notBefore && Date.now() < Date.parse(fields.notBefore))
      throw new Error('not valid yet');
    const address = getAddress(fields.address);
    if (verifyMessage(auth.message, auth.signature) !== address) throw new Error('bad signature');
    return address;
  }

  const server = http.createServer((req, res) => {
    const host = req.headers.host;
    const origin = `http://${host}`;
    const { pathname } = new URL(req.url, origin);
    const sessionId = cookies(req).siwe_session;

    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        page(
          'SIWE reference server',
          '<h1>SIWE reference server</h1><p><a href="/members">Members only</a></p>'
        )
      );
      return;
    }
    if (pathname === '/logout') {
      if (sessionId) sessions.delete(sessionId);
      res.writeHead(302, { Location: '/', 'Set-Cookie': 'siwe_session=; Path=/; Max-Age=0' });
      res.end();
      return;
    }
    if (pathname !== '/members') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    let address = sessionId ? sessions.get(sessionId) : null;
    let refused = null;
    if (!address && req.headers.authorization) {
      const auth = parseAuthorization(req.headers.authorization);
      try {
        if (!auth) throw new Error('unreadable Authorization header');
        address = verify(auth, host, origin);
      } catch (err) {
        refused = err.message;
      }
      if (address) {
        const id = crypto.randomBytes(16).toString('hex');
        sessions.set(id, address);
        res.setHeader('Set-Cookie', `siwe_session=${id}; Path=/; HttpOnly; SameSite=Lax`);
      }
    }
    if (!address) {
      challenge(res, host, origin, refused);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(
      page(
        'Members',
        `<h1>Welcome, member</h1>
<p>Signed in as <code id="address">${address}</code></p>
<p><a href="/logout">Sign out</a></p>`
      )
    );
  });
  server.sessions = sessions;
  server.nonces = nonces;
  return server;
}

module.exports = { createSiweReferenceServer, parseSiweMessage, parseAuthorization };

if (require.main === module) {
  const port = Number(process.argv[2]) || 8787;
  createSiweReferenceServer().listen(port, '127.0.0.1', () => {
    console.log(`SIWE reference server on http://localhost:${port}/members`);
  });
}
