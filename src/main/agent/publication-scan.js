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
  return PLACEHOLDER.test(value) || /(.)\1{7}/.test(value) || /x{6}/i.test(value);
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
  /(?:priv(?:ate)?[\s_-]{0,8}key|privkey|secret|signing[\s_-]{0,8}key|signer|deployer|mnemonic|wallet[\s_-]{0,8}key|\bpk\b|\bsk\b)/i;

// Matching is linear in the text, whatever the regexp engine does. V8 runs a
// pattern on its own backtrack stack, and with some engine settings (CI's
// coverage run; reproduced by --no-regexp-optimization) an open-ended `X+` or
// `X*` pushes one entry per character, so a run of millions of token
// characters threw "Maximum call stack size exceeded" from matchAll whatever
// the JS stack size was. So every pattern below has bounded quantifiers only,
// and an open-ended run (a token's tail, a quoted value) is walked by runEnd:
// a search for the first character outside the run, a single character class
// with no quantifier. Each such run is followed by a character outside its
// class, so the walk is exactly what the greedy pattern matched.
function runEnd(text, from, stop) {
  stop.lastIndex = from;
  return stop.exec(text)?.index ?? text.length;
}

const NOT_TOKEN = /[^A-Za-z0-9_-]/g;
const NOT_WORD_TOKEN = /[^A-Za-z0-9_]/g;
const NOT_DASH_TOKEN = /[^A-Za-z0-9-]/g;
const NOT_ALNUM = /[^A-Za-z0-9]/g;
const NOT_HEX = /[^0-9a-fA-F]/g;
const NOT_DIGIT = /\D/g;
const NOT_WEBHOOK_PATH = /[^A-Za-z0-9_/+-]/g;
const NOT_URL_USER = /[\s/:@'"<>]/g;
const NOT_URL_PASSWORD = /[\s/@'"<>]/g;
const NOT_QUOTED_VALUE = /["'\r\n]/g;
const NOT_BARE_VALUE = /[^A-Za-z0-9_+/.=-]/g;
const NOT_INLINE_SPACE = /\S|[\n\r\u2028\u2029]/g;
const NOT_LETTER = /[^A-Za-z]/g;
const LINE_END = /[\n\r\u2028\u2029]/;
const NOT_INLINE_TAB = /[^ \t]/g;
const NOT_SPACE = /\S/g;
const NOT_LABEL = /[^A-Za-z0-9-]/g;
const NOT_PEM_TITLE = /[^A-Z ]/g;

// The end of the \s run at `from`, when the character after it is one of
// `next`; -1 otherwise. A walked `\s*` before a fixed character, so no cap.
function spaceThen(text, from, next) {
  const end = runEnd(text, from, NOT_SPACE);
  return next.includes(text[end]) ? end : -1;
}

// `then` continues past a pattern's bounded head: then(text, headEnd, match)
// returns { end } (the value runs to end; scanning resumes at `next`, default
// end) or, when the text does not complete the match, { next } or {}.
const tail = stop => (text, headEnd) => ({ end: runEnd(text, headEnd, stop) });

// Each rule yields { index, value } for every match it accepts.
function regexRule(pattern, accept = () => true, then = null) {
  const flags = [...new Set(`${pattern.flags}g${pattern.source.includes('(?<v>') ? 'd' : ''}`)].join('');
  return function* matches(text) {
    const expression = new RegExp(pattern.source, flags);
    for (let match = expression.exec(text); match; match = expression.exec(text)) {
      const headEnd = match.index + match[0].length;
      // A named group `v` narrows the reported value (a password inside a URL).
      const group = match.indices?.groups?.v;
      let index = group ? group[0] : match.index;
      let end = group ? group[1] : headEnd;
      if (then) {
        const result = then(text, headEnd, match);
        expression.lastIndex = Math.max(result.next ?? result.end ?? 0, match.index + 1);
        if (result.end === undefined) continue;
        if (result.start !== undefined) index = result.start;
        end = result.end;
      }
      const value = text.slice(index, end);
      if (accept(value, text, index, match)) yield { index, value };
    }
  };
}

function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end);
}

function* letterWords(text) {
  const letter = /[A-Za-z]/g;
  for (let match = letter.exec(text); match; match = letter.exec(text)) {
    const end = runEnd(text, match.index, NOT_LETTER);
    yield { index: match.index, end, word: text.slice(match.index, end) };
    letter.lastIndex = end;
  }
}

function* seedPhraseMatches(text) {
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
  for (const { word, index, end } of letterWords(text)) {
    const lower = word.toLowerCase();
    const previous = run.at(-1);
    // Words may be separated by whitespace, list numbering or simple
    // punctuation, as in a "1. word 2. word" backup sheet; anything else
    // (prose punctuation runs, markup) ends the run.
    const contiguous = !previous ||
      (index - previous.end <= 8 && /^[\s\d.,;:)("'|-]{1,8}$/.test(text.slice(previous.end, index)));
    if (!contiguous) yield* flush();
    if (BIP39_WORDS.has(lower) && (word === lower || word === word.toUpperCase() || run.length === 0)) {
      run.push({ word: lower, index, end });
    } else {
      yield* flush();
    }
  }
  yield* flush();
}

// eyJ… . … . …: three token segments of at least 12 characters. A head that
// does not complete fails for every later head inside the same first segment
// too, so scanning resumes after it (a run of "-eyJ" stays linear).
function jwtTail(text, headEnd) {
  const first = runEnd(text, headEnd, NOT_TOKEN);
  if (text[first] !== '.') return { next: first };
  const second = runEnd(text, first + 1, NOT_TOKEN);
  if (second - first - 1 < 12 || text[second] !== '.') return { next: first };
  const third = runEnd(text, second + 1, NOT_TOKEN);
  return third - second - 1 < 12 ? { next: first } : { end: third };
}

function urlPasswordTail(text, headEnd) {
  const user = runEnd(text, headEnd, NOT_URL_USER);
  if (user === headEnd || text[user] !== ':') return {};
  const password = runEnd(text, user + 1, NOT_URL_PASSWORD);
  if (password === user + 1 || text[password] !== '@') return {};
  return { start: user + 1, end: password, next: password + 1 };
}

function quotedValueTail(text, headEnd) {
  const end = runEnd(text, headEnd, NOT_QUOTED_VALUE);
  return text[end] === '"' || text[end] === "'" ? { end, next: end + 1 } : {};
}

// The value must end its line, optionally followed by blanks and a # comment.
function bareValueTail(text, headEnd) {
  const end = runEnd(text, headEnd, NOT_BARE_VALUE);
  const after = runEnd(text, end, NOT_INLINE_SPACE);
  return after === text.length || text[after] === '#' || LINE_END.test(text[after]) ? { end } : {};
}

// The credential-assignment rules walk what the original patterns matched as
// `["']?\s*[:=]\s*` after the key name (\s is every Unicode space, newlines
// included), so a BOM, NBSP, \f or a long run of blanks still matches.
const CREDENTIAL_NAMES = 'password|passwd|api[_-]?key|secret|token|access[_-]?token|auth[_-]?token|private[_-]?key';

// key ["']? \s* [:=] \s* ["'] value{8,} ["']
function quotedAssignmentTail(text, headEnd) {
  const name = headEnd + (text[headEnd] === '"' || text[headEnd] === "'" ? 1 : 0);
  const operator = spaceThen(text, name, ':=');
  if (operator === -1) return {};
  const quote = spaceThen(text, operator + 1, '"\'');
  if (quote === -1) return {};
  const result = quotedValueTail(text, quote + 1);
  return result.end - quote - 1 >= 8 ? { ...result, start: quote + 1 } : {};
}

// The key opened a line: ^\s* under the m flag, where \s also crosses blank lines.
function opensLine(text, index) {
  let start = index;
  while (start > 0 && /\s/.test(text[start - 1])) {
    start -= 1;
    if (LINE_END.test(text[start])) return true;
  }
  return start === 0;
}

// ^\s* key \s* [:=] \s* value{8,} \s* (#.*)? $
function bareAssignmentTail(text, headEnd, match) {
  if (!opensLine(text, match.index)) return {};
  const operator = spaceThen(text, headEnd, ':=');
  if (operator === -1) return {};
  const start = runEnd(text, operator + 1, NOT_SPACE);
  const result = bareValueTail(text, start);
  return result.end - start >= 8 ? { ...result, start } : {};
}

// -----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----, with the title walked.
function pemTitleTail(text, headEnd) {
  const end = runEnd(text, headEnd, NOT_PEM_TITLE);
  const title = 'PRIVATE KEY';
  if (end - headEnd < title.length || !text.startsWith('-----', end) || !text.startsWith(title, end - title.length)) return {};
  const prefix = end - title.length - headEnd;
  return prefix === 0 || (prefix >= 2 && text[end - title.length - 1] === ' ') ? { end: end + 5 } : {};
}

// "name" \s* : (then the caller's check of what follows), anywhere in text.
function jsonKeyFollowedBy(text, name, valueAt) {
  const key = new RegExp(name.source, `${name.flags.replace('g', '')}g`);
  for (let match = key.exec(text); match; match = key.exec(text)) {
    const colon = spaceThen(text, match.index + match[0].length, ':');
    if (colon !== -1 && valueAt(runEnd(text, colon + 1, NOT_SPACE))) return true;
  }
  return false;
}

// The domain of an email: (?:label\.)+ then a 2-24 letter TLD that ends the
// label run. As the greedy pattern does, take the most labels that work, with
// no cap on their number.
function emailDomainTail(text, headEnd) {
  let best;
  for (let at = headEnd, labels = 0; ; labels += 1) {
    const end = runEnd(text, at, NOT_LABEL);
    if (labels > 0 && end - at >= 2 && end - at <= 24 && /^[A-Za-z]+$/.test(text.slice(at, end))) best = end;
    if (end === at || text[end] !== '.') break;
    at = end + 1;
  }
  return best === undefined ? { next: headEnd } : { end: best };
}

const RULES = Object.freeze([
  // Existing workspace-history patterns, now named individually.
  { id: 'private-key-block', kind: 'secret', label: 'Private key block',
    matches: regexRule(/-----BEGIN /, undefined, pemTitleTail) },
  { id: 'aws-access-key', kind: 'secret', label: 'AWS access key',
    matches: regexRule(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, value => !placeholderValue(value)) },
  { id: 'openai-api-key', kind: 'secret', label: 'OpenAI-style API key',
    matches: regexRule(/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20}/, value => !placeholderValue(value), tail(NOT_TOKEN)) },
  { id: 'github-token', kind: 'secret', label: 'GitHub token',
    matches: regexRule(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20}/, value => !placeholderValue(value), tail(NOT_WORD_TOKEN)) },
  { id: 'slack-token', kind: 'secret', label: 'Slack token',
    matches: regexRule(/\bxox[baprs]-[A-Za-z0-9-]{10}/, value => !placeholderValue(value), tail(NOT_DASH_TOKEN)) },
  { id: 'jwt', kind: 'secret', label: 'JSON Web Token',
    matches: regexRule(/\beyJ[A-Za-z0-9_-]{12}/, undefined, jwtTail) },
  { id: 'url-credentials', kind: 'secret', label: 'Password in a URL',
    matches: regexRule(
      /\b(?:https?|wss?|ftp|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\//i,
      value => !placeholderValue(value) && !/^(?:pass(?:word)?|secret|pwd)$/i.test(value) && /[^*]/.test(value),
      urlPasswordTail) },
  { id: 'credential-assignment', kind: 'secret', label: 'Password or key assignment',
    matches: function* matches(text) {
      yield* regexRule(
        new RegExp(`(?:${CREDENTIAL_NAMES}|authorization|credential)`, 'i'),
        value => !/^(?:\$\{|process\.env\.|your[_ -]|example|placeholder|changeme|test|dummy|<)/i.test(value) && !placeholderValue(value),
        quotedAssignmentTail
      )(text);
      yield* regexRule(
        new RegExp(`(?:${CREDENTIAL_NAMES})`, 'i'),
        value => !/^(?:your[_-]|example|placeholder|changeme|test|dummy)/i.test(value) && !placeholderValue(value),
        bareAssignmentTail
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
    matches: regexRule(/"ciphertext"/, (value, text) =>
      jsonKeyFollowedBy(text, /"kdf"/i, at => /^"(?:scrypt|pbkdf2)"/i.test(text.slice(at, at + 8))) &&
      jsonKeyFollowedBy(text, /"(?:crypto|Crypto)"/, () => true),
    (text, headEnd) => {
      const colon = spaceThen(text, headEnd, ':');
      const quote = colon === -1 ? -1 : spaceThen(text, colon + 1, '"');
      if (quote === -1) return {};
      const end = runEnd(text, quote + 1, NOT_HEX);
      return end - quote - 1 >= 32 && text[end] === '"' ? { end: end + 1 } : {};
    }) },
  { id: 'rpc-url-key', kind: 'secret', label: 'RPC URL with an embedded key',
    matches: function* matches(text) {
      const accept = value => !placeholderValue(value);
      yield* regexRule(/\b(?:https?|wss?):\/\/[a-z0-9-]{1,63}\.infura\.io\/(?:v3|ws\/v3)\/[0-9a-f]{32}/i, accept)(text);
      yield* regexRule(/\b(?:https?|wss?):\/\/[a-z0-9-]{1,63}\.g\.alchemy\.com\/v2\/[A-Za-z0-9_-]{20}/i, accept, tail(NOT_TOKEN))(text);
      yield* regexRule(/\b(?:https?|wss?):\/\/(?:[a-z0-9-]{1,63}\.){1,8}quiknode\.pro\/[0-9a-f]{20}/i, accept, tail(NOT_HEX))(text);
      yield* regexRule(/\b(?:https?|wss?):\/\/rpc\.ankr\.com\/[a-z0-9_]{1,64}\/[0-9a-f]{40}/i, accept, tail(NOT_HEX))(text);
    } },
  // Payment, cloud and messaging services.
  { id: 'stripe-secret-key', kind: 'secret', label: 'Stripe secret key',
    matches: regexRule(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16}/, value => !placeholderValue(value), (text, headEnd) => {
      const end = runEnd(text, headEnd, NOT_ALNUM);
      return text[end] === '_' ? {} : { end }; // \b: the key ends at a non-word character
    }) },
  { id: 'google-api-key', kind: 'secret', label: 'Google API key',
    matches: regexRule(/\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/, value => !placeholderValue(value)) },
  { id: 'slack-webhook', kind: 'secret', label: 'Slack webhook URL',
    matches: regexRule(/https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/+-]{20}/, value => !placeholderValue(value), tail(NOT_WEBHOOK_PATH)) },
  { id: 'discord-webhook', kind: 'secret', label: 'Discord webhook URL',
    matches: regexRule(/https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5}/, value => !placeholderValue(value), (text, headEnd) => {
      const id = runEnd(text, headEnd, NOT_DIGIT);
      if (text[id] !== '/') return {};
      const end = runEnd(text, id + 1, NOT_TOKEN);
      return end - id - 1 >= 30 ? { end } : {};
    }) },
  { id: 'twilio-api-key', kind: 'secret', label: 'Twilio API key',
    matches: regexRule(/\bSK[0-9a-fA-F]{32}\b/, value => !lowEntropyHex(value.slice(2))) },
  { id: 'sendgrid-api-key', kind: 'secret', label: 'SendGrid API key',
    matches: regexRule(/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/, value => !placeholderValue(value)) },
  // Personal data: warnings, never blocking by default. The local part is
  // bounded by the RFC 5321 limit of 64; the domain is walked, any length.
  { id: 'email-address', kind: 'personal', label: 'Email address',
    matches: regexRule(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@/, value => {
      const domain = value.slice(value.indexOf('@') + 1).toLowerCase();
      const local = value.slice(0, value.indexOf('@')).toLowerCase();
      return !PLACEHOLDER_EMAIL_DOMAIN.test(domain) && !FILE_LIKE_TLD.test(domain.split('.').at(-1)) &&
        !['git', 'you', 'user', 'name', 'someone', 'email', 'me'].includes(local);
    }, emailDomainTail) },
  { id: 'phone-number', kind: 'personal', label: 'Phone number',
    matches: regexRule(/(?:tel:|(?<![\w+]))\+\d{1,3}(?:[\s.-]?\(?\d{1,4}\)?){2,5}(?![\w])/, value => {
      const digits = value.replace(/\D/g, '');
      return digits.length >= 8 && digits.length <= 15 && !/^(\d)\1+$/.test(digits.slice(-7)) && !/1234567/.test(digits);
    }) },
  { id: 'iban', kind: 'personal', label: 'Bank account number (IBAN)',
    matches: regexRule(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/, value => ibanValid(value) && !/^DE89 ?3704 ?0044 ?0532 ?0130 ?00$/.test(value) && !/^GB82 ?WEST/.test(value)) },
  { id: 'postal-address', kind: 'personal', label: 'Street address',
    matches: function* matches(text) {
      yield* regexRule(/\b\d{1,5}[A-Za-z]?\s{1,8}(?:[A-Z][a-z]{1,30}\s{1,8}){1,3}(?:Street|St\.|Avenue|Ave\.|Road|Rd\.|Boulevard|Blvd\.|Lane|Drive|Court|Place)(?![A-Za-z])/,
        value => !/\b(?:Main|Example|Sample|Fake)\b/.test(value))(text);
      yield* regexRule(/\b[A-ZÄÖÜ][a-zäöüß]{1,40}(?:straße|strasse|str\.|weg|gasse|platz|allee)\s{1,8}\d{1,4}[a-z]?\b/,
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
  // A rule that throws (a regexp engine limit, an unexpected input) must not
  // let the file through unchecked: it becomes a blocking finding instead.
  const incomplete = () => findings.push({ path: filePath, kind: 'secret', rule: 'scan-incomplete',
    label: 'Could not be fully checked', excerpt: 'The pre-publish check stopped on this file', blocking: true });
  const scanRule = rule => {
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
  };
  for (const rule of RULES) {
    if (secretsOnly && rule.kind !== 'secret') continue;
    try {
      scanRule(rule);
    } catch {
      if (!findings.some(finding => finding.rule === 'scan-incomplete')) incomplete();
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
  if (!findings.some(finding => finding.kind === 'secret')) {
    let possible;
    try {
      possible = historyContainsSecret(text);
    } catch {
      incomplete();
    }
    if (possible) {
      findings.push({ path: filePath, kind: 'secret', rule: 'possible-credential', label: 'Possible credential',
        excerpt: 'Value hidden', blocking: true });
    }
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

const SOURCE_MAP_START = /^[ \t]{0,256}(?:\/\/|\/\*)[#@][ \t]{0,64}sourceMappingURL=/gm;
const LINE_BREAK = /[\r\n]/g;
const SCRIPT_OR_STYLE = /\.(?:m?js|cjs|css)$/i;

// A whole-line `//# sourceMappingURL=…` or `/*# sourceMappingURL=… */`, walked
// without an open-ended pattern (see runEnd). Returns the comment's end or -1.
function sourceMapCommentEnd(text, match) {
  const headEnd = match.index + match[0].length;
  if (match[0].trimStart().startsWith('//')) return runEnd(text, headEnd, LINE_BREAK);
  const close = text.indexOf('*', headEnd);
  if (close === -1 || text[close + 1] !== '/') return -1;
  const end = runEnd(text, close + 2, NOT_INLINE_TAB);
  return end === text.length || LINE_END.test(text[end]) ? end : -1;
}

function stripSourceMapComments(bytes) {
  // latin1 maps bytes one-to-one, so indices found here slice the original
  // buffer and every other byte is preserved exactly.
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const text = buffer.toString('latin1');
  const parts = [];
  let cursor = 0;
  const start = new RegExp(SOURCE_MAP_START.source, SOURCE_MAP_START.flags);
  for (let match = start.exec(text); match; match = start.exec(text)) {
    const end = sourceMapCommentEnd(text, match);
    if (end === -1) continue;
    parts.push(buffer.subarray(cursor, match.index));
    cursor = end;
    start.lastIndex = Math.max(end, match.index + 1);
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
