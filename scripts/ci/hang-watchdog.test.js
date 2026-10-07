/**
 * scripts/ci/hang-watchdog.sh (#544): a command that finishes keeps its own
 * exit status; one that outlives the deadline is reported (process table plus
 * a stack of every process in its tree) and killed — the whole tree, not just
 * the top process — with status 124.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, 'hang-watchdog.sh');
const maybe = process.platform === 'win32' ? describe.skip : describe;

function watchdog(args, timeout = 30_000, env = process.env) {
  return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', timeout, env });
}

// A PATH with stand-in `sample` (macOS's sampler) and `sudo` executables, so
// the macOS branch runs on any host. `sudo` just logs that it was asked.
// Assertions anchor to line starts: the dumped process table can carry this
// test's own command line (or a developer's shell) containing the same words.
function fakeSampler(sampleBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hang-watchdog-'));
  const write = (name, body) =>
    fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  write('sample', sampleBody);
  write('sudo', 'echo "SUDO-RETRY $*"');
  return { dir, env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` } };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

maybe('hang-watchdog.sh', () => {
  test('passes a finished command through, exit status and output included', () => {
    const result = watchdog(['10', 'bash', '-c', 'echo done; exit 3']);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe('done\n');
  });

  test('a command past the deadline is diagnosed, killed with its children, and fails 124', () => {
    // The child records its own pid and its grandchild's, then hangs.
    const result = watchdog(['2', 'bash', '-c', 'sleep 300 & echo "pids $$ $!"; wait']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(124);
    expect(result.stdout).toMatch(/::error title=hang-watchdog::.*still running after 2s/);
    expect(result.stdout).toMatch(/hang-watchdog: process table/);
    const [, parent, child] = result.stdout.match(/pids (\d+) (\d+)/);
    expect(result.stdout).toContain(`hang-watchdog: stack of pid ${parent} `);
    expect(result.stdout).toContain(`hang-watchdog: stack of pid ${child} `);
    expect(alive(Number(parent))).toBe(false);
    expect(alive(Number(child))).toBe(false);
  });

  test('rejects a missing or non-numeric deadline', () => {
    expect(watchdog(['soon', 'true']).status).toBe(2);
    expect(watchdog(['10']).status).toBe(2);
  });

  describe('macOS sample retry', () => {
    const hang = ['2', 'bash', '-c', 'sleep 300 & wait'];

    test('retries under sudo when sample refuses the process but exits 0', () => {
      const { dir, env } = fakeSampler(
        'echo "sample cannot examine process $1 for unknown reasons, try running with sudo."; exit 0'
      );
      try {
        const result = watchdog(hang, 30_000, env);
        expect(result.status).toBe(124);
        expect(result.stdout).toMatch(/^sample cannot examine process/m);
        expect(result.stdout).toMatch(/^SUDO-RETRY -n sample \d+ 2 -mayDie$/m);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('retries under sudo when sample exits non-zero', () => {
      const { dir, env } = fakeSampler('echo "sample: denied"; exit 1');
      try {
        const result = watchdog(hang, 30_000, env);
        expect(result.status).toBe(124);
        expect(result.stdout).toMatch(/^SUDO-RETRY -n sample \d+ 2 -mayDie$/m);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('does not retry when the unprivileged sample produced a call graph', () => {
      const { dir, env } = fakeSampler('echo "Call graph:"; echo "    2 Thread_1 main"; exit 0');
      try {
        const result = watchdog(hang, 30_000, env);
        expect(result.status).toBe(124);
        expect(result.stdout).toContain('Call graph:');
        expect(result.stdout).not.toMatch(/^SUDO-RETRY/m);
        expect(result.stdout).not.toMatch(
          /^hang-watchdog: unprivileged sample gave no call graph/m
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
