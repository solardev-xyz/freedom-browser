'use strict';

const IPC = require('../../shared/ipc-channels');

function registerDictationIpc({ ipcMain, service, isTrustedSender, isSettingsSender, isEnabled }) {
  const inFlight = new Set();
  const registrations = new Map([
    [IPC.AGENT_DICTATION_STATE, (_event, _payload) => service.state()],
    [IPC.AGENT_DICTATION_CHOOSE, (_event, payload) => service.choose(payload)],
    [IPC.AGENT_DICTATION_INSTALL, event => service.install(event.sender)],
    [IPC.AGENT_DICTATION_BEGIN, event => service.begin(event.sender)],
    [IPC.AGENT_DICTATION_APPEND, (event, payload) => service.append(event.sender, payload)],
    [IPC.AGENT_DICTATION_FINISH, (event, payload) => service.finish(event.sender, payload)],
    [IPC.AGENT_DICTATION_CANCEL, event => { service.cancel(event.sender); return {}; }],
  ]);
  const settingsChannels = new Set([IPC.AGENT_DICTATION_STATE, IPC.AGENT_DICTATION_CHOOSE, IPC.AGENT_DICTATION_INSTALL, IPC.AGENT_DICTATION_CANCEL]);
  for (const [channel, handler] of registrations) {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrustedSender(event.sender) && !(settingsChannels.has(channel) && isSettingsSender(event)))
        return { ok: false, error: { code: 'AGENT_NOT_OWNER', message: 'Dictation requires trusted browser chrome.' } };
      if (!isEnabled() && channel !== IPC.AGENT_DICTATION_CANCEL)
        return { ok: false, error: { code: 'AGENT_DISABLED', message: 'Enable AI features in Settings → AI to use dictation.' } };
      let operation;
      try {
        operation = Promise.resolve(handler(event, payload));
        inFlight.add(operation);
        return { ok: true, ...await operation };
      }
      catch (error) {
        return { ok: false, error: { code: error?.code?.startsWith('DICTATION_') ? error.code : 'DICTATION_FAILED',
          message: error?.code?.startsWith('DICTATION_') ? error.message : 'Dictation did not complete. Check your connection and try again.' } };
      }
      finally { inFlight.delete(operation); }
    });
  }
  return async () => {
    service.cancelAll();
    for (const channel of registrations.keys()) ipcMain.removeHandler(channel);
    await Promise.allSettled([...inFlight]);
    await service.drain?.();
  };
}

module.exports = { registerDictationIpc };
