/**
 * The step marker's state for one freedom-colibrid process
 * (`colibri-markers.js`, freedom-core design 0014, "The step marker" and
 * "Cancel and deadlines"), with its clock and timers run by hand and its
 * abandon recorded: open requests, the markers' order and every protocol
 * error in it, the death's culprit by cause, overruns 2 s past a deadline
 * and a late step's own 2 s. The same rules through a process are in
 * colibrid-client.test.js.
 */

const { ColibriMarkers, OVERRUN_MS, deathReason } = require('./colibri-markers');

const START = 1_700_000_000_000;

/** A clock and its timers, run by hand. */
function manualClock() {
  const clock = { now: START, timers: [] };
  clock.setTimer = (fn, ms) => {
    const timer = { fn, at: clock.now + ms, cleared: false, fired: false };
    clock.timers.push(timer);
    return timer;
  };
  clock.clearTimer = (timer) => {
    if (timer) timer.cleared = true;
  };
  clock.advance = (ms) => {
    const until = clock.now + ms;
    for (;;) {
      const due = clock.timers
        .filter((t) => !t.cleared && !t.fired && t.at <= until)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock.now = due.at;
      due.fired = true;
      due.fn();
    }
    clock.now = until;
  };
  clock.armed = () => clock.timers.filter((t) => !t.cleared && !t.fired).length;
  return clock;
}

/** Markers for generation 3, whose abandon answers `abandons` (true by
 * default) and records its causes. */
function markers({ abandons = true } = {}) {
  const clock = manualClock();
  const abandoned = [];
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const state = new ColibriMarkers({
    generation: 3,
    abandon: (cause) => {
      abandoned.push(cause);
      return abandons;
    },
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log,
  });
  /** Opens request `id` with `deadlineMs` left. */
  const open = (id, deadlineMs = 10_000) => {
    const op = { kind: 'request', id, chain: 1, deadlineAt: clock.now + deadlineMs, ended: false };
    state.opened(op);
    return op;
  };
  return { state, clock, abandoned, log, open };
}

const step = (state, request) => state.event('colibri.step', { request });
const stepped = (state, request) => state.event('colibri.stepped', { request });
const died = (state, exit = { code: null, signal: 'SIGSEGV', cause: null }) => state.die(exit);

describe('open requests', () => {
  test('a request is open from its write until its reply, as the operation fetches name', () => {
    const { state, open } = markers();
    const op = open(2);
    expect(state.operation(2)).toBe(op);
    expect(op.ended).toBe(false);
    // The reply stands.
    expect(state.closed(2)).toBe(true);
    expect(state.operation(2)).toBeUndefined();
    expect(op.ended).toBe(true);
    // A second reply, or one for no request, changes nothing.
    expect(state.closed(2)).toBe(true);
    expect(state.closed(9)).toBe(true);
  });

  test('an ended operation stays open to the markers until its reply: a step after a cancel is no error', () => {
    const { state, abandoned, open } = markers();
    const op = open(2);
    // Main's cancel ends its fetches (colibrid-client.js).
    op.ended = true;
    expect(state.operation(2)).toBe(op);
    step(state, 2);
    stepped(state, 2);
    expect(state.closed(2)).toBe(true);
    expect(abandoned).toEqual([]);
  });

  test('a death ends every open request and clears every timer', () => {
    const { state, clock, open } = markers();
    const ops = [open(2), open(3)];
    step(state, 3);
    died(state);
    expect(ops.map((op) => op.ended)).toEqual([true, true]);
    expect(state.operation(2)).toBeUndefined();
    expect(clock.armed()).toBe(0);
    // Nothing opens on a dead process.
    open(4);
    expect(state.operation(4)).toBeUndefined();
  });
});

