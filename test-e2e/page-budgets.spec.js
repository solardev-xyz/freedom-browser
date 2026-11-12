// Page request sizes, charges and tickets in real Electron (freedom-core
// design 0011, step PRQ-2): the app's preload measures each request and
// refuses one over its method's size without sending it, main measures it
// again and refuses what a renderer sends past the preload before it records
// anything, a large upload takes a ticket, and for every method, its largest
// legal request in each worst form stays within its charge in main: the
// charge is in place at every copy, and main's measured peak (the IPC value
// and every live copy) is no more than it.
//
// No provider method takes the new path yet. The harness's test hooks
// (src/main/page/page-requests.js) route every method through main for this
// spec and serve them with a dispatcher that makes the copies design 0011's
// "Copies" table counts for each: for `swarm_publishFiles` normalizeBytes'
// copy and 1 MiB of stream buffers, for `swarm_publishData` normalizeBytes'
// copy and fetch's copy of the body, and for every other method the JSON for
// the core and that JSON's bytes.

const path = require('path');
const { test, expect } = require('./fixtures');

const A = `bzz://${'c'.repeat(64)}`;
const ROOT = path.resolve(__dirname, '..');
const FORGED_PRELOAD = path.join(__dirname, 'page-budgets-forged-preload.js');
const MiB = 1024 * 1024;
const REST = 64 * 1024;

