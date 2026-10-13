const { spawnSync } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  FILE_MODE,
  createJournal,
  encodeLine,
  parseJournal,
  readJournal,
} = require('./durable-journal');

const POSIX = process.platform !== 'win32';
const posixOnly = POSIX ? test : test.skip;

let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-journal-'));
  file = path.join(dir, 'journal.jsonl');
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

// The FileHandle class isn't exported; take its prototype from a live handle.
async function fileHandlePrototype() {
  const handle = await fsp.open(path.join(dir, 'probe'), 'w');
  await handle.close();
  return Object.getPrototypeOf(handle);
}

async function openJournal(options) {
  const journal = createJournal(file, options);
  await journal.open();
  return journal;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('lines', () => {
  test('each line is JSON with the checksum of its record', () => {
    const line = encodeLine({ type: 'commit', n: 1 });
    expect(line.endsWith('}\n')).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      v: 1,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      record: { type: 'commit', n: 1 },
    });
    expect(parseJournal(Buffer.from(line)).records).toEqual([{ type: 'commit', n: 1 }]);
  });

  test('only JSON objects are records', async () => {
    const journal = await openJournal();
    for (const value of [null, 'text', 7, [1, 2]]) {
      await expect(journal.append(value)).rejects.toMatchObject({ code: 'JOURNAL_INVALID_RECORD' });
    }
    expect(fs.existsSync(file)).toBe(false);
  });

  test('records keep non-ASCII text and line separators intact', async () => {
    const journal = await openJournal();
    const record = {
      label: 'Zahlung für Café ☕',
      odd: `a\nb${String.fromCharCode(0x2028)}c`,
      lone: '\ud800',
    };
    await journal.append(record);
    const result = await readJournal(file);
    expect(result.corrupt).toEqual([]);
    expect(result.records).toEqual([record]);
  });
});

