'use strict';

const { recoveryForToolError, withToolErrorRecovery } = require('./tool-error-recovery');
const { trustBuiltInToolOverride, isTrustedBuiltInToolOverride } = require('./pi-trusted-tools');

describe('model-facing tool error recovery', () => {
  test.each([
    ['PROJECT_READ_ONLY', 'workspace_history', 'request_permission', 'request_permissions'],
    ['WORKSPACE_COMMAND_NOT_FOUND', 'bash', 'request_permission', 'request_permissions'],
    ['WORKSPACE_HISTORY_CHANGED', 'edit', 'refresh_state', 'read'],
    ['STALE_ELEMENT_REFERENCE', 'browser_click', 'refresh_state', 'browser_snapshot'],
    ['TAB_NOT_FOUND', 'browser_get_tab', 'refresh_state', 'browser_list_tabs'],
    ['WORKSPACE_HISTORY_UNAVAILABLE', 'workspace_history', 'inspect_outcome', 'workspace_history'],
    ['INTERNAL_ERROR', 'browser_call_page_tool', 'inspect_outcome', 'browser_list_page_tools'],
    ['ENOENT', 'attachment_read', 'refresh_state', 'attachment_list'],
    ['INVALID_ARGUMENT', 'browser_click', 'correct_input'],
    ['CAPABILITY_UNAVAILABLE', 'browser_screenshot', 'unsupported'],
    ['POLICY_DENIED', 'browser_navigate', 'stop'],
    ['PROJECT_WRITE_DECLINED', 'request_permissions', 'stop'],
    ['USER_CANCELLED', 'browser_call_page_tool', 'stop'],
    ['ABORT_ERR', 'attachment_render_page', 'stop'],
    ['UNKNOWN_ERROR', 'future_tool', 'inspect_outcome'],
  ])('%s provides a concrete %s recovery without executing it', async (code, name, action, tool = null) => {
    const execute = jest.fn(async () => { throw Object.assign(new Error('Safe explanation'), { code }); });
    const wrapped = withToolErrorRecovery({ name, execute });
    let error;
    try { await wrapped.execute('call', {}); } catch (failure) { error = failure; }
    expect(error).toMatchObject({ code, recovery: { action, ...(tool && { tool }) } });
    const json = JSON.parse(error.message.split('\nRecovery: ')[1]);
    expect(json).toEqual(error.recovery);
    expect(json.instruction.length).toBeGreaterThan(30);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('keeps success, cancellation signals and trusted built-in status intact', async () => {
    const result = { content: [{ type: 'text', text: 'ok' }] };
    const original = trustBuiltInToolOverride({ name: 'read', execute: jest.fn(async () => result) });
    const wrapped = withToolErrorRecovery(original);
    const signal = new AbortController().signal;
    expect(await wrapped.execute('id', { path: 'file' }, signal)).toBe(result);
    expect(original.execute).toHaveBeenCalledWith('id', { path: 'file' }, signal);
    expect(isTrustedBuiltInToolOverride(wrapped)).toBe(true);
    expect(withToolErrorRecovery(wrapped)).toBe(wrapped);
    expect(isTrustedBuiltInToolOverride(withToolErrorRecovery({ name: 'read', execute() {} }))).toBe(false);
  });

  test('never upgrades a declined action into permission recovery', () => {
    expect(recoveryForToolError('COMMAND_PERMISSION_DECLINED', 'request_permissions')).toMatchObject({ action: 'stop' });
    expect(recoveryForToolError('PROJECT_READ_ONLY', 'workspace_history')).toMatchObject({ arguments: { project: 'write' } });
  });

  test('keeps specialized controller guidance visible in the model error text', async () => {
    const tool = withToolErrorRecovery({ name: 'browser_read_frame', execute: async () => {
      throw Object.assign(new Error('The frame changed'), { code: 'STALE_ELEMENT_REFERENCE', suggestedAction: 'List frames again before reading the replacement document' });
    } });
    await expect(tool.execute()).rejects.toThrow('List frames again before reading the replacement document');
  });
});
