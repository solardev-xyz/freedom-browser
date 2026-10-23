'use strict';

// One local pre-publish pass for every Swarm publication source (managed
// workspace, attachment, inline text). It runs in the main process on the
// in-memory snapshot that will be uploaded, so the scanned bytes are exactly
// the bytes sent. Findings carry a redacted excerpt for the approval card only;
// the model never receives an excerpt (see publicationScanSummary).
//
// The rules are written here against each provider's documented key format
// rather than vendored from gitleaks: gitleaks' config is RE2 syntax that
// JavaScript cannot run unchanged, and most of its ~200 rules cover services
// this browser does not handle. Each rule is pinned by publication-scan.test.js
// with a true positive and a placeholder that must not match.

const path = require('path');
const { wordlist: BIP39_ENGLISH } = require('@scure/bip39/wordlists/english.js');
const { historyContainsSecret } = require('./workspace-history-policy');

const MAX_FINDINGS = 200;
// Caps warnings only: every secret in a file is listed, because one the card
// never shows could not be held back (capFindings refuses more than MAX_FINDINGS).
const MAX_WARNINGS_PER_FILE = 25;
const BIP39_WORDS = new Set(BIP39_ENGLISH);
const MIN_SEED_WORDS = 12;

const FINDING_KINDS = Object.freeze(['secret', 'personal', 'metadata', 'scope']);

