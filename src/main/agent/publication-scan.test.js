'use strict';

const fs = require('fs');
const path = require('path');
const { generateMnemonic } = require('@scure/bip39');
const { wordlist } = require('@scure/bip39/wordlists/english.js');
const {
  RULES,
  preparePublication,
  publicationScanSummary,
  scanText,
  stripImageMetadata,
  stripSourceMapComments,
} = require('./publication-scan');
const { historyContainsSecret } = require('./workspace-history-policy');

const rulesIn = text => scanText('file.txt', text).map(finding => finding.rule);

// Values are assembled at runtime so this file itself does not look like it
// leaks credentials to repository scanners.
const join = (...parts) => parts.join('');
const HEX_KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

// One true positive and at least one look-alike that must stay quiet, per rule.
const CASES = {
  'private-key-block': {
    match: [join('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEow…')],
    quiet: ['-----BEGIN PUBLIC KEY-----', 'BEGIN PRIVATE KEY'],
  },
  'aws-access-key': {
    match: [join('AKIA', 'Q3EGRZ7NKVB2XJ4M')],
    quiet: [join('AKIA', 'IOSFODNN7EXAMPLE'), 'AKIA123'],
  },
  'openai-api-key': {
    match: [join('sk-', 'proj-', 'a8Fh2kL9mQ3rT6vW1yZ4bC7d')],
    quiet: ['sk-your-key-here-xxxxxxxxxxxx', 'desk-a8Fh2kL9mQ3rT6vW1yZ4bC7d'],
  },
  'github-token': {
    match: [join('ghp_', 'a8Fh2kL9mQ3rT6vW1yZ4bC7dE0gJ5n')],
    quiet: ['ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'ghp_short'],
  },
  'slack-token': {
    match: [join('xoxb-', '1234567890-0987654321-AbCdEfGh')],
    quiet: ['xoxb-your-token', 'xoxz-1234567890-0987654321'],
  },
  jwt: {
    match: [join('eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')],
    quiet: ['eyJhbGciOiJIUzI1NiJ9 alone'],
  },
  'url-credentials': {
    match: [join('https://deploy:', 'Tr0ub4dor3x', '@registry.internal/pkg'), join('postgres://app:', 'Zq8vPq2m', '@db:5432/app')],
    quiet: ['https://user:password@example.com', 'https://user:${PASSWORD}@host', 'mailto:me@x.org'],
  },
  'credential-assignment': {
    match: [join('password = "', 'Zq8vPq2mRt', '"'), join('API_KEY=', 'Zq8vPq2mRt7w')],
    quiet: ['password = "your_password"', 'apiKey: process.env.API_KEY', 'token: "<insert token>"'],
  },
  'ethereum-private-key': {
    match: [`const PRIVATE_KEY = '0x${HEX_KEY}';`, `deployer pk: ${HEX_KEY}`],
    quiet: [
      `Transaction 0x${HEX_KEY} confirmed`,
      `<a href="bzz://${HEX_KEY}/">site</a>`,
      `const PRIVATE_KEY = '0x${'0'.repeat(64)}';`,
      `privateKey: 0x${'1234'.repeat(16)}`,
    ],
  },
  'keystore-json': {
    match: [JSON.stringify({ version: 3, crypto: { cipher: 'aes-128-ctr', ciphertext: 'a'.repeat(8) + 'b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4', kdf: 'scrypt' } })],
    quiet: ['{"ciphertext": "abc", "note": "keystore docs"}', JSON.stringify({ ciphertext: 'b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4ff' })],
  },
  'rpc-url-key': {
    match: [
      'https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161',
      join('wss://eth-mainnet.g.alchemy.com/v2/', 'Zq8vPq2mRt7wK1yB3nD5fH'),
      'https://polished-wild-wave.quiknode.pro/0d1f4c6e8a2b3c5d7e9f',
    ],
    quiet: ['https://mainnet.infura.io/v3/YOUR_PROJECT_ID', 'https://eth-mainnet.g.alchemy.com/v2/demo', 'https://rpc.gnosischain.com'],
  },
  'stripe-secret-key': {
    match: [join('sk_live_', '51HqLyjWDarjtT1zdp7dc9a'), join('rk_test_', '51HqLyjWDarjtT1zdp7dc9a')],
    quiet: [join('pk_live_', '51HqLyjWDarjtT1zdp7dc9a'), join('sk_live_', 'x'.repeat(24))],
  },
  'google-api-key': {
    match: [join('AIza', 'SyD3k9mQ3rT6vW1yZ4bC7dE0gJ5nP8sU2xA')],
    quiet: ['AIzaSy...', 'AIzaShort'],
  },
  'slack-webhook': {
    match: [join('https://hooks.slack.com/services/', 'T0A1B2C3D/B4E5F6G7H/', 'q8vPq2mRt7wK1yB3nD5fH9jL')],
    quiet: [join('https://hooks.slack.com/services/', 'X'.repeat(9), '/', 'X'.repeat(9), '/', 'X'.repeat(24)), 'https://slack.com/help'],
  },
  'discord-webhook': {
    match: [join('https://discord.com/api/webhooks/', '112233445566778899/', 'q8vPq2mRt7wK1yB3nD5fH9jL0aZ4cE6gI8kM')],
    quiet: ['https://discord.com/api/webhooks/{id}/{token}', 'https://discord.com/invite/abc'],
  },
  'twilio-api-key': {
    match: [join('SK', '2f7b9c4d1e8a3f5b6c0d9e7a1b4c8d2e')],
    quiet: [join('SK', '0'.repeat(32)), 'SKU2f7b9c4d1e8a3f5'],
  },
  'sendgrid-api-key': {
    match: [join('SG.', 'q8vPq2mRt7wK1yB3nD5fH9', '.', 'jL0aZ4cE6gI8kMq8vPq2mRt7wK1yB3nD5fH9jL0aZ4c')],
    quiet: ['SG.your-key-here', 'SG.short.short'],
  },
  'email-address': {
    match: ['Contact alice.smith@proton.me for details'],
    quiet: ['info@example.com', 'logo@2x.png', 'git@github.com:org/repo.git', 'npm i pkg@1.2.3'],
  },
  'phone-number': {
    match: ['Call +49 30 9876 5432', '<a href="tel:+14155552671">'],
    quiet: ['Version 2.0.1', '+1 (555) 123-4567', 'Order #4155552671'],
  },
  iban: {
    match: ['IBAN DE44 5001 0517 5407 3249 31'],
    quiet: ['DE44 5001 0517 5407 3249 32', 'DE89 3704 0044 0532 0130 00', 'ABCD12345678'],
  },
  'postal-address': {
    match: ['Visit us at 221 Baker Street', 'Büro: Hauptstraße 12'],
    quiet: ['Step 3 Open Settings', '123 Main Street', 'Musterstraße 1'],
  },
};

describe('publication scan rules', () => {
  test('every rule has a true and a false positive case', () => {
    const covered = Object.keys(CASES).concat('bip39-seed-phrase');
    expect(RULES.map(rule => rule.id).sort()).toEqual(covered.sort());
  });

  for (const [rule, { match, quiet }] of Object.entries(CASES)) {
    test(`${rule} matches real values and ignores placeholders`, () => {
      for (const text of match) expect(rulesIn(text)).toContain(rule);
      for (const text of quiet) expect(rulesIn(text)).not.toContain(rule);
    });
  }

  test('excerpts are redacted so the value cannot be reused', () => {
    const secret = join('sk_live_', '51HqLyjWDarjtT1zdp7dc9a');
    const [finding] = scanText('pay.js', `\n\nstripe(${JSON.stringify(secret)})`);
    expect(finding).toMatchObject({ path: 'pay.js', kind: 'secret', line: 3, blocking: true });
    expect(finding.excerpt).not.toContain(secret.slice(8));
    expect(scanText('a', 'https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161')[0].excerpt)
      .toBe('https://mainnet.infura.io/v3/••••••••');
  });

  test('a key assignment is reported once, under its specific rule', () => {
    expect(rulesIn(`const PRIVATE_KEY = '0x${HEX_KEY}';`)).toEqual(['ethereum-private-key']);
  });

  test('personal data warns instead of blocking', () => {
    expect(scanText('a', 'alice.smith@proton.me')[0]).toMatchObject({ kind: 'personal', blocking: false });
  });

  test('anything the history credential check refuses is still reported', () => {
    const text = 'password: "xxxxxxxxzzzzzzzz"';
    expect(historyContainsSecret(text)).toBe(true);
    expect(scanText('a', text)).toEqual([expect.objectContaining({ rule: 'possible-credential', blocking: true })]);
  });
});

describe('seed phrase rule', () => {
  test('flags 12 and 24 word recovery phrases, including numbered backup sheets', () => {
    for (const strength of [128, 256]) {
      const phrase = generateMnemonic(wordlist, strength);
      expect(rulesIn(`Backup: ${phrase}`)).toContain('bip39-seed-phrase');
      const numbered = phrase.split(' ').map((word, index) => `${index + 1}. ${word}`).join('\n');
      expect(rulesIn(numbered)).toContain('bip39-seed-phrase');
      expect(scanText('a', phrase)[0].excerpt).toMatch(/^\w+ •••• \((12|24) words\)$/);
    }
  });

  test('eleven wordlist words, public test mnemonics and prose do not trip it', () => {
    const phrase = generateMnemonic(wordlist).split(' ');
    expect(rulesIn(phrase.slice(0, 11).join(' '))).not.toContain('bip39-seed-phrase');
    expect(rulesIn(`${phrase.slice(0, 6).join(' ')}. The ${phrase.slice(6).join(' ')}`)).not.toContain('bip39-seed-phrase');
    expect(rulesIn('test test test test test test test test test test test junk')).not.toContain('bip39-seed-phrase');
    expect(rulesIn(`${'abandon '.repeat(11)}about`)).not.toContain('bip39-seed-phrase');
    const root = path.join(__dirname, '../../..');
    const prose = ['README.md', 'CHANGELOG.md', 'docs/features.md', 'docs/swarm-provider-api.md']
      .map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    expect(scanText('docs', prose).filter(finding => finding.rule === 'bip39-seed-phrase')).toEqual([]);
  });
});

function jpegWithExif(orientation) {
  const tiff = Buffer.alloc(26 + 12);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(0x2a, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt16LE(0x8825, 22); tiff.writeUInt16LE(4, 24); tiff.writeUInt32LE(1, 26); tiff.writeUInt32LE(99, 30); // GPS IFD pointer
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), exif]);
  app1.writeUInt16BE(exif.length + 2, 2);
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')]);
  const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x07]), Buffer.from('owner', 'latin1')]);
  const scan = Buffer.from([0xff, 0xdb, 0x00, 0x03, 0x00, 0xff, 0xda, 0x00, 0x02, 0x01, 0x02, 0x03, 0xff, 0xd9]);
  return { app0, scan, file: Buffer.concat([Buffer.from([0xff, 0xd8]), app0, app1, comment, scan]) };
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'latin1');
  data.copy(chunk, 8);
  return chunk; // CRC bytes are copied, never recomputed, so zeros are fine here.
}

