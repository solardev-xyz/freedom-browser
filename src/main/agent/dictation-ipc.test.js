const { registerDictationIpc } = require('./dictation-ipc');
const IPC = require('../../shared/ipc-channels');

test('dictation IPC keeps microphone/audio authority out of Settings and untrusted pages', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: jest.fn() };
  const service = { state: jest.fn(() => ({ options: [] })), begin: jest.fn(() => ({ id: 'test' })),
    choose: jest.fn(), install: jest.fn(), cancel: jest.fn(), transcribe: jest.fn(), append: jest.fn(), finish: jest.fn(), cancelAll: jest.fn() };
  let enabled = true;
  const dispose = registerDictationIpc({ ipcMain, service, isEnabled: () => enabled,
    isTrustedSender: sender => sender === 'chrome', isSettingsSender: event => event.sender === 'settings' });
  const call = (channel, sender, payload) => handlers.get(channel)({ sender }, payload);
  expect(await call(IPC.AGENT_DICTATION_STATE, 'page')).toMatchObject({ ok: false });
  expect(await call(IPC.AGENT_DICTATION_BEGIN, 'settings')).toMatchObject({ ok: false });
  expect(handlers.has('agent:dictation:transcribe')).toBe(false);
  expect(await call(IPC.AGENT_DICTATION_APPEND, 'settings')).toMatchObject({ ok: false });
  expect(await call(IPC.AGENT_DICTATION_FINISH, 'settings')).toMatchObject({ ok: false });
  expect(await call(IPC.AGENT_DICTATION_APPEND, 'page')).toMatchObject({ ok: false });
  expect(await call(IPC.AGENT_DICTATION_STATE, 'settings')).toMatchObject({ ok: true });
  expect(await call(IPC.AGENT_DICTATION_BEGIN, 'chrome')).toMatchObject({ ok: true, id: 'test' });
  enabled = false;
  expect(await call(IPC.AGENT_DICTATION_BEGIN, 'chrome')).toMatchObject({ ok: false, error: { code: 'AGENT_DISABLED' } });
  expect(await call(IPC.AGENT_DICTATION_CANCEL, 'chrome')).toMatchObject({ ok: true });
  service.state.mockImplementation(() => { throw new Error('secret upstream data'); }); enabled = true;
  expect(JSON.stringify(await call(IPC.AGENT_DICTATION_STATE, 'settings'))).not.toContain('secret');
  await dispose(); expect(service.cancelAll).toHaveBeenCalled(); expect(ipcMain.removeHandler).toHaveBeenCalledTimes(7);
});
