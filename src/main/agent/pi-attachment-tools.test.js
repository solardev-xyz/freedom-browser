'use strict';

const { createConversationAttachmentTools } = require('./pi-attachment-tools');

function createSdk() {
  return {
    createAgentSession: jest.fn(),
    createExtensionRuntime: jest.fn(),
    createReadTool: jest.fn(),
    defineTool: jest.fn((tool) => tool),
    ModelRuntime: jest.fn(),
    SessionManager: jest.fn(),
    SettingsManager: jest.fn(),
  };
}

describe('Pi attachment tools', () => {
  test('lists only safe conversation resources and bounded folder entries', async () => {
    const store = {
      listResources: jest.fn(async () => [
        { resourceId: 'attachment_a', kind: 'file', name: 'notes.txt', available: true },
      ]),
      listFolder: jest.fn(async () => ({
        entries: [{ name: 'README.md', kind: 'file' }],
        offset: 0,
        truncated: false,
      })),
      read: jest.fn(),
    };
    const tools = await createConversationAttachmentTools({
      sdk: createSdk(),
      store,
      conversationId: 'conversation_test',
      visionEnabled: true,
    });
    expect(tools.map((tool) => tool.name)).toEqual(['attachment_list', 'attachment_read']);
    const list = tools[0];
    await list.execute('call_1', {});
    expect(store.listResources).toHaveBeenCalledWith('conversation_test');
    const folderResult = await list.execute('call_2', {
      resourceId: 'folder_a',
      path: 'src',
    });
    expect(store.listFolder).toHaveBeenCalledWith('conversation_test', 'folder_a', 'src', 0);
    expect(folderResult.details.entries).toEqual([{ name: 'README.md', kind: 'file' }]);
  });

  test('returns images only to vision models and never exposes storage paths', async () => {
    const store = {
      listResources: jest.fn(),
      listFolder: jest.fn(),
      read: jest.fn(async () => ({
        kind: 'image',
        name: 'photo.png',
        mimeType: 'image/png',
        bytes: 3,
        data: Buffer.from('png'),
        filePath: '/private/secret/photo.png',
      })),
    };
    const [_, read] = await createConversationAttachmentTools({
      sdk: createSdk(),
      store,
      conversationId: 'conversation_test',
      visionEnabled: true,
    });
    const result = await read.execute('call_1', { resourceId: 'attachment_a' });
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(JSON.stringify(result.details)).not.toContain('/private/secret');

    const [, textOnlyRead] = await createConversationAttachmentTools({
      sdk: createSdk(),
      store,
      conversationId: 'conversation_test',
      visionEnabled: false,
    });
    await expect(
      textOnlyRead.execute('call_2', { resourceId: 'attachment_a' })
    ).rejects.toThrow('cannot inspect image');
  });

  test('returns bounded text metadata', async () => {
    const store = {
      listResources: jest.fn(),
      listFolder: jest.fn(),
      read: jest
        .fn()
        .mockResolvedValueOnce({
          kind: 'text',
          name: 'notes.txt',
          bytes: 50,
          offset: 10,
          text: 'hello',
          truncated: true,
        }),
    };
    const [, read] = await createConversationAttachmentTools({
      sdk: createSdk(),
      store,
      conversationId: 'conversation_test',
    });
    await expect(
      read.execute('call_1', { resourceId: 'attachment_a', offset: 10, limit: 5 })
    ).resolves.toMatchObject({
      content: [{ type: 'text', text: 'hello' }],
      details: { truncated: true, offset: 10 },
    });
  });

  test('does not disclose filesystem paths through attachment read failures', async () => {
    const store = {
      listResources: jest.fn(),
      listFolder: jest.fn(async () => {
        const error = new Error(
          "ENOENT: no such file or directory, scandir '/Users/private/Documents'"
        );
        error.code = 'ENOENT';
        throw error;
      }),
      read: jest.fn(),
    };
    const [list] = await createConversationAttachmentTools({
      sdk: createSdk(),
      store,
      conversationId: 'conversation_test',
    });

    await expect(
      list.execute('call_1', { resourceId: 'folder_a', path: 'missing' })
    ).rejects.toThrow('requested attachment path is unavailable');
    await expect(
      list.execute('call_1', { resourceId: 'folder_a', path: 'missing' })
    ).rejects.not.toThrow('/Users/private');
  });
});