describe('metadata stripping', () => {
  test('JPEG: drops EXIF/GPS and comments, keeps JFIF and image data, preserves orientation', () => {
    const { app0, scan, file } = jpegWithExif(6);
    const stripped = stripImageMetadata(file);
    expect(stripped.includes(Buffer.from('owner'))).toBe(false);
    expect(stripped.subarray(0, 2 + app0.length)).toEqual(Buffer.concat([Buffer.from([0xff, 0xd8]), app0]));
    expect(stripped.subarray(-scan.length)).toEqual(scan);
    const kept = stripped.subarray(2 + app0.length, stripped.length - scan.length);
    expect(kept.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xe1]));
    expect(kept.includes(Buffer.from([0x88, 0x25]))).toBe(false); // GPS pointer gone
    expect(kept.readUInt16BE(4 + 6 + 8 + 2 + 8)).toBe(6); // orientation tag value
    expect(stripImageMetadata(jpegWithExif(1).file)).toEqual(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, scan]));
  });

  test('JPEG: walks every scan, dropping APPn/COM between progressive scans and bytes after EOI', () => {
    const { app0 } = jpegWithExif(1);
    const segment = (marker, payload) => {
      const header = Buffer.from([0xff, marker, 0, 0]);
      header.writeUInt16BE(payload.length + 2, 2);
      return Buffer.concat([header, Buffer.from(payload, 'latin1')]);
    };
    // Scan data with a stuffed 0xFF00 and a restart marker, which are image data.
    const scan1 = Buffer.concat([segment(0xda, '\x01\x02'), Buffer.from([0x11, 0xff, 0x00, 0x22, 0xff, 0xd0, 0x33])]);
    const dht = segment(0xc4, '\x00\x01');
    const scan2 = Buffer.concat([segment(0xda, '\x03\x04'), Buffer.from([0x44, 0x55])]);
    const eoi = Buffer.from([0xff, 0xd9]);
    const file = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, scan1,
      segment(0xe1, 'http://ns.adobe.com/xap/1.0/\0<gps>48.1</gps>'), dht, segment(0xfe, 'owner name'),
      scan2, eoi, Buffer.from('ftypmp42 motion photo video by owner')]);
    const stripped = stripImageMetadata(file);
    expect(stripped).toEqual(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, scan1, dht, scan2, eoi]));
    expect(stripped.includes(Buffer.from('owner'))).toBe(false);
    expect(stripped.includes(Buffer.from('gps'))).toBe(false);
    const result = preparePublication({ kind: 'file', name: 'photo.jpg', data: file });
    expect(result.stripped).toEqual([{ path: 'photo.jpg', reason: expect.stringContaining('metadata') }]);
    // A clean single-scan file without anything to drop is returned as is.
    const clean = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, scan1, eoi]);
    expect(stripImageMetadata(clean)).toBe(clean);
  });

  test('PNG: drops text, time and eXIf chunks only', () => {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = pngChunk('IHDR', Buffer.alloc(13, 1));
    const idat = pngChunk('IDAT', Buffer.from('pixels'));
    const iend = pngChunk('IEND', Buffer.alloc(0));
    const file = Buffer.concat([signature, ihdr, pngChunk('tEXt', Buffer.from('Author\0me')), pngChunk('eXIf', Buffer.from('MM')), idat, iend]);
    expect(stripImageMetadata(file)).toEqual(Buffer.concat([signature, ihdr, idat, iend]));
    const clean = Buffer.concat([signature, ihdr, idat, iend]);
    expect(stripImageMetadata(clean)).toBe(clean);
  });

  test('WebP: drops EXIF and XMP chunks and clears their VP8X flags', () => {
    const chunk = (type, data) => {
      const header = Buffer.alloc(8);
      header.write(type, 0, 'latin1');
      header.writeUInt32LE(data.length, 4);
      return Buffer.concat([header, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x08 | 0x04 | 0x10;
    const body = Buffer.concat([chunk('VP8X', vp8x), chunk('VP8L', Buffer.from('image')), chunk('EXIF', Buffer.from('gps')), chunk('XMP ', Buffer.from('<x/>'))]);
    const riff = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), body]);
    riff.writeUInt32LE(riff.length - 8, 4);
    const stripped = stripImageMetadata(riff);
    expect(stripped.includes(Buffer.from('EXIF'))).toBe(false);
    expect(stripped.includes(Buffer.from('XMP '))).toBe(false);
    expect(stripped.readUInt32LE(4)).toBe(stripped.length - 8);
    expect(stripped[20]).toBe(0x10);
    expect(stripped.includes(Buffer.from('image'))).toBe(true);
  });

  test('an unparseable image is left untouched and reported', () => {
    const broken = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00]);
    expect(stripImageMetadata(broken)).toBeNull();
    const scan = preparePublication({ kind: 'file', name: 'photo.jpg', data: broken, bytes: broken.length });
    expect(scan.source.data).toBe(broken);
    expect(scan.findings).toEqual([expect.objectContaining({ kind: 'metadata', rule: 'image-metadata', blocking: false })]);
  });

  test('source maps: comments at line ends are removed byte-exactly, strings are not', () => {
    const js = Buffer.from('const s = "//# sourceMappingURL=keep";\nrun();\n//# sourceMappingURL=app.js.map\n', 'utf8');
    expect(stripSourceMapComments(js).toString()).toBe('const s = "//# sourceMappingURL=keep";\nrun();\n\n');
    const css = Buffer.from('a{}\n/*# sourceMappingURL=data:application/json;base64,eyJ9 */');
    expect(stripSourceMapComments(css).toString()).toBe('a{}\n');
    const latin = Buffer.from([0xe9, 0x0a]);
    expect(stripSourceMapComments(latin)).toBe(latin);
  });

  test('folder snapshots drop .map files and OS metadata files; an empty result is refused', () => {
    const scan = preparePublication({ kind: 'folder', name: 'site', excluded: [{ path: '.env', reason: 'Credential file' }], files: [
      { path: 'index.html', bytes: Buffer.from('<h1>Hi</h1>') },
      { path: 'Thumbs.db', bytes: Buffer.from([0, 1]) },
      { path: 'assets/app.js.map', bytes: Buffer.from('{}') },
    ] });
    expect(scan.source.files.map(file => file.path)).toEqual(['index.html']);
    expect(scan.source.bytes).toBe(11);
    expect(scan.excluded.map(entry => entry.path)).toEqual(['.env', 'Thumbs.db', 'assets/app.js.map']);
    expect(publicationScanSummary(scan)).toEqual({ findings: 0, rules: [], excludedFiles: 3, metadataStripped: 0 });
    expect(() => preparePublication({ kind: 'folder', name: 'x', files: [{ path: 'a.map', bytes: Buffer.from('{}') }] }))
      .toThrow(expect.objectContaining({ code: 'PUBLICATION_EMPTY' }));
  });

  test('the finding cap drops warnings, never secrets', () => {
    const email = 'alice.smith@proton.me\n';
    const stripe = `${join('sk_live_', '51HqLyjWDarjtT1zdp7dc9a')}\n`;
    const files = Array.from({ length: 12 }, (_, index) => ({ path: `people-${index}.html`, bytes: Buffer.from(email.repeat(25)) }));
    files.push({ path: 'zz-last.js', bytes: Buffer.from(stripe) });
    const { findings } = preparePublication({ kind: 'folder', name: 'site', files });
    expect(findings).toHaveLength(200);
    expect(findings.filter(finding => finding.path === 'zz-last.js')).toEqual([expect.objectContaining({ blocking: true })]);
    const many = Array.from({ length: 9 }, (_, index) => ({ path: `k${index}.js`, bytes: Buffer.from(stripe.repeat(25)) }));
    expect(() => preparePublication({ kind: 'folder', name: 'site', files: many }))
      .toThrow(expect.objectContaining({ code: 'PUBLICATION_TOO_MANY_FINDINGS' }));
  });

  test('every secret in a file is listed; only warnings are capped per file', () => {
    const keys = Array.from({ length: 30 }, (_, index) =>
      join('sk_live_', '51HqLyjWDarjtT1zdp7dc', String(index).padStart(3, 'q'))).join('\n');
    const secrets = scanText('keys.js', keys);
    expect(secrets).toHaveLength(30);
    expect(secrets.every(finding => finding.blocking)).toBe(true);
    const mixed = scanText('mixed.html', `${'alice.smith@proton.me\n'.repeat(40)}${keys}`);
    expect(mixed.filter(finding => finding.blocking)).toHaveLength(30);
    expect(mixed.filter(finding => !finding.blocking)).toHaveLength(25);
  });

  test('binary files are still scanned for secrets, but not for personal data', () => {
    const key = join('sk-proj-', 'Ab3dEf6hIj9kLm2nOp5qRs8tUv');
    const db = Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from(key), Buffer.from([0xc3, 0]),
      Buffer.from(' alice.smith@proton.me ')]);
    expect(historyContainsSecret(db)).toBe(true);
    for (const [name, source] of [
      ['file', { kind: 'file', name: 'data.db', data: db }],
      ['folder', { kind: 'folder', name: 'site', files: [{ path: 'data.db', bytes: db }] }],
    ]) {
      const { findings } = preparePublication(source);
      expect([name, findings.map(finding => [finding.rule, finding.blocking])]).toEqual([name, [['openai-api-key', true]]]);
    }
    const clean = Buffer.concat([Buffer.from([0]), Buffer.from('woff2 glyph table')]);
    expect(preparePublication({ kind: 'file', name: 'font.woff2', data: clean }).findings).toEqual([]);
  });

  test('a secret past the first 8 MiB of a large file is still found', () => {
    const stripe = join('sk_live_', '51HqLyjWDarjtT1zdp7dc9a');
    const bundle = Buffer.concat([Buffer.alloc(9 * 1024 * 1024, 'a;\n'), Buffer.from(`\nconst k = "${stripe}";\n`)]);
    const { findings } = preparePublication({ kind: 'folder', name: 'site', files: [{ path: 'bundle.js', bytes: bundle }] });
    expect(findings).toEqual([expect.objectContaining({ path: 'bundle.js', rule: 'stripe-secret-key', blocking: true })]);
  });
});