describe('the markers', () => {
  test('steps and their clearing events, request after request, are no error', () => {
    const { state, abandoned, open } = markers();
    open(2);
    open(3);
    for (const id of [2, 3, 2, 2, 3]) {
      step(state, id);
      expect(state.openStep).toBe(id);
      stepped(state, id);
      expect(state.openStep).toBeNull();
    }
    // The testhooks build names the call too: still a marker.
    expect(state.event('colibri.step', { request: 2, call: 'execute' })).toBe(true);
    expect(state.openStep).toBe(2);
    expect(abandoned).toEqual([]);
  });

  test('other events are left alone', () => {
    const { state, abandoned } = markers();
    expect(state.event('colibri.recycling', { request: 99 })).toBe(false);
    expect(abandoned).toEqual([]);
  });

  test.each([
    ['a step for an unknown request', (s) => step(s, 9), 'unknown_request'],
    [
      'a step for an ended request',
      (s) => {
        s.closed(2);
        step(s, 2);
      },
      'ended_request',
    ],
    [
      'a step while another is open',
      (s) => {
        step(s, 2);
        step(s, 3);
      },
      'step_open',
    ],
    [
      'a second step of the same request while it is open',
      (s) => {
        step(s, 2);
        step(s, 2);
      },
      'step_open',
    ],
    [
      'a stepped for another request than the open step',
      (s) => {
        step(s, 2);
        stepped(s, 3);
      },
      'not_open_step',
    ],
    ['a stepped with no step open', (s) => stepped(s, 2), 'not_open_step'],
    ['a marker naming no request', (s) => s.event('colibri.step', {}), 'bad_marker'],
    ['a marker naming request 0', (s) => s.event('colibri.stepped', { request: 0 }), 'bad_marker'],
    [
      'a marker naming a request by text',
      (s) => s.event('colibri.step', { request: '2' }),
      'bad_marker',
    ],
    [
      "a reply while its request's step is open",
      (s) => {
        step(s, 2);
        // Refused: never its request's outcome.
        expect(s.closed(2)).toBe(false);
      },
      'reply_in_step',
    ],
  ])('%s is a protocol error: abandoned for its markers, naming nobody', (_name, act, rule) => {
    const { state, abandoned, log, open } = markers();
    open(2);
    open(3);
    act(state);
    expect(abandoned).toEqual(['marker']);
    expect(log.warn).toHaveBeenCalledWith('[colibrid] step marker refused', { rule });
    // Whatever step is open, the death names nobody.
    expect(died(state)).toMatchObject({ culprit: null, generation: 3 });
  });

  test('after an abandon its markers are ignored: no second abandon, nothing named', () => {
    const { state, abandoned, log, open } = markers();
    open(2);
    step(state, 9);
    step(state, 2);
    stepped(state, 3);
    step(state, 7);
    expect(abandoned).toEqual(['marker']);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(state.openStep).toBeNull();
    expect(died(state).culprit).toBeNull();
  });

  test('a forged marker names nobody even when the abandon ended nothing (the process had exited)', () => {
    const { state, abandoned, open } = markers({ abandons: false });
    open(2);
    step(state, 2);
    step(state, 2);
    expect(abandoned).toEqual(['marker']);
    expect(died(state).culprit).toBeNull();
  });

  test('markers after the death are ignored', () => {
    const { state, abandoned, open } = markers();
    open(2);
    died(state);
    step(state, 9);
    expect(abandoned).toEqual([]);
  });

  test('a reply in its step on a process already abandoned stands: nothing is refused twice', () => {
    const { state, clock, abandoned, open } = markers();
    open(2, 1_000);
    open(3);
    step(state, 2);
    // Request 2's step overruns its deadline: the process is abandoned first.
    clock.advance(1_000 + OVERRUN_MS);
    expect(abandoned).toEqual(['overrun']);
    expect(state.closed(2)).toBe(true);
    expect(abandoned).toEqual(['overrun']);
  });
});

describe('the death', () => {
  test('those waiting for it get its record when it is made, or at once after', () => {
    const { state, open } = markers();
    open(2);
    const got = [];
    state.afterDeath((death) => got.push(['first', death]));
    state.afterDeath((death) => got.push(['second', death]));
    expect(got).toEqual([]);
    const death = died(state);
    expect(got).toEqual([
      ['first', death],
      ['second', death],
    ]);
    state.afterDeath((record) => got.push(['late', record]));
    expect(got[2]).toEqual(['late', death]);
    // Called once: a second die returns the record and calls nobody.
    died(state);
    expect(got).toHaveLength(3);
  });

  test("a death inside a step names that step's request", () => {
    const { state, open } = markers();
    open(2);
    open(3);
    step(state, 3);
    expect(died(state)).toEqual({
      generation: 3,
      code: null,
      signal: 'SIGSEGV',
      cause: null,
      culprit: 3,
      reason: 'service exited (SIGSEGV)',
    });
  });

  test('a death after the step was cleared names nobody', () => {
    const { state, open } = markers();
    open(2);
    step(state, 2);
    stepped(state, 2);
    expect(died(state, { code: 70, signal: null, cause: null })).toMatchObject({
      culprit: null,
      reason: 'service exited (70)',
    });
  });

  test('a broken pipe inside a step names it too; main ending the process names nobody', () => {
    for (const [cause, culprit] of [
      ['transport', 2],
      ['shutdown', null],
      ['protocol', null],
      ['hang', null],
      ['handshake_timeout', null],
    ]) {
      const { state, open } = markers();
      open(2);
      step(state, 2);
      expect([cause, died(state, { code: null, signal: 'SIGKILL', cause }).culprit]).toEqual([
        cause,
        culprit,
      ]);
    }
  });

  test('the record is frozen at the first call', () => {
    const { state, open } = markers();
    open(2);
    step(state, 2);
    const first = died(state);
    expect(Object.isFrozen(first)).toBe(true);
    expect(died(state, { code: 0, signal: null, cause: 'shutdown' })).toBe(first);
  });

  test("the reasons: fixed texts, none the resolver's retry pattern", () => {
    const retryable = /ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network|no response|timeout/i;
    const reasons = [
      deathReason({ code: 70, cause: null }),
      deathReason({ signal: 'SIGSEGV', cause: null }),
      ...['overrun', 'marker', 'protocol', 'transport', 'shutdown', 'hang', 'retired'].map(
        (cause) => deathReason({ code: null, signal: 'SIGKILL', cause })
      ),
    ];
    expect(reasons).toEqual([
      'service exited (70)',
      'service exited (SIGSEGV)',
      'verification still running after its deadline',
      'step marker out of order',
      'protocol error',
      'service connection failed',
      'service stopped',
      'request hung',
      'service abandoned (retired)',
    ]);
    for (const reason of reasons) expect(reason).not.toMatch(retryable);
  });
});

