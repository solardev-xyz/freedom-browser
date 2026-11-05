'use strict';

// Retained qualification evidence must not publish the user names of the
// machines it was recorded on. A file whose SHA-256 is pinned by another
// record must stay byte-identical, so it is exempt; every other file uses a
// placeholder such as /Users/<qualification-user>.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const evidenceDirectory = path.join(repositoryRoot, 'research', 'evidence');
const USERNAMED_HOME = /\/(?:Users|home)\/(?!<)[A-Za-z0-9._-]+/g;

function textFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return textFiles(file);
    return /\.(md|json|txt)$/.test(entry.name) ? [file] : [];
  });
}

function usernamedHomePaths(text) {
  return [...new Set(text.match(USERNAMED_HOME) || [])];
}

test('the home-path pattern finds user names but not placeholders', () => {
  expect(usernamedHomePaths('/home/alice/x /Users/bob.smith/y /Users/<qualification-user>/z ~/w')).toEqual([
    '/home/alice',
    '/Users/bob.smith',
  ]);
});

test('research evidence that is not hash-pinned contains no usernamed home paths', () => {
  const references = ['research', 'docs']
    .flatMap((directory) => textFiles(path.join(repositoryRoot, directory)))
    .map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
  const offenders = [];
  for (const file of textFiles(evidenceDirectory)) {
    const bytes = fs.readFileSync(file);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const pinned = references.some((reference) => reference.file !== file && reference.text.includes(hash));
    if (pinned) continue;
    const found = usernamedHomePaths(bytes.toString('utf8'));
    if (found.length) offenders.push(`${path.relative(repositoryRoot, file)}: ${found.join(', ')}`);
  }
  expect(offenders).toEqual([]);
});
