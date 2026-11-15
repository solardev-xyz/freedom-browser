// A main for keystore.integration.test.js (freedom-core design 0013, PRF-2's
// tests), run as its own process so the test can kill it with SIGKILL at a
// step, as main would die there:
//
//   node keystore-main.js forget <freedom-cored> <helper> <app root> <stop at> <items JSON>
//     forgets the items a `profile delete` answered, as main does right after one;
//   node keystore-main.js drain <freedom-cored> <helper> <app root> <stop at>
//     drains the forget file, as main does after its first window;
//   node keystore-main.js core <freedom-cored> <helper> <identity dir> <lock dir> <action> <password>
//     runs the core with main's `shell.keystore` executor, writes `core <pid>`,
//     and asks it `quick_unlock.disable` (`disable`), `vault.delete`
//     (`delete`) or `quick_unlock.enroll` (`enroll`, which replaces a dead
//     key: PRF-2b's test).
//
// `<helper>` is what main runs for `freedom-cored keystore`: the binary
// itself, or a stand-in. At `<stop at>` (`before-helper` or
// `before-forget-done`, or `-` for none) it writes `at <step>` and stops
// there for good. A drain or forget that ends writes `done <counts JSON>`;
// `core` writes `asked` once its request has gone, and then waits.

const { spawn } = require('child_process');
const { CoreClient } = require('../../src/main/core/core-client');
const { createHelperRunner, registerKeystoreShell } = require('../../src/main/core/keystore-shell');
const { drainForgetFile, forgetItems } = require('../../src/main/keystore-drain');
const subcommands = require('../../src/main/profile-subcommands');

const [mode, cored, helper, ...rest] = process.argv.slice(2);
const log = {
  info() {},
  debug() {},
  warn() {},
  error: (...args) => console.error(...args),
};
const runner = createHelperRunner({ command: helper });

function stopForGood() {
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
}

async function main() {
  if (mode === 'forget' || mode === 'drain') {
    const [appRoot, stopAt, items] = rest;
    const deps = {
      runner,
      log,
      // The drain's own steps, whatever key store the test stands up.
      platform: 'darwin',
      subcommand: async (sub, root, extra) =>
        (await subcommands.run(cored, ['profile', sub, '--app-root', root, ...extra])).result,
      step: (name) => {
        if (name !== stopAt) return;
        process.stdout.write(`at ${name}\n`);
        stopForGood();
      },
    };
    const counts =
      mode === 'forget'
        ? await forgetItems(appRoot, JSON.parse(items), deps)
        : await drainForgetFile(appRoot, deps);
    process.stdout.write(`done ${JSON.stringify(counts)}\n`);
    process.exit(0);
  }
  if (mode === 'core') {
    const [identityDir, lockDir, action, password] = rest;
    const client = new CoreClient({
      spawn,
      command: cored,
      args: [
        'serve',
        '--data-dir',
        identityDir,
        '--lock-dir',
        lockDir,
        '--parent-pid',
        String(process.pid),
      ],
      log,
      shellVersion: 'keystore-main',
      grantRoot: identityDir,
    });
    registerKeystoreShell(client, { runner, platform: 'darwin' });
    await client.start();
    process.stdout.write(`core ${client.current.child.pid}\n`);
    const password_b64 = Buffer.from(password, 'utf8').toString('base64');
    const asked =
      action === 'disable'
        ? client.request('quick_unlock.disable', {}, { caller: 'chrome' })
        : action === 'enroll'
          ? client.request('quick_unlock.enroll', { password_b64 }, { caller: 'shell' })
          : client.request('vault.delete', { password_b64 }, { caller: 'shell' });
    asked.catch(() => {});
    process.stdout.write('asked\n');
    await asked;
    process.stdout.write('answered\n');
    // Main stays up, its loop free: the core's drain asks its `forget` after
    // the answer.
    setInterval(() => {}, 60_000);
    return;
  }
  throw new Error(`unknown mode ${mode}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(3);
});
