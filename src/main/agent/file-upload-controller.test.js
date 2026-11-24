'use strict';

const { createAgentFileUploadController } = require('./file-upload-controller');
const { ERROR_CODES } = require('../automation/contract/errors');

describe('Agent file upload controller', () => {
  test('keeps the selected path inside main and returns only safe metadata', async () => {
    const ownerWindow = {};
    const dialog = {
      showOpenDialog: jest.fn(async () => ({
        canceled: false,
        filePaths: ['/Users/private/Documents/résumé.pdf'],
      })),
    };
    const pageAdapter = {
      webContents: {},
      upload: jest.fn(async () => ({ attached: true, mimeType: 'application/pdf' })),
    };
    const controller = createAgentFileUploadController({
      dialog,
      getOwnerWindow: () => ownerWindow,
      lstat: jest.fn(async () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 4096,
      })),
    });

    const result = await controller.upload({ pageAdapter, ref: 'ref_upload' });

    expect(dialog.showOpenDialog).toHaveBeenCalledWith(
      ownerWindow,
      expect.objectContaining({ properties: ['openFile'] })
    );
    expect(pageAdapter.upload).toHaveBeenCalledWith(
      'ref_upload',
      '/Users/private/Documents/résumé.pdf'
    );
    expect(result).toEqual({
      attached: true,
      ref: 'ref_upload',
      upload: {
        filename: 'résumé.pdf',
        bytes: 4096,
        mimeType: 'application/pdf',
        state: 'attached',
      },
    });
    expect(JSON.stringify(result)).not.toContain('/Users/private');
  });

  test('reports native-picker cancellation as a user decision', async () => {
    const controller = createAgentFileUploadController({
      dialog: { showOpenDialog: jest.fn(async () => ({ canceled: true, filePaths: [] })) },
    });

    await expect(
      controller.upload({ pageAdapter: { webContents: {}, upload: jest.fn() }, ref: 'ref_upload' })
    ).rejects.toMatchObject({ code: ERROR_CODES.FILE_UPLOAD_CANCELLED_BY_USER });
  });
});
