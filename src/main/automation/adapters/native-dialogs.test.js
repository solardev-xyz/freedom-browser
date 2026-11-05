'use strict';
const { EventEmitter } = require('events');
const { NativeDialogs } = require('./native-dialogs');

function fixture() {
  const api = new EventEmitter();
  let attached = false;
  api.isAttached = () => attached;
  api.attach = jest.fn(() => {
    attached = true;
  });
  api.detach = jest.fn(() => {
    attached = false;
    api.emit('detach');
  });
  api.sendCommand = jest.fn(async () => ({}));
  const mainFrame = {
    url: 'https://site.test/',
    origin: 'https://site.test',
    processId: 1,
    frameToken: 'doc',
  };
  mainFrame.framesInSubtree = [mainFrame];
  const dialogs = new NativeDialogs({ debugger: api, mainFrame });
  const open = (extra = {}) =>
    api.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'confirm',
      url: 'https://site.test/',
      message: 'Proceed?',
      ...extra,
    });
  const input = (extra = {}) => ({
    dialogRef: dialogs.current().dialogRef,
    accept: false,
    ...extra,
  });
  const authorize = (action) => ({
    expectedDialog: JSON.stringify({
      ...dialogs.current(),
      accept: action.accept,
      promptText: action.promptText,
    }),
  });
  return { api, dialogs, open, input, authorize, mainFrame };
}

test('owns only its debugger and never takes an existing connection', async () => {
  const f = fixture();
  f.api.attach();
  await expect(f.dialogs.start()).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
  f.dialogs.dispose();
  expect(f.api.detach).not.toHaveBeenCalled();
});

test('reads bounded untrusted dialog data and requires exact response authorization', async () => {
  const f = fixture();
  await f.dialogs.start();
  f.open({ message: 'x'.repeat(3000) });
  expect(f.dialogs.current()).toMatchObject({ messageTruncated: true, untrusted: true });
  expect(f.dialogs.current().message.length).toBe(2000);
  const action = f.input();
  await expect(f.dialogs.respond(action, {})).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  const auth = f.authorize(action);
  await expect(f.dialogs.respond({ ...action, accept: true }, auth)).rejects.toMatchObject({
    code: 'POLICY_DENIED',
  });
  await expect(f.dialogs.respond(action, auth)).resolves.toMatchObject({
    handled: true,
    accepted: false,
  });
  expect(f.api.sendCommand).toHaveBeenLastCalledWith('Page.handleJavaScriptDialog', {
    accept: false,
  });
  f.dialogs.dispose();
});

test.each(['navigation', 'closed', 'replacement', 'stop', 'detach'])(
  '%s invalidates pending response authorization',
  async (change) => {
    const f = fixture();
    await f.dialogs.start();
    f.open();
    const action = f.input();
    const auth = f.authorize(action);
    if (change === 'navigation')
      f.api.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'root' } });
    if (change === 'closed') f.api.emit('message', {}, 'Page.javascriptDialogClosed', {});
    if (change === 'replacement') f.open();
    if (change === 'stop') f.dialogs.stop();
    if (change === 'detach') f.api.detach();
    await expect(f.dialogs.respond(action, auth)).rejects.toMatchObject({
      code: 'STALE_ELEMENT_REFERENCE',
    });
    expect(
      f.api.sendCommand.mock.calls.some(([method]) => method === 'Page.handleJavaScriptDialog')
    ).toBe(false);
    f.dialogs.dispose();
  }
);

test('prompt acceptance requires explicit text; dismissal never submits text', async () => {
  const f = fixture();
  await f.dialogs.start();
  f.open({ type: 'prompt' });
  expect(() => f.dialogs.inspect(f.input({ accept: true }))).toThrow('explicit promptText');
  expect(() => f.dialogs.inspect(f.input({ promptText: 'secret' }))).toThrow('accepting a prompt');
  const action = f.input({ accept: true, promptText: '' });
  await f.dialogs.respond(action, f.authorize(action));
  expect(f.api.sendCommand).toHaveBeenLastCalledWith('Page.handleJavaScriptDialog', {
    accept: true,
    promptText: '',
  });
  f.dialogs.dispose();
});

test('a dialog interrupts blocked renderer execution without responding or retrying', async () => {
  const f = fixture();
  await f.dialogs.start();
  const task = jest.fn(() => new Promise(() => {}));
  const result = f.dialogs.guard(task);
  f.open();
  await expect(result).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE', retryable: false });
  expect(task).toHaveBeenCalledTimes(1);
  expect(f.dialogs.listenerCount('opened')).toBe(0);
  f.dialogs.dispose();
});

test.each(['opaque', 'ambiguous', 'embedded', 'replacement'])(
  'rejects %s dialog source before exposing content or responding',
  async (kind) => {
    const f = fixture();
    await f.dialogs.start();
    f.open();
    const action = f.input();
    const auth = f.authorize(action);
    if (kind === 'opaque') f.mainFrame.origin = 'null';
    if (kind === 'ambiguous') f.mainFrame.framesInSubtree.push({ url: f.mainFrame.url });
    if (kind === 'embedded') f.open({ url: 'https://child.test/' });
    if (kind === 'replacement') f.mainFrame.frameToken = 'new-document';
    expect(() => f.dialogs.current()).toThrow('unique top-level document');
    await expect(f.dialogs.respond(action, auth)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    });
    expect(
      f.api.sendCommand.mock.calls.some(([method]) => method === 'Page.handleJavaScriptDialog')
    ).toBe(false);
    f.dialogs.dispose();
  }
);