// The page builds each request: `form` filling `size`, the request's whole
// size by the walk (its nonce, provider, method and the property names).
const PAGE = {
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><title>budgets</title><script>
    const ch = (code) => String.fromCharCode(code);
    window.__make = (form, n) => {
      if (form === 'u8') return new Uint8Array(n).fill(255);
      if (form === 'two-byte') return ch(0x100) + 'a'.repeat(n - 2);
      if (form === 'control') return ch(1).repeat(n);
      if (form === 'two-byte-control') return ch(0x100) + ch(1).repeat(n - 2);
      throw new Error(form);
    };
    window.__params = (provider, method, form, size) => {
      const rest = 'nonceprovidermethodparams'.length + 32 + provider.length + method.length;
      if (form === 'values') {
        const names = {};
        for (let i = 0; i < (provider === 'ethereum' ? 9994 : 9995); i += 1) names['k' + i] = '';
        return provider === 'ethereum' ? [names] : names;
      }
      if (provider === 'ethereum') return [window.__make(form, size - rest)];
      return { data: window.__make(form, size - rest - 'data'.length) };
    };
    window.__ask = async (provider, method, form, size) => {
      const target = provider === 'ethereum' ? window.ethereum : window[provider];
      try {
        return { result: await target.request({ method, params: window.__params(provider, method, form, size) }) };
      } catch (err) {
        return { error: { code: err.code, message: err.message } };
      }
    };
    window.__ready = true;
  </script><h1>budgets</h1>`,
};

/** Serve every method with a dispatcher that makes each method's copies. */
async function instrument(electronApp) {
  await electronApp.evaluate(() => {
    process.mainModule.require('v8').setFlagsFromString('--expose-gc');
    const gc = process.mainModule.require('vm').runInNewContext('gc');
    const hooks = globalThis.__FREEDOM_TEST_PAGE_REQUESTS__;
    const used = () => {
      gc();
      gc();
      const memory = process.memoryUsage();
      return memory.heapUsed + memory.external;
    };
    const state = { baseline: 0, copies: [], accounted: null, unpaid: 0, served: [], forged: [] };
    state.mark = () => {
      state.copies = [];
      state.accounted = null;
      state.baseline = used();
    };
    globalThis.__budgets = state;
    hooks.setOnCopy((entry) => {
      state.copies.push({ label: entry.label, inPlace: entry.inPlace, charge: entry.charge, used: used() - state.baseline });
    });
    // Binary as hex in JSON, as any JSON path would carry it.
    const hex = function (key, value) {
      const raw = this[key];
      if (raw instanceof Uint8Array) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('hex');
      if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('hex');
      return value;
    };
    // As swarm-provider-ipc.js's normalizeBytes: a Uint8Array copied into a
    // Buffer, an ArrayBuffer viewed.
    const normalizeBytes = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    const isBinary = (value) => value instanceof Uint8Array || value instanceof ArrayBuffer;
    // What V8 holds a value in: a string at one or two bytes a character,
    // binary data at its length. Null for anything else (the values form),
    // which only the heap measurement accounts for.
    const bytesOf = (value) => {
      if (typeof value === 'string') {
        for (let i = 0; i < value.length; i += 1) if (value.charCodeAt(i) > 0xff) return 2 * value.length;
        return value.length;
      }
      return isBinary(value) ? value.byteLength : null;
    };
    hooks.setDispatch(async (context) => {
      const { method, params } = context;
      const data = Array.isArray(params) ? params[0] : params && params.data;
      const live = [];
      const accounted = { ipc: bytesOf(data), copies: [] };
      state.accounted = accounted;
      // A copy the request's path makes, accounted at its own size, then
      // reported to main (whose hook measures the heap).
      const copy = (label, value, bytes = bytesOf(value)) => {
        live.push(value);
        accounted.copies.push({ label, bytes });
        // A test's unpaid copy: live, unaccounted, and not in the charge.
        if (state.unpaid > 0 && live.length === 1) live.push(Buffer.alloc(state.unpaid, 1));
        context.copied(label);
      };
      state.served.push({ method, data: Buffer.isBuffer(data) ? 'Buffer' : data instanceof Uint8Array ? 'Uint8Array' : typeof data });
      if (method === 'swarm_publishData') {
        if (typeof data === 'string') {
          copy('fetch', Buffer.from(data, 'utf8'));
        } else if (isBinary(data)) {
          // A view of an ArrayBuffer, or a Buffer, is no copy.
          const bytes = normalizeBytes(data);
          copy('normalizeBytes', bytes, bytes === data || !(data instanceof Uint8Array) ? 0 : bytes.byteLength);
          copy('fetch', Buffer.from(bytes));
        } else {
          copy('validated', null, 0);
        }
      } else if (method === 'swarm_publishFiles') {
        if (isBinary(data)) {
          const bytes = normalizeBytes(data);
          copy('normalizeBytes', bytes, bytes === data || !(data instanceof Uint8Array) ? 0 : bytes.byteLength);
        }
        copy('stream', Buffer.alloc(1024 * 1024));
      } else {
        const json = JSON.stringify(params, hex);
        copy('json', json);
        copy('body', Buffer.from(json, 'utf8'));
      }
      return { result: live.length };
    });
  });
}

const state = (electronApp) =>
  electronApp.evaluate(() => ({
    served: globalThis.__budgets.served.slice(),
    forged: globalThis.__budgets.forged.slice(),
    trace: globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.trace.slice(),
  }));

/** Run one case: main's measured peak at each copy, and the bytes its path accounted. */
async function measured(electronApp, win, provider, method, form, size) {
  await electronApp.evaluate(() => globalThis.__budgets.mark());
  const answer = await ask(win, provider, method, form, size);
  const { copies, accounted } = await electronApp.evaluate(() => ({
    copies: globalThis.__budgets.copies.slice(),
    accounted: globalThis.__budgets.accounted,
  }));
  return { answer, copies, accounted };
}

const activeGuestId = (win) =>
  win.evaluate(() => document.querySelector('webview:not(.hidden)')?.getWebContentsId() ?? null);

const inPage = (win, js) =>
  win.evaluate((code) => document.querySelector('webview:not(.hidden)').executeJavaScript(code), js);

const ask = (win, provider, method, form, size) =>
  inPage(win, `window.__ask(${JSON.stringify(provider)}, ${JSON.stringify(method)}, ${JSON.stringify(form)}, ${size})`);

/** A new tab (its boot switch carries the routes) on the budgets page. */
async function openPage(electronApp, win, harness) {
  await harness.setContentFixture(`${A}/`, PAGE);
  const before = await activeGuestId(win);
  await win.locator('[data-test="new-tab-btn"]').click();
  let id = null;
  await expect
    .poll(async () => {
      id = await activeGuestId(win).catch(() => null);
      return id !== null && id !== before;
    })
    .toBe(true);
  await load(electronApp, win, id);
  return id;
}

async function load(electronApp, win, id) {
  await electronApp.evaluate(({ webContents }, args) => {
    webContents.fromId(args.id).loadURL(args.url).catch(() => {});
  }, { id, url: `${A}/` });
  await expect
    .poll(() => inPage(win, 'window.__ready === true').catch(() => false), { timeout: 20_000 })
    .toBe(true);
}

/** Main's trace entries added while `run` ran. */
async function traced(electronApp, run) {
  const from = (await state(electronApp)).trace.length;
  const value = await run();
  return { value, entries: (await state(electronApp)).trace.slice(from) };
}

test('a request\'s size is checked in the preload and again in main, and a large upload takes a ticket (0011 PRQ-2)', async ({
  window: win,
  electronApp,
  harness,
}) => {
  test.setTimeout(120_000);
  await instrument(electronApp);
  const id = await openPage(electronApp, win, harness);

  // Exactly its size, through the app's preload: served.
  let run = await traced(electronApp, () => ask(win, 'swarm', 'swarm_readChunk', 'control', MiB));
  expect(run.value).toEqual({ result: 2 });
  expect(run.entries.map((e) => e.kind)).toEqual(['recorded', 'answered', 'released']);
  // One byte more: the preload answers it, and main never hears of it.
  run = await traced(electronApp, () => ask(win, 'swarm', 'swarm_readChunk', 'control', MiB + 1));
  expect(run.value).toEqual({ error: { code: -32005, message: 'Limit exceeded' } });
  expect(run.entries).toEqual([]);

  // A large upload of exactly its size reserves a turn, gets a ticket, and
  // spends it.
  run = await traced(electronApp, () => ask(win, 'swarm', 'swarm_publishData', 'u8', 10 * MiB + REST));
  expect(run.value).toEqual({ result: 2 });
  expect(run.entries.map((e) => e.kind)).toEqual([
    'reservation-waiting',
    'ticket-granted',
    'ticket-burnt',
    'recorded',
    'answered',
    'released',
  ]);
  run = await traced(electronApp, () => ask(win, 'swarm', 'swarm_publishData', 'u8', 10 * MiB + REST + 1));
  expect(run.value).toEqual({ error: { code: -32602, message: 'Payload exceeds maximum size of 10485760 bytes' } });
  expect(run.entries).toEqual([]);

  // Past the preload: main walks it first, and records none of these.
  await electronApp.evaluate(({ webContents }, args) => {
    const guest = webContents.fromId(args.id);
    guest.on('ipc-message', (_event, channel, payload) => {
      if (channel === 'page-budgets-test:forged') globalThis.__budgets.forged.push(payload);
    });
    guest.session.registerPreloadScript({ type: 'frame', id: 'page-budgets-test-forged', filePath: args.preload });
  }, { id, preload: FORGED_PRELOAD });
  await load(electronApp, win, id);
  const rest = 'nonceprovidermethodparams'.length + 32 + 'swarm'.length + 'swarm_readChunk'.length + 'data'.length;
  const specs = [
    { id: 'exact', method: 'swarm_readChunk', kind: 'string', length: MiB - rest },
    { id: 'over', method: 'swarm_readChunk', kind: 'string', length: MiB - rest + 1 },
    { id: 'bigint-256', method: 'swarm_readChunk', kind: 'bigint', shift: 255 },
    { id: 'bigint-257', method: 'swarm_readChunk', kind: 'bigint', shift: 256 },
    { id: 'bigint-millions', method: 'swarm_readChunk', kind: 'bigint', shift: 4_000_000 },
    { id: 'large-no-ticket', method: 'swarm_publishData', kind: 'string', length: 2 * MiB },
  ];
  run = await traced(electronApp, async () => {
    await electronApp.evaluate(({ webContents }, args) => {
      for (const spec of args.specs) webContents.fromId(args.id).mainFrame.send('page-budgets-test:forge', spec);
    }, { id, specs });
    await expect.poll(async () => (await state(electronApp)).forged.length, { timeout: 20_000 }).toBe(specs.length);
  });
  await electronApp.evaluate(({ webContents }, guestId) => {
    webContents.fromId(guestId).session.unregisterPreloadScript('page-budgets-test-forged');
  }, id);
  const forged = Object.fromEntries((await state(electronApp)).forged.map((f) => [f.id, f.answer]));
  // What the walk lets through is refused by the attestation, which comes
  // after it (the forger has no nonce); what it refuses never gets that far.
  const wrongNonce = { error: { code: 4100, message: 'Unauthorized', data: { reason: 'wrong-nonce' } } };
  expect(forged).toEqual({
    exact: wrongNonce,
    over: { error: { code: -32005, message: 'Limit exceeded' } },
    'bigint-256': wrongNonce,
    'bigint-257': { error: { code: -32602, message: 'Invalid parameters' } },
    'bigint-millions': { error: { code: -32602, message: 'Invalid parameters' } },
    'large-no-ticket': { error: { code: -32005, message: 'Limit exceeded' } },
  });
  expect(run.entries.filter((e) => e.kind === 'recorded')).toEqual([]);
  expect(run.entries.filter((e) => e.kind === 'refused').map((e) => e.reason).sort()).toEqual(
    ['bigint', 'bigint', 'size', 'ticket', 'wrong-nonce', 'wrong-nonce'].sort()
  );
});

test('every method\'s largest legal request, in each worst form, stays within its charge in main (0011 PRQ-2)', async ({
  window: win,
  electronApp,
  harness,
}) => {
  test.setTimeout(600_000);
  await instrument(electronApp);
  await openPage(electronApp, win, harness);
  const rows = await electronApp.evaluate((_electron, root) => {
    const { METHODS } = process.mainModule.require(`${root}/src/main/page/page-methods`);
    const { pageRequestMaxBytes } = process.mainModule.require(`${root}/src/shared/page-request-bounds`);
    return [...METHODS.values()]
      .filter((row) => row.class !== 'refused')
      .map((row) => ({ provider: row.provider, method: row.method, size: pageRequestMaxBytes(row.provider, row.method) }));
  }, ROOT);
  expect(rows).toHaveLength(66);

  const FORMS = ['u8', 'two-byte', 'control', 'two-byte-control', 'values'];
  const formsOf = (method) => (method === 'swarm_publishFiles' ? ['u8', 'two-byte', 'values'] : FORMS);
  const groupOf = (method) => (method === 'swarm_publishFiles' || method === 'swarm_publishData' ? method : 'other');

  // Each path once first, unmeasured: the first request down a path makes
  // main compile its code (bytecode and feedback), which main keeps
  // whatever the request.
  const warmed = new Set();
  for (const { provider, method, size } of rows) {
    for (const form of formsOf(method)) {
      const path = `${provider} ${groupOf(method)} ${form}`;
      if (warmed.has(path)) continue;
      warmed.add(path);
      expect((await measured(electronApp, win, provider, method, form, size)).answer, path).toEqual({ result: expect.any(Number) });
    }
  }

  const worst = {};
  let closest = { spare: Infinity };
  for (const { provider, method, size } of rows) {
    for (const form of formsOf(method)) {
      const { answer, copies, accounted } = await measured(electronApp, win, provider, method, form, size);
      const label = `${method} ${form}`;
      expect(answer, label).toEqual({ result: expect.any(Number) });
      expect(copies.length, label).toBeGreaterThan(0);
      const charge = copies[0].charge;
      // Accounted: the IPC value and each copy at its own size, within the
      // charge exactly.
      if (accounted.ipc !== null) {
        const total = accounted.ipc + accounted.copies.reduce((sum, c) => sum + c.bytes, 0);
        expect({ label, accounted: total, within: total <= charge }).toEqual({ label, accounted: total, within: true });
      }
      // Measured: main's heap and external memory at each copy, the IPC
      // value, every live copy and main's own bookkeeping included, within
      // the charge, with no tolerance.
      for (const copy of copies) {
        expect({ label, copy: copy.label, inPlace: copy.inPlace }).toEqual({ label, copy: copy.label, inPlace: true });
        expect({ label, copy: copy.label, used: copy.used, charge, within: copy.used <= charge })
          .toEqual({ label, copy: copy.label, used: copy.used, charge, within: true });
        if (charge - copy.used < closest.spare) closest = { spare: charge - copy.used, label, copy: copy.label };
      }
      const peak = Math.max(...copies.map((copy) => copy.used));
      const group = groupOf(method);
      if (!worst[group] || peak / charge > worst[group].ratio) worst[group] = { form, method, peak, charge, ratio: peak / charge };
    }
  }

  // The measurement sees an unpaid copy: the largest swarm_publishData with
  // one more live copy, of 128 KiB and of 96 KiB, that its charge doesn't
  // pay for, measures over its charge. Main's 64 KiB bookkeeping allowance
  // sets the floor: a smaller unpaid copy can hide in what main's own record
  // leaves of it.
  const unpaid = {};
  for (const bytes of [128 * 1024, 96 * 1024]) {
    await electronApp.evaluate((_electron, n) => {
      globalThis.__budgets.unpaid = n;
    }, bytes);
    const { answer, copies } = await measured(electronApp, win, 'swarm', 'swarm_publishData', 'u8', 10 * MiB + REST);
    await electronApp.evaluate(() => {
      globalThis.__budgets.unpaid = 0;
    });
    expect(answer).toEqual({ result: 3 });
    unpaid[bytes] = Math.max(...copies.map((copy) => copy.used - copy.charge));
    expect({ bytes, over: unpaid[bytes] > 0 }).toEqual({ bytes, over: true });
  }

  // The worst case of each group, the least spare charge, the unpaid copies'
  // overruns, and how a Uint8Array reached main, for the record.
  const served = (await state(electronApp)).served;
  console.log(JSON.stringify({ worst, closest, unpaid, binary: [...new Set(served.map((s) => s.data))] }, null, 2));
  // The two-byte string of control characters is the generic path's worst:
  // above the design's 16 copies of its size, within 24.
  expect(worst.other.form).toBe('two-byte-control');
  expect(worst.other.peak).toBeGreaterThan(16 * MiB);
});