const PLACEHOLDER =
  /your[_ -]|example|placeholder|changeme|change[_-]me|dummy|sample|redacted|insert|replace[_-]?me|<|>|\.\.\.|…|\{\{|\$\{|process\.env/i;

function placeholderValue(value) {
  return PLACEHOLDER.test(value) || /(.)\1{7,}/.test(value) || /x{6,}/i.test(value);
}

function lowEntropyHex(hex) {
  // 0x000…, 0xfff…, 0x1234…1234 and similar documentation values.
  const digits = hex.toLowerCase();
  if (new Set(digits).size <= 3) return true;
  for (const size of [2, 4, 8, 16]) {
    if (digits === digits.slice(0, size).repeat(digits.length / size)) return true;
  }
  return '0123456789abcdef'.repeat(4).startsWith(digits);
}

function ibanValid(value) {
  const compact = value.replace(/ /g, '').toUpperCase();
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const digits = /[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const PLACEHOLDER_EMAIL_DOMAIN =
  /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost|domain\.com|email\.com|yourdomain\.com|company\.com)$/i;
const FILE_LIKE_TLD = /^(?:png|jpe?g|gif|svg|webp|avif|ico|js|mjs|cjs|css|html?|json|map|ts|tsx|jsx|md|txt|xml|woff2?|ttf)$/i;
const KEY_CONTEXT =
  /(?:priv(?:ate)?[\s_-]*key|privkey|secret|signing[\s_-]*key|signer|deployer|mnemonic|wallet[\s_-]*key|\bpk\b|\bsk\b)/i;

// Each rule yields { index, value } for every match it accepts.
function regexRule(pattern, accept = () => true) {
  return function* matches(text) {
    const expression = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(expression)) {
      // A named group `v` narrows the reported value (a password inside a URL).
      const value = match.groups?.v ?? match[0];
      const index = match.index + (match.groups?.v === undefined ? 0 : match[0].indexOf(match.groups.v));
      if (accept(value, text, index, match)) yield { index, value };
    }
  };
}

function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end);
}

function* seedPhraseMatches(text) {
  const words = /[A-Za-z]+/g;
  let run = [];
  const flush = function* () {
    if (run.length >= MIN_SEED_WORDS) {
      const distinct = new Set(run.map(item => item.word));
      // "test test … junk" and "abandon … about" are public development
      // mnemonics printed in tool documentation; they protect nothing.
      if (distinct.size >= 4) {
        yield { index: run[0].index, value: run.map(item => item.word).join(' '), words: run.length };
      }
    }
    run = [];
  };
  for (const match of text.matchAll(words)) {
    const word = match[0];
    const lower = word.toLowerCase();
    const previous = run.at(-1);
    const gap = previous ? text.slice(previous.end, match.index) : '';
    // Words may be separated by whitespace, list numbering or simple
    // punctuation, as in a "1. word 2. word" backup sheet; anything else
    // (prose punctuation runs, markup) ends the run.
    const contiguous = !previous || /^[\s\d.,;:)("'|-]{1,8}$/.test(gap);
    if (!contiguous) yield* flush();
    if (BIP39_WORDS.has(lower) && (word === lower || word === word.toUpperCase() || run.length === 0)) {
      run.push({ word: lower, index: match.index, end: match.index + word.length });
    } else {
      yield* flush();
    }
  }
  yield* flush();
}

const RULES = Object.freeze([
  // Existing workspace-history patterns, now named individually.
  { id: 'private-key-block', kind: 'secret', label: 'Private key block',
    matches: regexRule(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/) },
  { id: 'aws-access-key', kind: 'secret', label: 'AWS access key',
    matches: regexRule(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, value => !placeholderValue(value)) },
  { id: 'openai-api-key', kind: 'secret', label: 'OpenAI-style API key',
    matches: regexRule(/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/, value => !placeholderValue(value)) },
  { id: 'github-token', kind: 'secret', label: 'GitHub token',
    matches: regexRule(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/, value => !placeholderValue(value)) },
  { id: 'slack-token', kind: 'secret', label: 'Slack token',
    matches: regexRule(/\bxox[baprs]-[A-Za-z0-9-]{10,}/, value => !placeholderValue(value)) },
  { id: 'jwt', kind: 'secret', label: 'JSON Web Token',
    matches: regexRule(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/) },
  { id: 'url-credentials', kind: 'secret', label: 'Password in a URL',
    matches: regexRule(
      /\b(?:https?|wss?|ftp|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s/:@'"<>]+:(?<v>[^\s/@'"<>]+)@/i,
      value => !placeholderValue(value) && !/^(?:pass(?:word)?|secret|pwd|\*+)$/i.test(value)) },
  { id: 'credential-assignment', kind: 'secret', label: 'Password or key assignment',
    matches: function* matches(text) {
      yield* regexRule(
        /["']?(?:password|passwd|api[_-]?key|secret|token|access[_-]?token|auth[_-]?token|authorization|private[_-]?key|credential)["']?\s*[:=]\s*["'](?<v>[^"'\r\n]{8,})["']/i,
        value => !/^(?:\$\{|process\.env\.|your[_ -]|example|placeholder|changeme|test|dummy|<)/i.test(value) && !placeholderValue(value)
      )(text);
      yield* regexRule(
        /^\s*(?:password|passwd|api[_-]?key|secret|token|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[:=]\s*(?<v>[A-Za-z0-9_+/.=-]{8,})\s*(?:#.*)?$/im,
        value => !/^(?:your[_-]|example|placeholder|changeme|test|dummy)/i.test(value) && !placeholderValue(value)
      )(text);
    } },
  // Crypto-wallet material.
  { id: 'ethereum-private-key', kind: 'secret', label: 'Ethereum private key',
    // A bare 0x + 64 hex is also every transaction hash and Swarm reference,
    // so the key must sit on a line that names it as a key.
    matches: regexRule(/(?<![0-9A-Za-z])(?:0x)?(?<v>[0-9a-fA-F]{64})(?![0-9A-Za-z])/, (value, text, index) =>
      !lowEntropyHex(value) && KEY_CONTEXT.test(lineAt(text, index).replace(/[0-9a-fA-F]{64}/g, ''))) },
  { id: 'bip39-seed-phrase', kind: 'secret', label: 'Wallet recovery phrase', matches: seedPhraseMatches },
  { id: 'keystore-json', kind: 'secret', label: 'Encrypted wallet keystore',
    matches: regexRule(/"ciphertext"\s*:\s*"[0-9a-fA-F]{32,}"/, (value, text) =>
      /"kdf"\s*:\s*"(?:scrypt|pbkdf2)"/i.test(text) && /"(?:crypto|Crypto)"\s*:/.test(text)) },
  { id: 'rpc-url-key', kind: 'secret', label: 'RPC URL with an embedded key',
    matches: regexRule(
      /\b(?:https?|wss?):\/\/(?:[a-z0-9-]+\.infura\.io\/(?:v3|ws\/v3)\/[0-9a-f]{32}|[a-z0-9-]+\.g\.alchemy\.com\/v2\/[A-Za-z0-9_-]{20,}|(?:[a-z0-9-]+\.)+quiknode\.pro\/[0-9a-f]{20,}|rpc\.ankr\.com\/[a-z0-9_]+\/[0-9a-f]{40,})/i,
      value => !placeholderValue(value)) },
  // Payment, cloud and messaging services.
  { id: 'stripe-secret-key', kind: 'secret', label: 'Stripe secret key',
    matches: regexRule(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/, value => !placeholderValue(value)) },
  { id: 'google-api-key', kind: 'secret', label: 'Google API key',
    matches: regexRule(/\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/, value => !placeholderValue(value)) },
  { id: 'slack-webhook', kind: 'secret', label: 'Slack webhook URL',
    matches: regexRule(/https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/+-]{20,}/, value => !placeholderValue(value)) },
  { id: 'discord-webhook', kind: 'secret', label: 'Discord webhook URL',
    matches: regexRule(/https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,}\/[A-Za-z0-9_-]{30,}/, value => !placeholderValue(value)) },
  { id: 'twilio-api-key', kind: 'secret', label: 'Twilio API key',
    matches: regexRule(/\bSK[0-9a-fA-F]{32}\b/, value => !lowEntropyHex(value.slice(2))) },
  { id: 'sendgrid-api-key', kind: 'secret', label: 'SendGrid API key',
    matches: regexRule(/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/, value => !placeholderValue(value)) },
  // Personal data: warnings, never blocking by default.
  { id: 'email-address', kind: 'personal', label: 'Email address',
    matches: regexRule(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,24}(?![A-Za-z0-9-])/, value => {
      const domain = value.slice(value.indexOf('@') + 1).toLowerCase();
      const local = value.slice(0, value.indexOf('@')).toLowerCase();
      return !PLACEHOLDER_EMAIL_DOMAIN.test(domain) && !FILE_LIKE_TLD.test(domain.split('.').at(-1)) &&
        !['git', 'you', 'user', 'name', 'someone', 'email', 'me'].includes(local);
    }) },
  { id: 'phone-number', kind: 'personal', label: 'Phone number',
    matches: regexRule(/(?:tel:|(?<![\w+]))\+\d{1,3}(?:[\s.-]?\(?\d{1,4}\)?){2,5}(?![\w])/, value => {
      const digits = value.replace(/\D/g, '');
      return digits.length >= 8 && digits.length <= 15 && !/^(\d)\1+$/.test(digits.slice(-7)) && !/1234567/.test(digits);
    }) },
  { id: 'iban', kind: 'personal', label: 'Bank account number (IBAN)',
    matches: regexRule(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/, value => ibanValid(value) && !/^DE89 ?3704 ?0044 ?0532 ?0130 ?00$/.test(value) && !/^GB82 ?WEST/.test(value)) },
  { id: 'postal-address', kind: 'personal', label: 'Street address',
    matches: function* matches(text) {
      yield* regexRule(/\b\d{1,5}[A-Za-z]?\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St\.|Avenue|Ave\.|Road|Rd\.|Boulevard|Blvd\.|Lane|Drive|Court|Place)(?![A-Za-z])/,
        value => !/\b(?:Main|Example|Sample|Fake)\b/.test(value))(text);
      yield* regexRule(/\b[A-ZÄÖÜ][a-zäöüß]+(?:straße|strasse|str\.|weg|gasse|platz|allee)\s+\d{1,4}[a-z]?\b/,
        value => !/^(?:Muster|Beispiel)/.test(value))(text);
    } },
]);

const RULE_BY_ID = new Map(RULES.map(rule => [rule.id, rule]));

function lineNumber(text, index) {
  let line = 1;
  for (let cursor = text.indexOf('\n'); cursor !== -1 && cursor < index; cursor = text.indexOf('\n', cursor + 1)) line++;
  return line;
}

// What the user sees: enough to recognise the value, not enough to reuse it.
function redact(ruleId, value) {
  if (ruleId === 'bip39-seed-phrase') {
    const words = value.split(' ');
    return `${words[0]} ${'•'.repeat(4)} (${words.length} words)`;
  }
  if (ruleId === 'email-address') {
    const at = value.indexOf('@');
    return `${value[0]}${'•'.repeat(3)}${value.slice(at)}`;
  }
  if (ruleId === 'phone-number' || ruleId === 'iban') {
    const compact = value.replace(/^tel:/, '');
    return `${compact.slice(0, 4)}${'•'.repeat(4)}${compact.slice(-2)}`;
  }
  if (ruleId === 'postal-address') return value.replace(/\d/g, '•');
  if (/^[a-z]+:\/\//i.test(value)) return `${value.slice(0, value.lastIndexOf('/') + 1)}${'•'.repeat(8)}`;
  const shown = Math.min(6, Math.floor(value.length / 4));
  return `${value.slice(0, shown)}${'•'.repeat(8)} (${value.length} characters)`;
}

// Every byte that will be uploaded is scanned, however large the file and
// whether or not it looks like text: a key pasted into a database file or
// after the first megabytes of a bundle is published all the same.
function textOf(bytes) {
  if (typeof bytes === 'string') return { text: bytes, binary: false };
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) return null;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // A NUL early on means binary (images, fonts, databases, archives). It is
  // read as latin1, one character per byte, so an ASCII credential embedded
  // anywhere in it is still seen; only the secret rules run there, since
  // personal-data patterns in random bytes would be noise.
  if (buffer.subarray(0, 8192).includes(0)) return { text: buffer.toString('latin1'), binary: true };
  return { text: buffer.toString('utf8'), binary: false };
}

function scanText(filePath, text, { secretsOnly = false } = {}) {
  const findings = [];
  const seen = new Set();
  let warnings = 0;
  for (const rule of RULES) {
    if (secretsOnly && rule.kind !== 'secret') continue;
    for (const match of rule.matches(text)) {
      const key = `${rule.id}:${match.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (rule.kind !== 'secret' && warnings >= MAX_WARNINGS_PER_FILE) continue;
      if (rule.kind !== 'secret') warnings++;
      findings.push({
        path: filePath,
        kind: rule.kind,
        rule: rule.id,
        label: rule.label,
        line: lineNumber(text, match.index),
        excerpt: redact(rule.id, match.value),
        blocking: rule.kind === 'secret',
      });
    }
  }
  // A key assigned to PRIVATE_KEY = '…' is one value: report the specific rule.
  const specific = new Set(findings.filter(finding => finding.kind === 'secret' && finding.rule !== 'credential-assignment')
    .map(finding => finding.line));
  for (let index = findings.length - 1; index >= 0; index--) {
    if (findings[index].rule === 'credential-assignment' && specific.has(findings[index].line)) findings.splice(index, 1);
  }
  // The history policy's broader credential check stays the backstop: any text
  // it refuses is reported even when no named rule recognised the value.
  if (!findings.some(finding => finding.kind === 'secret') && historyContainsSecret(text)) {
    findings.push({ path: filePath, kind: 'secret', rule: 'possible-credential', label: 'Possible credential',
      excerpt: 'Value hidden', blocking: true });
  }
  return findings.sort((left, right) => (left.line || 0) - (right.line || 0));
}

function scanBytes(filePath, bytes) {
  const decoded = textOf(bytes);
  return decoded ? scanText(filePath, decoded.text, { secretsOnly: decoded.binary }) : [];
}

// --- Metadata stripping (lossless: container metadata only, pixels untouched) ---

function jpegOrientation(tiff) {
  if (tiff.length < 8) return null;
  const little = tiff.toString('latin1', 0, 2) === 'II';
  if (!little && tiff.toString('latin1', 0, 2) !== 'MM') return null;
  const u16 = offset => (little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset));
  const u32 = offset => (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return null;
  const count = u16(ifd);
  for (let entry = 0; entry < count; entry++) {
    const offset = ifd + 2 + entry * 12;
    if (offset + 12 > tiff.length) return null;
    if (u16(offset) === 0x0112 && u16(offset + 2) === 3) {
      const value = u16(offset + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

function orientationSegment(orientation) {
  // A minimal big-endian EXIF block carrying only the orientation tag, so
  // stripping does not change how the photo is displayed.
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(0x2a, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function stripJpeg(buffer) {
  const kept = [buffer.subarray(0, 2)];
  let changed = false;
  let orientation = null;
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff || offset + 1 >= buffer.length) return null;
    const marker = buffer[offset + 1];
    if (marker === 0xff) { kept.push(buffer.subarray(offset, offset + 1)); offset += 1; continue; }
    if (marker === 0xd9) {
      // EOI ends the image. Anything after it (a Motion Photo's video, an
      // MPF secondary image, a vendor trailer) is not part of the picture.
      kept.push(buffer.subarray(offset, offset + 2));
      if (offset + 2 < buffer.length) changed = true;
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { kept.push(buffer.subarray(offset, offset + 2)); offset += 2; continue; }
    if (offset + 4 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) return null;
    const segment = buffer.subarray(offset, offset + 2 + length);
    const payload = segment.subarray(4);
    const isIcc = marker === 0xe2 && payload.toString('latin1', 0, 12) === 'ICC_PROFILE\0';
    // APP0 (JFIF), ICC profiles and APP14 (Adobe colour transform) affect
    // rendering and stay. EXIF/XMP (APP1), IPTC (APP13), other APPn and
    // comments are metadata.
    const drop = (marker >= 0xe1 && marker <= 0xef && marker !== 0xee && !isIcc) || marker === 0xfe;
    if (marker === 0xe1 && payload.toString('latin1', 0, 6) === 'Exif\0\0') {
      orientation = jpegOrientation(payload.subarray(6)) || orientation;
    }
    if (drop) changed = true;
    else kept.push(segment);
    offset += 2 + length;
    if (marker === 0xda) {
      // Entropy-coded scan data runs to the next marker that is neither a
      // stuffed 0xFF00 nor a restart marker. Progressive JPEGs carry more
      // segments (DHT, SOS, and possibly APPn/COM) between scans, so the
      // walk continues there instead of keeping everything after the first SOS.
      let end = offset;
      while (end + 1 < buffer.length &&
        !(buffer[end] === 0xff && buffer[end + 1] !== 0x00 && buffer[end + 1] !== 0xff &&
          !(buffer[end + 1] >= 0xd0 && buffer[end + 1] <= 0xd7))) end++;
      if (end + 1 >= buffer.length) end = buffer.length;
      kept.push(buffer.subarray(offset, end));
      offset = end;
    }
  }
  if (!changed) return buffer;
  if (orientation && orientation !== 1) {
    const afterJfif = kept[1] && kept[1][1] === 0xe0 ? 2 : 1;
    kept.splice(afterJfif, 0, orientationSegment(orientation));
  }
  return Buffer.concat(kept);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_METADATA_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripPng(buffer) {
  const kept = [PNG_SIGNATURE];
  let changed = false;
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) return null;
    if (PNG_METADATA_CHUNKS.has(type)) changed = true;
    else kept.push(buffer.subarray(offset, end));
    offset = end;
    if (type === 'IEND') break;
  }
  if (offset !== buffer.length) changed = true; // Bytes after IEND are not image data.
  return changed ? Buffer.concat(kept) : buffer;
}

function stripWebp(buffer) {
  const kept = [];
  let changed = false;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('latin1', offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + length + (length % 2);
    if (offset + 8 + length > buffer.length) return null;
    if (type === 'EXIF' || type === 'XMP ') changed = true;
    else kept.push(Buffer.from(buffer.subarray(offset, Math.min(end, buffer.length))));
    offset = end;
  }
  if (!changed) return buffer;
  const vp8x = kept.find(chunk => chunk.toString('latin1', 0, 4) === 'VP8X');
  if (vp8x) vp8x[8] &= ~(0x08 | 0x04); // Clear the EXIF and XMP presence flags.
  const body = Buffer.concat(kept);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

function imageType(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// Returns the stripped buffer (the same object when nothing changed), or null
// when the container could not be parsed and the bytes were left untouched.
function stripImageMetadata(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const type = imageType(buffer);
  if (!type) return buffer;
  try {
    return type === 'jpeg' ? stripJpeg(buffer) : type === 'png' ? stripPng(buffer) : stripWebp(buffer);
  } catch {
    return null;
  }
}

const SOURCE_MAP_COMMENT = /^[ \t]*(?:\/\/[#@][ \t]*sourceMappingURL=[^\r\n]*|\/\*[#@][ \t]*sourceMappingURL=[^*]*\*\/[ \t]*)$/gm;
const SCRIPT_OR_STYLE = /\.(?:m?js|cjs|css)$/i;

function stripSourceMapComments(bytes) {
  // latin1 maps bytes one-to-one, so indices found here slice the original
  // buffer and every other byte is preserved exactly.
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const text = buffer.toString('latin1');
  const parts = [];
  let cursor = 0;
  for (const match of text.matchAll(SOURCE_MAP_COMMENT)) {
    parts.push(buffer.subarray(cursor, match.index));
    cursor = match.index + match[0].length;
  }
  if (!parts.length) return buffer;
  parts.push(buffer.subarray(cursor));
  return Buffer.concat(parts);
}

function osMetadataFile(name) {
  return ['thumbs.db', 'desktop.ini', 'ehthumbs.db', '.ds_store'].includes(name.toLowerCase());
}

function sanitizeFile(filePath, bytes, { removable }) {
  const name = path.posix.basename(filePath);
  if (removable && osMetadataFile(name)) return { removed: 'Operating system metadata file' };
  if (removable && /\.map$/i.test(name)) return { removed: 'Source map (can contain the original source and comments)' };
  const notes = [];
  let output = bytes;
  const image = stripImageMetadata(output);
  if (image === null) {
    return { bytes: output, finding: { path: filePath, kind: 'metadata', rule: 'image-metadata',
      label: 'Image metadata could not be checked', excerpt: 'Unrecognised image structure', blocking: false } };
  }
  if (image !== output) { output = image; notes.push('Image metadata (EXIF, GPS, XMP) removed'); }
  if (SCRIPT_OR_STYLE.test(name)) {
    const stripped = stripSourceMapComments(output);
    if (stripped !== output) { output = stripped; notes.push('sourceMappingURL comment removed'); }
  }
  if (!removable && /\.map$/i.test(name)) {
    return { bytes: output, finding: { path: filePath, kind: 'metadata', rule: 'source-map',
      label: 'Source map (can contain the original source and comments)', excerpt: name, blocking: false } };
  }
  return { bytes: output, ...(notes.length && { stripped: notes.join('; ') }) };
}

// Every blocking finding must reach the card, or main could not hold it back.
// Warnings fill whatever room is left.
function capFindings(findings) {
  const blocking = findings.filter(finding => finding.blocking);
  if (blocking.length > MAX_FINDINGS) {
    const error = new Error(`The pre-publish check found ${blocking.length} possible secrets, too many to review one by one. Remove them and publish again.`);
    error.code = 'PUBLICATION_TOO_MANY_FINDINGS';
    throw error;
  }
  let room = MAX_FINDINGS - blocking.length;
  return findings.filter(finding => finding.blocking || room-- > 0)
    .map((finding, index) => Object.freeze({ id: `finding_${index + 1}`, ...finding }));
}

/**
 * Prepare a publication snapshot: drop or strip metadata, then scan the
 * resulting bytes. `source` is the descriptor returned by the workspace or
 * attachment reader, or the inline text descriptor.
 */
function preparePublication(source) {
  const excluded = [...(source.excluded || [])];
  const stripped = [];
  const findings = [];
  let prepared;
  if (source.kind === 'folder') {
    const files = [];
    for (const file of source.files) {
      const result = sanitizeFile(file.path, file.bytes, { removable: true });
      if (result.removed) { excluded.push({ path: file.path, reason: result.removed }); continue; }
      if (result.stripped) stripped.push({ path: file.path, reason: result.stripped });
      if (result.finding) findings.push(result.finding);
      files.push(Object.freeze({ path: file.path, bytes: result.bytes }));
    }
    if (!files.length) {
      const error = new Error('Nothing publishable is left after removing metadata files');
      error.code = 'PUBLICATION_EMPTY';
      throw error;
    }
    for (const file of files) findings.push(...scanBytes(file.path, file.bytes));
    prepared = Object.freeze({ ...source, files: Object.freeze(files),
      bytes: files.reduce((total, file) => total + file.bytes.byteLength, 0) });
  } else if (source.kind === 'file') {
    const filePath = source.name;
    const result = sanitizeFile(filePath, source.data, { removable: false });
    if (result.stripped) stripped.push({ path: filePath, reason: result.stripped });
    if (result.finding) findings.push(result.finding);
    findings.push(...scanBytes(filePath, result.bytes));
    prepared = Object.freeze({ ...source, data: result.bytes, bytes: result.bytes.byteLength });
  } else {
    findings.push(...scanText('Text', String(source.text ?? '')));
    prepared = source;
  }
  return Object.freeze({
    source: prepared,
    findings: capFindings(findings),
    excluded: Object.freeze(excluded.slice(0, 1_000).map(entry => Object.freeze({ ...entry }))),
    stripped: Object.freeze(stripped),
  });
}

// The only scan detail that may reach the model: counts and rule names.
function publicationScanSummary(scan, findings = scan.findings) {
  return Object.freeze({
    findings: findings.length,
    rules: [...new Set(findings.map(finding => finding.rule))],
    excludedFiles: scan.excluded.length,
    metadataStripped: scan.stripped.length,
  });
}

module.exports = {
  FINDING_KINDS,
  MAX_FINDINGS,
  MIN_SEED_WORDS,
  RULES,
  RULE_BY_ID,
  ibanValid,
  preparePublication,
  publicationScanSummary,
  redact,
  scanText,
  stripImageMetadata,
  stripSourceMapComments,
};
