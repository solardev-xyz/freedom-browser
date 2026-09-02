'use strict';

const { createConversationAttachmentTools, safeAttachmentError } = require('./pi-attachment-tools');

function createSdk() {
  return {
    createAgentSession: jest.fn(),
    createBashTool: jest.fn(),
    createEditTool: jest.fn(),
    createExtensionRuntime: jest.fn(),
    createReadTool: jest.fn(),
    createWriteTool: jest.fn(),
    defineTool: jest.fn((tool) => tool),
    ModelRuntime: jest.fn(),
    SessionManager: jest.fn(),
    SettingsManager: jest.fn(),
  };
}

describe('Pi attachment tools', () => {
  test('keeps safe PDF failures actionable without exposing local parser details', () => {
    const range = Object.assign(new Error('The PDF has 2 pages; page 3 is out of range'), {
      code: 'PDF_PAGE_OUT_OF_RANGE',
    });
    expect(safeAttachmentError(range).message).toBe(
      'The PDF has 2 pages; page 3 is out of range'
    );
    const malformed = Object.assign(new Error('/private/report.pdf failed'), {
      code: 'PDF_INVALID',
    });
    expect(safeAttachmentError(malformed).message).toBe('The attached PDF is malformed or invalid');
  });

  test('lists only safe conversation resources and bounded folder entries', async () => {
    const store = {
      listResources: jest.fn(async () => [
        { resourceId: 'attachment_a', kind: 'file', name: 'notes.txt', available: true },
        { resourceId: 'folder_a', kind: 'folder', name: 'Project', available: true },
      ]),
      listFolder: jest.fn(async () => ({
        entries: [{ name: 'README.md', kind: 'file' }],
        offset: 0,
        truncated: false,
      })),
      read: jest.fn(),
      renderPdfPage: jest.fn(),
    };
    const tools = await createConversationAttachmentTools({
      sdk: createSdk(),
      store,
      conversationId: 'conversation_test',
      visionEnabled: true,
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      'attachment_list',
      'attachment_read',
      'attachment_render_page',
    ]);
    const list = tools[0];
    await list.execute('call_1', {});
    expect(store.listResources).toHaveBeenCalledWith('conversation_test');
    const folderResult = await list.execute('call_2', {
      resourceId: 'folder_a',
      path: 'src',
    });
    expect(store.listFolder).toHaveBeenCalledWith('conversation_test', 'folder_a', 'src', 0);
    expect(folderResult.details).toEqual({
      resourceId: 'folder_a',
      resourceKind: 'folder',
      folderName: 'Project',
      relativePath: 'src',
      entryCount: 1,
      truncated: false,
    });
    expect(folderResult.content[0].text).toContain('README.md');
  });

  test('returns images only to vision models and never exposes storage paths', async () => {
    const store = {
      listResources: jest.fn(async () => [
        { resourceId: 'attachment_a', kind: 'file', name: 'photo.png', available: true },
      ]),
      listFolder: jest.fn(),
      read: jest.fn(async () => ({
        kind: 'image',
        name: 'photo.png',
        mimeType: 'image/png',
        bytes: 3,
        data: Buffer.from('png'),
        filePath: '/private/secret/photo.png',
      })),
      renderPdfPage: jest.fn(),
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
      listResources: jest.fn(async () => [
        { resourceId: 'attachment_a', kind: 'file', name: 'notes.txt', available: true },
      ]),
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
      renderPdfPage: jest.fn(),
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

  test('reads PDF text progressively and renders one page only for vision models', async () => {
    const store = {
      listResources: jest.fn(async () => [
        {
          resourceId: 'attachment_pdf',
          kind: 'file',
          name: 'report.pdf',
          category: 'pdf',
          available: true,
        },
      ]),
      listFolder: jest.fn(),
      read: jest.fn(async () => ({
        kind: 'pdf_text',
        name: 'report.pdf',
        bytes: 1200,
        pageCount: 12,
        pages: [
          { page: 3, text: 'Quarterly results' },
          { page: 4, text: '' },
        ],
        truncated: true,
      })),
      renderPdfPage: jest.fn(async () => ({
        kind: 'pdf_page',
        name: 'report.pdf',
        bytes: 1200,
        page: 4,
        pageCount: 12,
        width: 800,
        height: 1000,
        mimeType: 'image/png',
        data: Buffer.from('png'),
      })),
    };
    const tools = await createConversationAttachmentTools({
      sdk: createSdk(),
      store,
      conversationId: 'conversation_test',
      visionEnabled: true,
    });
    const read = tools.find((tool) => tool.name === 'attachment_read');
    const render = tools.find((tool) => tool.name === 'attachment_render_page');
    const signal = new AbortController().signal;
    const textResult = await read.execute(
      'call_pdf_text',
      { resourceId: 'attachment_pdf', page: 3, pageCount: 2 },
      signal
    );
    expect(store.read).toHaveBeenCalledWith(
      'conversation_test',
      'attachment_pdf',
      expect.objectContaining({ page: 3, pageCount: 2, signal })
    );
    expect(textResult.content[0].text).toContain('page 3 of 12');
    expect(textResult.content[0].text).toContain('no extractable text on this page');
    expect(textResult.details).toMatchObject({ page: 3, pagesRead: 2, pageCount: 12 });

    const imageResult = await render.execute(
      'call_pdf_page',
      { resourceId: 'attachment_pdf', page: 4 },
      signal
    );
    expect(store.renderPdfPage).toHaveBeenCalledWith(
      'conversation_test',
      'attachment_pdf',
      expect.objectContaining({ page: 4, signal })
    );
    expect(imageResult.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(imageResult.details).toMatchObject({
      page: 4,
      pagesRead: 1,
      pageCount: 12,
      width: 800,
      height: 1000,
    });

    const textOnlyTools = await createConversationAttachmentTools({
      sdk: createSdk(),
      store,
      conversationId: 'conversation_test',
      visionEnabled: false,
    });
    expect(textOnlyTools.map((tool) => tool.name)).not.toContain('attachment_render_page');
  });

  test('does not disclose filesystem paths through attachment read failures', async () => {
    const store = {
      listResources: jest.fn(async () => [
        { resourceId: 'folder_a', kind: 'folder', name: 'Project', available: true },
      ]),
      listFolder: jest.fn(async () => {
        const error = new Error(
          "ENOENT: no such file or directory, scandir '/Users/private/Documents'"
        );
        error.code = 'ENOENT';
        throw error;
      }),
      read: jest.fn(),
      renderPdfPage: jest.fn(),
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