describe('overruns', () => {
  test("a step still open 2 s past its request's deadline is killed, and named", () => {
    const { state, clock, abandoned, log, open } = markers();
    open(2, 1_000);
    open(3, 60_000);
    clock.advance(500);
    step(state, 2);
    clock.advance(500 + OVERRUN_MS - 1);
    expect(abandoned).toEqual([]);
    clock.advance(1);
    expect(abandoned).toEqual(['overrun']);
    expect(log.warn).toHaveBeenCalledWith('[colibrid] step overran its deadline');
    // Killed: what it writes until its pipe closes is ignored.
    stepped(state, 2);
    step(state, 9);
    expect(abandoned).toEqual(['overrun']);
    expect(died(state, { code: null, signal: 'SIGKILL', cause: 'overrun' })).toMatchObject({
      culprit: 2,
      reason: 'verification still running after its deadline',
    });
  });

  test("past the deadline with no step of its own open, or another request's open, nothing is killed", () => {
    const { state, clock, abandoned, open } = markers();
    open(2, 1_000);
    open(3, 60_000);
    step(state, 2);
    stepped(state, 2);
    step(state, 3);
    clock.advance(1_000 + OVERRUN_MS);
    expect(abandoned).toEqual([]);
    expect(died(state).culprit).toBe(3);
  });

  test('a request answered before its overrun disarms it', () => {
    const { state, clock, abandoned, open } = markers();
    open(2, 1_000);
    state.closed(2);
    expect(clock.armed()).toBe(0);
    clock.advance(10_000);
    expect(abandoned).toEqual([]);
  });

  test('a step opened later than its deadline + 2 s gets 2 s of its own (a free after the cancel)', () => {
    const { state, clock, abandoned, open } = markers();
    open(2, 1_000);
    clock.advance(1_000 + OVERRUN_MS + 5_000);
    // A step that clears in time is no overrun.
    step(state, 2);
    clock.advance(OVERRUN_MS - 1);
    stepped(state, 2);
    clock.advance(OVERRUN_MS);
    expect(abandoned).toEqual([]);
    // One that doesn't is.
    step(state, 2);
    clock.advance(OVERRUN_MS - 1);
    expect(abandoned).toEqual([]);
    clock.advance(1);
    expect(abandoned).toEqual(['overrun']);
    expect(died(state, { code: null, signal: 'SIGKILL', cause: 'overrun' }).culprit).toBe(2);
  });

  test('a step opened between the deadline and its 2 s has only what is left of them', () => {
    const { state, clock, abandoned, open } = markers();
    open(2, 1_000);
    clock.advance(1_000 + OVERRUN_MS - 100);
    step(state, 2);
    clock.advance(100);
    expect(abandoned).toEqual(['overrun']);
  });

  test('an overrun the abandon refused (main is stopping it) leaves the death to its cause', () => {
    const { state, clock, abandoned, open } = markers({ abandons: false });
    open(2, 1_000);
    step(state, 2);
    clock.advance(1_000 + OVERRUN_MS);
    expect(abandoned).toEqual(['overrun']);
    expect(died(state, { code: 0, signal: null, cause: 'shutdown' }).culprit).toBeNull();
  });
});
