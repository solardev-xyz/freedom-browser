'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ATTACHMENTS_DIR,
  ConversationAttachmentStore,
  MAX_TEXT_READ_BYTES,
  fileClassification,
  pathInside,
} = require('./conversation-attachment-store');

describe('ConversationAttachmentStore', () => {
  let userDataDir;
  let sourceDir;

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-attachments-profile-'));
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-attachments-source-'));
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(sourceDir, { recursive: true, force: true });
  });

  function createStore(filePaths, pdfProcessor) {
    return new ConversationAttachmentStore({
      userDataDir,
      ...(pdfProcessor && { pdfProcessor }),
      dialog: {
        showOpenDialog: jest.fn(async () => ({ canceled: false, filePaths })),
      },
    });
  }

  test('snapshots selected text files without exposing their source path', async () => {
    const sourcePath = path.join(sourceDir, 'notes.txt');
    fs.writeFileSync(sourcePath, 'private notes for Agent');
    const store = createStore([sourcePath]);

    const staged = await store.pickFiles({ ownerId: 'window_1' });
    expect(staged).toEqual([
      expect.objectContaining({
        selectionId: expect.stringMatching(/^selection_[a-f0-9]{20}$/),
        kind: 'file',
        name: 'notes.txt',
        category: 'text',
      }),
    ]);
    expect(JSON.stringify(staged)).not.toContain(sourceDir);

    const resources = await store.consume(
      'window_1',
      [staged[0].selectionId],
      'conversation_aaaaaaaaaaaaaaaa'
    );
    const result = await store.read(
      'conversation_aaaaaaaaaaaaaaaa',
      resources[0].resourceId
    );
    expect(result).toMatchObject({ kind: 'text', text: 'private notes for Agent' });

    const manifestPath = path.join(
      userDataDir,
      ATTACHMENTS_DIR,
      'conversation_aaaaaaaaaaaaaaaa',
      'manifest.json'
    );
    expect(fs.readFileSync(manifestPath, 'utf8')).not.toContain(sourceDir);
  });

  test('refuses a selected file that changes before the message is sent', async () => {
    const sourcePath = path.join(sourceDir, 'notes.txt');
    fs.writeFileSync(sourcePath, 'first');
    const store = createStore([sourcePath]);
    const [selection] = await store.pickFiles({ ownerId: 'window_1' });
    fs.writeFileSync(sourcePath, 'different length');

    await expect(
      store.consume(
        'window_1',
        [selection.selectionId],
        'conversation_eeeeeeeeeeeeeeee'
      )
    ).rejects.toThrow('changed after it was selected');
  });

  test('snapshots PDFs and delegates bounded text extraction without exposing paths', async () => {
    const sourcePath = path.join(sourceDir, 'report.pdf');
    fs.writeFileSync(sourcePath, '%PDF-1.7');
    const pdfProcessor = {
      extractText: jest.fn(async () => ({
        kind: 'pdf_text',
        pageCount: 2,
        pages: [{ page: 1, text: 'Report heading' }],
        truncated: true,
      })),
      renderPage: jest.fn(),
    };
    const store = createStore([sourcePath], pdfProcessor);

    const [selection] = await store.pickFiles({ ownerId: 'window_1' });
    expect(selection).toMatchObject({ category: 'pdf', mimeType: 'application/pdf' });
    const [resource] = await store.consume(
      'window_1',
      [selection.selectionId],
      'conversation_1212121212121212'
    );
    await expect(
      store.read('conversation_1212121212121212', resource.resourceId, {
        page: 1,
        pageCount: 1,
      })
    ).resolves.toMatchObject({
      kind: 'pdf_text',
      name: 'report.pdf',
      pageCount: 2,
      pages: [{ page: 1, text: 'Report heading' }],
    });
    expect(pdfProcessor.extractText).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ page: 1, pageCount: 1 })
    );
    expect(JSON.stringify(resource)).not.toContain(sourceDir);
    const restored = createStore([]);
    await expect(restored.listResources('conversation_1212121212121212')).resolves.toEqual([
      expect.objectContaining({ name: 'report.pdf', category: 'pdf', available: true }),
    ]);
  });

  test('renders a requested PDF page from a live folder grant', async () => {
    const folderPath = path.join(sourceDir, 'reports');
    fs.mkdirSync(folderPath);
    fs.writeFileSync(path.join(folderPath, 'layout.pdf'), '%PDF-1.7');
    const pdfProcessor = {
      extractText: jest.fn(),
      renderPage: jest.fn(async () => ({
        kind: 'pdf_page',
        page: 2,
        pageCount: 3,
        width: 600,
        height: 800,
        mimeType: 'image/png',
        data: Buffer.from('png'),
      })),
    };
    const store = createStore([folderPath], pdfProcessor);
    const [selection] = await store.pickFolder({ ownerId: 'window_1' });
    const [folder] = await store.consume(
      'window_1',
      [selection.selectionId],
      'conversation_3434343434343434'
    );

    await expect(
      store.renderPdfPage('conversation_3434343434343434', folder.resourceId, {
        path: 'layout.pdf',
        page: 2,
      })
    ).resolves.toMatchObject({
      kind: 'pdf_page',
      name: 'layout.pdf',
      page: 2,
      pageCount: 3,
    });
    expect(pdfProcessor.renderPage).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ page: 2 })
    );
  });

  test('rejects a mixed file selection transactionally', async () => {
    const textPath = path.join(sourceDir, 'notes.txt');
    const unsupportedPath = path.join(sourceDir, 'program.exe');
    fs.writeFileSync(textPath, 'notes');
    fs.writeFileSync(unsupportedPath, 'binary');
    const store = createStore([textPath, unsupportedPath]);

    await expect(store.pickFiles({ ownerId: 'window_1' })).rejects.toThrow(
      'not a supported text, image, or PDF file'
    );
    expect(store.staged.size).toBe(0);
  });

  test('grants a live read-only folder while preventing path and symlink escape', async () => {
    fs.mkdirSync(path.join(sourceDir, 'project'));
    fs.writeFileSync(path.join(sourceDir, 'project', 'README.md'), '# Project');
    const outside = path.join(sourceDir, 'outside.txt');
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, path.join(sourceDir, 'project', 'escape.txt'));
    const store = createStore([path.join(sourceDir, 'project')]);

    const staged = await store.pickFolder({ ownerId: 'window_1' });
    const [folder] = await store.consume(
      'window_1',
      [staged[0].selectionId],
      'conversation_bbbbbbbbbbbbbbbb'
    );
    await expect(
      store.read('conversation_bbbbbbbbbbbbbbbb', folder.resourceId, { path: 'README.md' })
    ).resolves.toMatchObject({ kind: 'text', text: '# Project' });
    await expect(
      store.read('conversation_bbbbbbbbbbbbbbbb', folder.resourceId, { path: '../outside.txt' })
    ).rejects.toThrow('escapes its grant');
    await expect(
      store.read('conversation_bbbbbbbbbbbbbbbb', folder.resourceId, { path: 'escape.txt' })
    ).rejects.toThrow('escapes its grant');

    const publicationSource = await store.resolvePublicationSource(
      'conversation_bbbbbbbbbbbbbbbb',
      folder.resourceId
    );
    expect(publicationSource).toEqual({
      kind: 'folder',
      name: 'project',
      path: fs.realpathSync(path.join(sourceDir, 'project')),
    });
    expect(JSON.stringify(folder)).not.toContain(sourceDir);
  });

  test('restores file snapshots but requires folders to be explicitly re-added', async () => {
    const textPath = path.join(sourceDir, 'notes.md');
    const folderPath = path.join(sourceDir, 'project');
    fs.writeFileSync(textPath, 'hello');
    fs.mkdirSync(folderPath);
    const fileStore = createStore([textPath]);
    const [fileSelection] = await fileStore.pickFiles({ ownerId: 'window_1' });
    await fileStore.consume(
      'window_1',
      [fileSelection.selectionId],
      'conversation_cccccccccccccccc'
    );
    fileStore.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [folderPath] });
    const [folderSelection] = await fileStore.pickFolder({ ownerId: 'window_1' });
    await fileStore.consume(
      'window_1',
      [folderSelection.selectionId],
      'conversation_cccccccccccccccc'
    );

    const restored = createStore([]);
    const resources = await restored.listResources('conversation_cccccccccccccccc');
    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'file', available: true }),
        expect.objectContaining({ kind: 'folder', available: false }),
      ])
    );
  });

  test('revokes a live folder grant and removes it from the persisted manifest', async () => {
    const folderPath = path.join(sourceDir, 'project');
    fs.mkdirSync(folderPath);
    fs.writeFileSync(path.join(folderPath, 'README.md'), '# Private project');
    const store = createStore([folderPath]);
    const [selection] = await store.pickFolder({ ownerId: 'window_1' });
    const [folder] = await store.consume(
      'window_1',
      [selection.selectionId],
      'conversation_ffffffffffffffff'
    );

    await expect(
      store.revokeFolder('conversation_ffffffffffffffff', folder.resourceId)
    ).resolves.toBe(true);
    await expect(
      store.read('conversation_ffffffffffffffff', folder.resourceId, { path: 'README.md' })
    ).rejects.toThrow('not found');
    await expect(store.listResources('conversation_ffffffffffffffff')).resolves.toEqual([]);

    const manifest = fs.readFileSync(
      path.join(
        userDataDir,
        ATTACHMENTS_DIR,
        'conversation_ffffffffffffffff',
        'manifest.json'
      ),
      'utf8'
    );
    expect(manifest).not.toContain(folder.resourceId);
    expect(manifest).not.toContain(folderPath);
  });

  test('bounds text reads and recognizes only declared attachment formats', async () => {
    expect(fileClassification('/tmp/a.png')).toMatchObject({ category: 'image' });
    expect(fileClassification('/tmp/a.pdf')).toMatchObject({ category: 'pdf' });
    expect(fileClassification('/tmp/a.exe')).toMatchObject({ category: 'unsupported' });
    expect(pathInside('/safe/root', '/safe/root/file')).toBe(true);
    expect(pathInside('/safe/root', '/safe/other')).toBe(false);

    const largePath = path.join(sourceDir, 'large.txt');
    fs.writeFileSync(largePath, 'a'.repeat(MAX_TEXT_READ_BYTES + 50));
    const store = createStore([largePath]);
    const [selection] = await store.pickFiles({ ownerId: 'window_1' });
    const [resource] = await store.consume(
      'window_1',
      [selection.selectionId],
      'conversation_dddddddddddddddd'
    );
    const result = await store.read('conversation_dddddddddddddddd', resource.resourceId);
    expect(result.text).toHaveLength(MAX_TEXT_READ_BYTES);
    expect(result.truncated).toBe(true);
  });
});
