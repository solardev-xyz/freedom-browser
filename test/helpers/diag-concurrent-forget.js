// TEMPORARY diagnostic (removed before review): what the real helper answers
// when two or three `freedom-cored keystore --op forget` of one Keychain item
// run at once, in the job's temporary keychain.
//
//   node diag-concurrent-forget.js <freedom-cored> <rounds> <width> [stagger ms list]
// With a stagger list, round r starts helper i (r's stagger × i) ms late.

const crypto = require('crypto');
const { spawn } = require('child_process');

const [cored, roundsArg = '40', widthArg = '2'] = process.argv.slice(2);
const rounds = Number(roundsArg);
const width = Number(widthArg);
const staggers = (process.argv[5] || '0').split(',').map(Number);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function replyKey() {
  const { publicKey } = crypto.generateKeyPairSync('x25519');
  return Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
}

function helper(args) {
  return new Promise((resolve) => {
    const child = spawn(cored, ['keystore', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('close', (code, signal) => resolve({ out: out.trim(), err: err.trim(), code, signal }));
  });
}

(async () => {
  const tally = new Map();
  for (let round = 0; round < rounds; round += 1) {
    const item = crypto.randomBytes(16).toString('hex');
    const made = await helper([
      '--op',
      'create',
      '--policy',
      'unattended',
      '--item',
      item,
      '--reply-key',
      replyKey(),
    ]);
    if (!made.out.startsWith('{"ok":true')) {
      console.log('create failed', made.out.slice(0, 80), made.code, made.err);
      continue;
    }
    const stagger = staggers[round % staggers.length];
    const answers = await Promise.all(
      Array.from({ length: width }, async (_, i) => {
        await sleep(stagger * i);
        return helper(['--op', 'forget', '--policy', 'unattended', '--item', item]);
      })
    );
    const key = answers
      .map(
        (a) =>
          `${a.out}${a.code ? ` exit=${a.code}` : ''}${a.signal ? ` ${a.signal}` : ''}${a.err ? ` stderr=${a.err}` : ''}`
      )
      .join(' | ');
    const keyed = `+${stagger}ms: ${key}`;
    tally.set(keyed, (tally.get(keyed) || 0) + 1);
  }
  console.log(`width ${width}, ${rounds} rounds:`);
  for (const [key, count] of tally) console.log(`  ${count}x  ${key}`);
})();