describe('append', () => {
  test('resolves only after filehandle.sync() has finished', async () => {
    const proto = await fileHandlePrototype();
    const realAppendFile = proto.appendFile;
    const realSync = proto.sync;
    const events = [];
    const syncStarted = deferred();
    const gate = deferred();
    jest.spyOn(proto, 'appendFile').mockImplementation(function (...args) {
      events.push('write');
      return realAppendFile.apply(this, args);
    });
    jest.spyOn(proto, 'sync').mockImplementation(async function () {
      events.push('sync started');
      syncStarted.resolve();
      await gate.promise;
      await realSync.call(this);
      events.push('sync finished');
    });

    const journal = await openJournal();
    let acknowledged = false;
    const appended = journal.append({ n: 1 }).then(() => {
      acknowledged = true;
      events.push('acknowledged');
    });

    try {
      // The write happened and the sync began; the append must still wait.
      await syncStarted.promise;
      expect(events).toEqual(['write', 'sync started']);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(acknowledged).toBe(false);
    } finally {
      gate.resolve();
      await appended;
    }
    // The file's own sync comes first; creating the file also syncs the
    // directory (POSIX) before the append is acknowledged.
    expect(events.slice(0, 3)).toEqual(['write', 'sync started', 'sync finished']);
    expect(events[events.length - 1]).toBe('acknowledged');
    expect((await readJournal(file)).records).toEqual([{ n: 1 }]);
  });

  posixOnly('creating the file syncs its directory before acknowledging', async () => {
    const realOpen = fsp.open;
    const synced = [];
    jest.spyOn(fsp, 'open').mockImplementation(async (target, ...rest) => {
      const handle = await realOpen(target, ...rest);
      const realSync = handle.sync.bind(handle);
      handle.sync = async () => {
        synced.push(target);
        return realSync();
      };
      return handle;
    });

    const journal = await openJournal();
    await journal.append({ n: 1 });
    expect(synced).toEqual([file, dir]);

    synced.length = 0;
    await journal.append({ n: 2 });
    expect(synced).toEqual([file]);
  });

  posixOnly('the file is mode 0600, also after compaction', async () => {
    const journal = await openJournal();
    await journal.append({ n: 1 });
    expect(fs.statSync(file).mode & 0o777).toBe(FILE_MODE);

    await journal.compact([{ n: 1 }]);
    expect(fs.statSync(file).mode & 0o777).toBe(FILE_MODE);
  });

  posixOnly('opening a looser file tightens it to 0600', async () => {
    fs.writeFileSync(file, encodeLine({ n: 1 }), { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    await openJournal();
    expect(fs.statSync(file).mode & 0o777).toBe(FILE_MODE);
  });

  test('concurrent appends are serialized whole, in call order', async () => {
    const journal = await openJournal();
    // Large lines too, well past what one write() call is sure to take.
    const records = Array.from({ length: 60 }, (_, n) => ({
      n,
      pad: 'x'.repeat(n % 3 === 0 ? 300_000 : n * 7),
    }));
    await Promise.all(records.map((record) => journal.append(record)));

    const result = await readJournal(file);
    expect(result.corrupt).toEqual([]);
    expect(result.tornTail).toBe(0);
    expect(result.records.map((record) => record.n)).toEqual(records.map((record) => record.n));
    expect(journal.size).toBe(fs.statSync(file).size);
  });

  test('a write that fails is cut back off, and the next append is clean', async () => {
    const journal = await openJournal();
    await journal.append({ n: 1 });
    const proto = await fileHandlePrototype();
    const realAppendFile = proto.appendFile;
    // A partial write, then the disk fills up.
    jest.spyOn(proto, 'appendFile').mockImplementationOnce(async function (data) {
      await realAppendFile.call(this, data.subarray(0, 20));
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });

    await expect(journal.append({ n: 2 })).rejects.toMatchObject({ code: 'ENOSPC' });
    await journal.append({ n: 3 });

    const result = await readJournal(file);
    expect(result.corrupt).toEqual([]);
    expect(result.records).toEqual([{ n: 1 }, { n: 3 }]);
  });

  test('when the cut fails too, every later write is refused until reopened', async () => {
    const journal = await openJournal();
    await journal.append({ n: 1 });
    const proto = await fileHandlePrototype();
    const realAppendFile = proto.appendFile;
    jest.spyOn(proto, 'appendFile').mockImplementationOnce(async function (data) {
      await realAppendFile.call(this, data.subarray(0, 20));
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    });
    jest
      .spyOn(proto, 'truncate')
      .mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));

    await expect(journal.append({ n: 2 })).rejects.toMatchObject({ code: 'EIO' });
    await expect(journal.append({ n: 3 })).rejects.toMatchObject({ code: 'JOURNAL_BROKEN' });
    await expect(journal.compact([{ n: 1 }])).rejects.toMatchObject({ code: 'JOURNAL_BROKEN' });

    // Reopening reads what is there: the half line is a torn tail, cut off.
    const reopened = await journal.open();
    expect(reopened.records).toEqual([{ n: 1 }]);
    expect(reopened.tornTail).toBeGreaterThan(0);
    await journal.append({ n: 4 });
    expect((await readJournal(file)).records).toEqual([{ n: 1 }, { n: 4 }]);
  });

  test('appending before open() is refused', async () => {
    const journal = createJournal(file);
    await expect(journal.append({ n: 1 })).rejects.toMatchObject({ code: 'JOURNAL_NOT_OPEN' });
  });

  test('a line appended right before SIGKILL is there on reload', () => {
    // A real hard kill: a child process appends, and the moment the append
    // is acknowledged, kills itself. No exit handler or flush runs.
    const script = `
      const { createJournal } = require(process.env.JOURNAL_MODULE);
      const journal = createJournal(process.env.JOURNAL_FILE);
      (async () => {
        await journal.open();
        for (let n = 0; n < 20; n += 1) await journal.append({ n });
        await journal.append({ last: 'words' });
        process.kill(process.pid, 'SIGKILL');
      })();
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        JOURNAL_MODULE: require.resolve('./durable-journal'),
        JOURNAL_FILE: file,
      },
      timeout: 30000,
    });
    expect(result.signal).toBe('SIGKILL');

    return readJournal(file).then((reloaded) => {
      expect(reloaded.corrupt).toEqual([]);
      expect(reloaded.records).toEqual([
        ...Array.from({ length: 20 }, (_, n) => ({ n })),
        { last: 'words' },
      ]);
    });
  });
});

describe('reading', () => {
  test('a missing file is an empty journal', async () => {
    const journal = createJournal(file);
    const result = await journal.open();
    expect(result).toMatchObject({ missing: true, records: [], corrupt: [], tornTail: 0 });
    expect(fs.existsSync(file)).toBe(false);
  });

  test('a torn last line is ignored, and open() cuts it off', async () => {
    const good = encodeLine({ n: 1 }) + encodeLine({ n: 2 });
    const torn = encodeLine({ n: 3 }).slice(0, 40);
    fs.writeFileSync(file, good + torn);

    const read = await readJournal(file);
    expect(read.records).toEqual([{ n: 1 }, { n: 2 }]);
    expect(read.corrupt).toEqual([]);
    expect(read.tornTail).toBe(Buffer.byteLength(torn));
    // Reading changes nothing.
    expect(fs.readFileSync(file, 'utf8')).toBe(good + torn);

    const journal = createJournal(file);
    await journal.open();
    expect(fs.readFileSync(file, 'utf8')).toBe(good);
    await journal.append({ n: 4 });
    const after = await readJournal(file);
    expect(after.corrupt).toEqual([]);
    expect(after.records).toEqual([{ n: 1 }, { n: 2 }, { n: 4 }]);
  });

  test('a tail of zero bytes (size extended, data lost) is torn too', async () => {
    fs.writeFileSync(file, Buffer.concat([Buffer.from(encodeLine({ n: 1 })), Buffer.alloc(512)]));
    const read = await readJournal(file);
    expect(read.records).toEqual([{ n: 1 }]);
    expect(read.corrupt).toEqual([]);
    expect(read.tornTail).toBe(512);
  });

  test('a bad middle line is skipped and reported', async () => {
    const first = encodeLine({ n: 1 });
    const flipped = encodeLine({ n: 2 }).replace('"n":2', '"n":9');
    const garbage = 'not a journal line\n';
    const last = encodeLine({ n: 3 });
    fs.writeFileSync(file, first + flipped + garbage + last);

    const read = await readJournal(file);
    expect(read.records).toEqual([{ n: 1 }, { n: 3 }]);
    expect(read.corrupt).toEqual([
      { line: 2, offset: Buffer.byteLength(first), reason: 'checksum' },
      { line: 3, offset: Buffer.byteLength(first + flipped), reason: 'malformed' },
    ]);
    expect(read.tornTail).toBe(0);
  });

  test('a file over the size bound is refused', async () => {
    fs.writeFileSync(file, encodeLine({ pad: 'x'.repeat(2000) }));
    const journal = createJournal(file, { maxBytes: 1024 });
    await expect(journal.open()).rejects.toMatchObject({ code: 'JOURNAL_TOO_LARGE' });
    await expect(journal.append({ n: 1 })).rejects.toMatchObject({ code: 'JOURNAL_NOT_OPEN' });
  });

  test('something other than a regular file is refused', async () => {
    fs.mkdirSync(file);
    await expect(createJournal(file).open()).rejects.toMatchObject({ code: 'JOURNAL_NOT_A_FILE' });
  });
});

describe('compaction', () => {
  test('replaces the file with the records given', async () => {
    const journal = await openJournal();
    for (let n = 0; n < 5; n += 1) await journal.append({ n });
    await journal.compact([{ n: 1 }, { n: 3 }]);

    expect((await readJournal(file)).records).toEqual([{ n: 1 }, { n: 3 }]);
    expect(journal.size).toBe(fs.statSync(file).size);
    await journal.append({ n: 5 });
    expect((await readJournal(file)).records).toEqual([{ n: 1 }, { n: 3 }, { n: 5 }]);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('the temp file is synced before the rename, and the directory after it', async () => {
    const events = [];
    const name = (target) =>
      path.basename(target).replace(/\.compact-[^.]+\.tmp$/, '.compact-*.tmp');
    const realOpen = fsp.open;
    jest.spyOn(fsp, 'open').mockImplementation(async (target, ...rest) => {
      const handle = await realOpen(target, ...rest);
      const realSync = handle.sync.bind(handle);
      handle.sync = async () => {
        await realSync();
        events.push(`sync ${name(target)}`);
      };
      return handle;
    });
    const realRename = fsp.rename;
    jest.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      await realRename(from, to);
      events.push(`rename ${name(from)} to ${name(to)}`);
    });

    const journal = await openJournal();
    await journal.append({ n: 1 });
    events.length = 0;
    await journal.compact([{ n: 1 }]);

    expect(events).toEqual([
      'sync journal.jsonl.compact-*.tmp',
      'rename journal.jsonl.compact-*.tmp to journal.jsonl',
      POSIX ? `sync ${path.basename(dir)}` : 'sync journal.jsonl',
    ]);
  });

  test('a crash between the temp write and the rename keeps the old journal', async () => {
    const journal = await openJournal();
    for (let n = 0; n < 3; n += 1) await journal.append({ n });
    const before = fs.readFileSync(file);

    jest
      .spyOn(fsp, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));
    await expect(journal.compact([{ n: 2 }])).rejects.toMatchObject({ code: 'EIO' });

    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    // The journal is still usable, with nothing lost.
    await journal.append({ n: 3 });
    expect((await readJournal(file)).records).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }]);
  });

  test('a temp file left by a process that died before the rename is removed on open', async () => {
    const journal = await openJournal();
    for (let n = 0; n < 3; n += 1) await journal.append({ n });
    const before = fs.readFileSync(file);
    const leftover = path.join(dir, 'journal.jsonl.compact-1234.tmp');
    fs.writeFileSync(leftover, encodeLine({ n: 2 }));
    const unrelated = path.join(dir, 'other.jsonl.compact-1.tmp');
    fs.writeFileSync(unrelated, 'keep');

    const reopened = createJournal(file);
    const result = await reopened.open();
    expect(result.records).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }]);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.existsSync(leftover)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  test('compaction waits for appends ahead of it, and appends after it wait for it', async () => {
    const journal = await openJournal();
    const order = [];
    const first = journal.append({ n: 1 }).then(() => order.push('append 1'));
    const compacted = journal.compact([{ n: 0 }]).then(() => order.push('compact'));
    const second = journal.append({ n: 2 }).then(() => order.push('append 2'));
    await Promise.all([first, compacted, second]);

    expect(order).toEqual(['append 1', 'compact', 'append 2']);
    expect((await readJournal(file)).records).toEqual([{ n: 0 }, { n: 2 }]);
  });
});

describe('moving aside', () => {
  test('moves the file to <file>.<tag> and starts an empty journal', async () => {
    fs.writeFileSync(file, encodeLine({ n: 1 }) + 'junk\n');
    const journal = createJournal(file);
    await journal.open();

    const moved = await journal.moveAside('corrupt-1000');
    expect(moved).toBe(`${file}.corrupt-1000`);
    expect(fs.readFileSync(moved, 'utf8')).toBe(encodeLine({ n: 1 }) + 'junk\n');
    expect(fs.existsSync(file)).toBe(false);

    await journal.append({ n: 2 });
    expect((await readJournal(file)).records).toEqual([{ n: 2 }]);
  });

  test('works when open() refused the file, and never overwrites an earlier one', async () => {
    fs.writeFileSync(`${file}.corrupt-1000`, 'earlier');
    fs.writeFileSync(file, encodeLine({ pad: 'x'.repeat(2000) }));
    const journal = createJournal(file, { maxBytes: 1024 });
    await expect(journal.open()).rejects.toMatchObject({ code: 'JOURNAL_TOO_LARGE' });

    const moved = await journal.moveAside('corrupt-1000');
    expect(moved).toBe(`${file}.corrupt-1000-1`);
    expect(fs.readFileSync(`${file}.corrupt-1000`, 'utf8')).toBe('earlier');
    await journal.append({ n: 1 });
    expect((await readJournal(file)).records).toEqual([{ n: 1 }]);
  });
});
