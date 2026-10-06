const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atOriginalCommit, createProbe, journalState } = require('./railgun-account-fence-process');

test('COMMIT gate preserves actual receiver, arguments, return and method descriptor', () => {
  const returned = {},
    receiver = {},
    observed = [];
  function Database() {}
  Database.prototype.exec = function (...args) {
    observed.push({ receiver: this, args });
    return returned;
  };
  const original = Object.getOwnPropertyDescriptor(Database.prototype, 'exec');
  const result = atOriginalCommit(
    Database,
    () => observed.push('pause'),
    () => Database.prototype.exec.call(receiver, 'COMMIT')
  );
  expect(result).toBe(returned);
  expect(observed).toEqual([{ receiver, args: ['COMMIT'] }, 'pause']);
  expect(Object.getOwnPropertyDescriptor(Database.prototype, 'exec')).toEqual(original);
});
test('original COMMIT error identity is preserved with no gate and exact restoration', () => {
  const error = Error('original'),
    pause = jest.fn();
  function Database() {}
  Database.prototype.exec = () => {
    throw error;
  };
  const original = Database.prototype.exec;
  expect(() => atOriginalCommit(Database, pause, () => Database.prototype.exec('COMMIT'))).toThrow(
    error
  );
  expect(Database.prototype.exec).toBe(original);
  expect(pause).not.toHaveBeenCalled();
});
test.each(['BEGIN EXCLUSIVE', 'COMMIT;', undefined])(
  'missing exact original COMMIT refuses (%s)',
  (sql) => {
    function Database() {}
    Database.prototype.exec = () => undefined;
    expect(() =>
      atOriginalCommit(
        Database,
        () => {},
        () => Database.prototype.exec(sql)
      )
    ).toThrow('Expected the exact original initialization COMMIT');
  }
);
test('original twice-COMMIT is not silently collapsed into one observation', () => {
  function Database() {}
  Database.prototype.exec = () => undefined;
  const pause = jest.fn();
  expect(() =>
    atOriginalCommit(Database, pause, () => {
      Database.prototype.exec('COMMIT');
      Database.prototype.exec('COMMIT');
    })
  ).toThrow();
  expect(pause).toHaveBeenCalledTimes(1);
});
test.each([false, true])(
  'synthetic pause retains original update and rejects revoked writer after gate (%s)',
  async (revoke) => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-public-unit-')));
    let active = true,
      run = false;
    const events = [];
    const fence = {
      closed: Promise.resolve(),
      assertCurrent: () => {
        assert.ok(active);
      },
      run: (use) => {
        run = true;
        return use();
      },
    };
    const probe = createProbe({
      role: 'A',
      directories: { commit: directory },
      openFence: () => fence,
      emit: (value) => events.push(value),
      gate: () => {
        expect(run).toBe(true);
        expect(events.at(-1).event).toBe('before-rename');
        expect(fs.existsSync(path.join(directory, 'synthetic-state.json'))).toBe(false);
        if (revoke) active = false;
      },
    });
    await probe.command({ id: 1, action: 'acquire', name: 'commit', create: true });
    const pending = probe.command({ id: 2, action: 'write', name: 'commit', pause: true });
    if (revoke) {
      await expect(pending).rejects.toThrow();
      expect(fs.existsSync(path.join(directory, 'synthetic-state.json'))).toBe(false);
    } else {
      await pending;
      expect(events.at(-1)).toMatchObject({ event: 'written', state: { generation: 1 } });
    }
    expect(() => probe.assertReleased()).toThrow();
  }
);
test('only exact lock refusal becomes a busy observation; infrastructure faults escape', async () => {
  for (const code of ['RAILGUN_ACCOUNT_FENCE_BUSY', 'RAILGUN_ACCOUNT_FENCE_REFUSED', 'ENOENT']) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-public-unit-'))),
      events = [];
    const probe = createProbe({
      role: 'B',
      directories: { commit: directory },
      openFence: () => {
        throw Object.assign(Error('fault'), { code });
      },
      emit: (e) => events.push(e),
    });
    const pending = probe.command({ id: 1, action: 'probe', name: 'commit' });
    if (code === 'RAILGUN_ACCOUNT_FENCE_BUSY') {
      await pending;
      expect(events).toEqual([{ id: 1, event: 'busy', name: 'commit', state: null }]);
    } else {
      await expect(pending).rejects.toMatchObject({ code });
      expect(events).toEqual([]);
    }
  }
});

test('fixed child imports name the pinned .js bytes and cannot select extensionless siblings', () => {
  const source = fs.readFileSync(path.join(__dirname, 'railgun-account-fence-process.js'), 'utf8');
  expect(source).toContain("require('../qualify-railgun-account-fence.js')");
  expect(source).toContain("'src/main/wallet/railgun-account-fence.js'");
  expect(source).not.toContain("require('../qualify-railgun-account-fence')");
  expect(source).not.toContain("'src/main/wallet/railgun-account-fence')");
});

test('journal observation uses stat only and refuses nonempty sidecars', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-journal-unit-')));
  const database = path.join(directory, 'writer-fence.sqlite'),
    journal = database + '-journal';
  fs.writeFileSync(database, 'public dummy database');
  const read = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
    throw Error('no file reads');
  });
  try {
    expect(journalState(directory)).toBe('absent');
    fs.writeFileSync(journal, '');
    expect(journalState(directory)).toBe('zero-length');
    fs.writeFileSync(journal, 'hot');
    expect(() => journalState(directory)).toThrow();
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});
