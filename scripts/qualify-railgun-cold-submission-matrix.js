/** Sequential offline matrix launcher. No network/funded profile inputs accepted.
 * An optional final argument 'latency' runs the simulated-latency cases of
 * fixtures/railgun-cold-submission-latency.js instead, each to completion. */
const fs = require('fs'),
  path = require('path'),
  assert = require('./fixtures/railgun-native-assertions').assert;
const { spawn } = require('child_process');
const fixtureChecks = require('./fixtures/railgun-native-assertions');
const { createHash } = require('crypto');
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function main() {
  const [electron, source, base, engine, prover, artifacts, bytecodes, mode] =
    process.argv.slice(2);
  assert.ok(process.argv.length === 9 || (process.argv.length === 10 && mode === 'latency'));
  const latency = mode === 'latency';
  assert.ok([electron, source, base, engine, prover, artifacts, bytecodes].every(path.isAbsolute));
  assert.equal(fs.existsSync(base), false);
  assert.equal(
    sha(fs.readFileSync(source)),
    'bfa8684f50b2bb838b026f2c4972653bfc4503d9fd15182c6c5b219ce1bc1e41'
  );
  fs.mkdirSync(base, { mode: 0o700 });
  const cases = [];
  if (latency)
    for (const name of Object.keys(require('./fixtures/railgun-cold-submission-latency').CASES))
      cases.push({
        creator: 'Shield',
        kind: 'transfer',
        outcome: 'acknowledged',
        history: 'advanced-root',
        latency: name,
      });
  else {
    for (const creator of ['Shield', 'Transact'])
      for (const kind of ['transfer', 'unshield', 'partial'])
        for (const outcome of ['acknowledged', 'lost-response'])
          cases.push({ creator, kind, outcome, history: 'advanced-root' });
    cases.push(
      { creator: 'Shield', kind: 'transfer', outcome: 'acknowledged', history: 'same-root' },
      { creator: 'Transact', kind: 'partial', outcome: 'lost-response', history: 'same-root' }
    );
  }
  const launches = [],
    compatibility = [];
  const run = (script, args, log) =>
    new Promise((resolve, reject) => {
      const fd = fs.openSync(log, 'wx', 0o600),
        started = Date.now();
      const child = spawn(electron, [path.join(__dirname, script), ...args], {
        cwd: path.join(__dirname, '..'),
        stdio: ['ignore', fd, fd],
        env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
      });
      const launch = {
        script,
        args: args.map((arg) => (path.isAbsolute(arg) ? path.relative(base, arg) : arg)),
        pid: child.pid,
        started,
      };
      launches.push(launch);
      let timedOut = false;
      const timer = setTimeout(
        () => {
          timedOut = true;
          child.kill('SIGTERM');
        },
        20 * 60 * 1000
      );
      const escalation = setTimeout(
        () => {
          if (timedOut) child.kill('SIGKILL');
        },
        20 * 60 * 1000 + 30000
      );
      child.once('error', (error) => {
        clearTimeout(timer);
        clearTimeout(escalation);
        fs.closeSync(fd);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        clearTimeout(escalation);
        fs.closeSync(fd);
        Object.assign(launch, { code, signal, elapsedMs: Date.now() - started, timedOut });
        if (code !== 0 || timedOut)
          reject(Error('Native matrix process failed: ' + script + ' ' + log));
        else resolve(launch);
      });
    });
  try {
    for (const item of cases) {
      const name = item.latency
          ? 'latency-' + item.latency
          : [item.creator.toLowerCase(), item.kind, item.outcome, item.history].join('-'),
        directory = path.join(base, name);
      const reportName = item.latency
        ? 'cold-submission-latency-' + item.latency + '-report.json'
        : 'cold-submission-' + item.outcome + '-report.json';
      // A latency case that fails keeps its profile, logs and any report; the
      // next case still runs. Nothing is retried.
      try {
        const common = [
          source,
          directory,
          engine,
          prover,
          artifacts,
          bytecodes,
          item.creator,
          item.kind,
        ];
        const setup = await run(
          'qualify-railgun-proof-recovery.js',
          [...common, 'setup', item.history, 'submission-handoff'],
          path.join(base, name + '-setup.log')
        );
        const recover = await run(
          'qualify-railgun-proof-recovery.js',
          [...common, 'resume', item.history, 'submission-handoff'],
          path.join(base, name + '-recover.log')
        );
        const submit = await run(
          'qualify-railgun-cold-submission.js',
          [...common, item.outcome, ...(item.latency ? [item.latency] : [])],
          path.join(base, name + '-submit.log')
        );
        fixtureChecks.assertEmpty();
        assert.equal(new Set([setup.pid, recover.pid, submit.pid]).size, 3);
        const handoff = JSON.parse(
          fs.readFileSync(path.join(directory, 'cold-submission-handoff.json'), 'utf8')
        );
        assert.equal(handoff.setupPID, setup.pid);
        assert.equal(handoff.recoveryPID, recover.pid);
        const report = JSON.parse(fs.readFileSync(path.join(directory, reportName), 'utf8'));
        assert.equal(report.submissionPID, submit.pid);
        assert.equal(report.runID, handoff.runID);
        item.evidence = Object.fromEntries(
          [
            'restart-handoff.json',
            'resume-report.json',
            'cold-submission-handoff.json',
            reportName,
          ].map((file) => [file, sha(fs.readFileSync(path.join(directory, file)))])
        );
      } catch (error) {
        if (!item.latency) throw error;
        item.failed = error.message;
        item.preserved = Object.fromEntries(
          ['restart-handoff.json', 'resume-report.json', 'cold-submission-handoff.json', reportName]
            .filter((file) => fs.existsSync(path.join(directory, file)))
            .map((file) => [file, sha(fs.readFileSync(path.join(directory, file)))])
        );
      }
    }
    for (const [creator, kind] of latency
      ? []
      : [
          ['Shield', 'partial'],
          ['Transact', 'transfer'],
        ]) {
      const directory = path.join(base, 'default-warm-' + creator.toLowerCase() + '-' + kind);
      await run(
        'qualify-railgun-proof-recovery.js',
        [source, directory, engine, prover, artifacts, bytecodes, creator, kind],
        path.join(base, 'default-warm-' + creator.toLowerCase() + '-' + kind + '.log')
      );
      fixtureChecks.assertEmpty();
      const report = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'));
      assert.equal(report.runMode, 'warm');
      compatibility.push({
        creator,
        kind,
        reportSha256: sha(fs.readFileSync(path.join(directory, 'report.json'))),
      });
      assert.equal(fs.existsSync(path.join(directory, 'cold-submission-handoff.json')), false);
    }
  } finally {
    fs.writeFileSync(
      path.join(base, 'launcher-report.json'),
      JSON.stringify(
        {
          schema: latency
            ? 'railgun-cold-submission-latency-launcher-v1'
            : 'railgun-cold-submission-launcher-v1',
          cases,
          launches,
          compatibility,
          allCasesCompleted:
            cases.every((item) => item.evidence) && compatibility.length === (latency ? 0 : 2),
          fixtureViolations: fixtureChecks.report(),
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
  }
  if (cases.some((item) => item.failed)) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
