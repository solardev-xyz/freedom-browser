const fs = require('fs');
const path = require('path');
const { applyThreadpoolSize, DEFAULT_THREADPOOL_SIZE } = require('./uv-threadpool');

describe('applyThreadpoolSize', () => {
  test('raises an unset pool above libuv’s default of four', () => {
    const env = {};
    expect(applyThreadpoolSize(env)).toBe('16');
    expect(env.UV_THREADPOOL_SIZE).toBe(String(DEFAULT_THREADPOOL_SIZE));
    expect(DEFAULT_THREADPOOL_SIZE).toBeGreaterThan(4);
  });

  test.each(['', '   '])('treats a blank value (%j) as unset', (value) => {
    const env = { UV_THREADPOOL_SIZE: value };
    expect(applyThreadpoolSize(env)).toBe('16');
  });

  test('leaves an explicit value alone', () => {
    const env = { UV_THREADPOOL_SIZE: '4' };
    expect(applyThreadpoolSize(env)).toBe('4');
    expect(env.UV_THREADPOOL_SIZE).toBe('4');
  });

  // libuv reads the variable once, when the pool first runs work, so the
  // call has to precede every require in main's entry point.
  test('is the first statement of the main-process entry point', () => {
    const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('//'));
    expect(code[0]).toBe("require('./uv-threadpool').applyThreadpoolSize();");
  });
});

// The two other "first in index.js" guards (ipc-sender-policy.test.js,
// remote-debugging-gate.test.js) let this module ahead of them on the
// grounds that it pulls in nothing that could register a handler or touch
// Chromium's switches.
test('requires no other module', () => {
  const source = fs.readFileSync(path.join(__dirname, 'uv-threadpool.js'), 'utf8');
  expect(source).not.toMatch(/\brequire\s*\(|\bimport\b/);
});
