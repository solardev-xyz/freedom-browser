/**
 * The Radicle backend contract's fixture (freedom-core design 0008, "Tests
 * first"): a Radicle home holding one repository, made through the v0.8.0
 * add-on, and kept as a snapshot so every backend reads the same bytes.
 *
 * - **The identity** is a test key from a public seed (`FIXTURE_SEED`), so
 *   the DID, the repository ID and the node's signatures are the same on
 *   every run. Its private key is written into each home at restore time,
 *   and never kept in the snapshot.
 * - **The configuration** names no peer: no preferred seeds, no `connect`
 *   entries and static peers. The node opens no connection; the suite never
 *   runs a network operation.
 * - **The working copy** the repository is imported from is built with git's
 *   plumbing, with fixed authors and dates, so its commits are the same on
 *   every machine and no file system feature (symlinks, executable bits) is
 *   needed: two commits; a README, a nested source file, a binary file, an
 *   empty file, a symlink and a 70 MiB file (NUL bytes, so binary).
 * - **The snapshot** (`home.json.gz`) is the home after the seeding run:
 *   every regular file but the private key, gzip'd JSON with base64 bodies.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { createRadicleIdentity } = require('../legacy-identity/formats');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'radicle-contract');
const SNAPSHOT_PATH = path.join(FIXTURE_DIR, 'home.json.gz');
const VECTORS_PATH = path.join(FIXTURE_DIR, 'vectors.json');

/** The test identity's seed. Public on purpose: this key guards nothing. */
const FIXTURE_SEED = 'freedom-browser radicle backend contract fixture';
const FIXTURE_ALIAS = 'FreedomContract';

const BIG_FILE_BYTES = 70 * 1024 * 1024;

/** The test identity: its OpenSSH key files and its DID. */
function fixtureIdentity() {
  const seed = crypto.createHash('sha256').update(FIXTURE_SEED).digest();
  const privateKey = crypto.createPrivateKey({
    // PKCS#8 for an Ed25519 seed: the fixed prefix, then the 32 bytes.
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = crypto
    .createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32);
  return createRadicleIdentity(new Uint8Array(seed), new Uint8Array(publicKey), FIXTURE_ALIAS);
}

/** A configuration that names no peer to dial. */
function isolatedConfig() {
  return {
    preferredSeeds: [],
    node: { alias: FIXTURE_ALIAS, connect: [], peers: { type: 'static' } },
  };
}

/** Writes the test identity and the isolated configuration into `home`. */
function writeIdentity(home) {
  const identity = fixtureIdentity();
  fs.mkdirSync(path.join(home, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(home, 'keys', 'radicle'), identity.privateKeyFile, { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'keys', 'radicle.pub'), identity.publicKeyFile);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(isolatedConfig(), null, 2));
  return identity;
}

/** git, with a fixed identity and date, and nothing from the user's
 * configuration. */
function git(cwd, args, { input, date = '1700000000 +0000' } = {}) {
  return execFileSync('git', args, {
    cwd,
    input,
    maxBuffer: 2 * BIG_FILE_BYTES,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Contract Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Contract Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  })
    .toString()
    .trim();
}

/**
 * Builds the working copy in `dir` (an empty directory) with git's plumbing,
 * and returns its commits. The files are objects in the repository only:
 * nothing is checked out.
 */
function buildWorkingCopy(dir) {
  git(dir, ['init', '-q']);
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const blob = (data) => git(dir, ['hash-object', '-w', '--stdin'], { input: data });
  const tree = (entries) =>
    git(dir, ['mktree'], {
      input: `${entries.map(([mode, type, oid, name]) => `${mode} ${type} ${oid}\t${name}`).join('\n')}\n`,
    });

  const readme = blob('# Contract fixture\n\nA repository for the Radicle backend contract.\n');
  const mainJs = blob('export function hello() {\n  return "hello";\n}\n');
  const src = tree([['100644', 'blob', mainJs, 'main.js']]);
  const firstTree = tree([
    ['100644', 'blob', readme, 'README.md'],
    ['040000', 'tree', src, 'src'],
  ]);
  const first = git(dir, ['commit-tree', firstTree, '-m', 'First commit'], {
    date: '1700000000 +0000',
  });

  const image = blob(
    Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
  );
  const empty = blob(Buffer.alloc(0));
  const link = blob('README.md');
  const big = blob(Buffer.alloc(BIG_FILE_BYTES));
  const notes = blob('Second commit notes.\nLine two.\n');
  const secondTree = tree([
    ['100644', 'blob', readme, 'README.md'],
    ['100644', 'blob', big, 'big.bin'],
    ['100644', 'blob', empty, 'empty.txt'],
    ['100644', 'blob', image, 'image.png'],
    ['120000', 'blob', link, 'link'],
    ['100644', 'blob', notes, 'notes.txt'],
    ['040000', 'tree', src, 'src'],
  ]);
  const second = git(
    dir,
    ['commit-tree', secondTree, '-p', first, '-m', 'Second commit\n\nWith a body.'],
    { date: '1700000100 +0000' }
  );
  git(dir, ['update-ref', 'refs/heads/main', second]);
  return { first, second };
}

/** Every regular file under `root`, as relative paths with `/`, sorted. */
function listFiles(root, dir = root) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, full));
    else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/** Writes the snapshot of `home`: every regular file but the private key. */
function writeSnapshot(home, file = SNAPSHOT_PATH) {
  const files = listFiles(home)
    .filter((relative) => relative !== 'keys/radicle')
    .map((relative) => ({
      path: relative,
      data: fs.readFileSync(path.join(home, ...relative.split('/'))).toString('base64'),
    }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ version: 1, files }), { level: 9 }));
}

/** Restores the snapshot into `home` (an empty directory), and writes the
 * test identity's key beside it. */
function restoreSnapshot(home, file = SNAPSHOT_PATH) {
  const { version, files } = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
  if (version !== 1) throw new Error(`unknown Radicle fixture snapshot version ${version}`);
  for (const entry of files) {
    if (entry.path.split('/').some((part) => part === '..' || part === '')) {
      throw new Error(`bad path in the Radicle fixture snapshot: ${entry.path}`);
    }
    const target = path.join(home, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(entry.data, 'base64'));
  }
  return writeIdentity(home);
}

module.exports = {
  BIG_FILE_BYTES,
  FIXTURE_ALIAS,
  SNAPSHOT_PATH,
  VECTORS_PATH,
  buildWorkingCopy,
  fixtureIdentity,
  restoreSnapshot,
  writeIdentity,
  writeSnapshot,
};
