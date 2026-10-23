'use strict';

const path = require('path');
const fs = require('fs');
const { AutomationError, ERROR_CODES } = require('../automation/contract/errors');

function cancellationError() {
  return new AutomationError(
    ERROR_CODES.FILE_UPLOAD_CANCELLED_BY_USER,
    'The user cancelled file selection'
  );
}

function safeMetadataString(value, maxLength) {
  const normalized = String(value || '');
  // eslint-disable-next-line no-control-regex
  const controlCharacters = /[\u0000-\u001f\u007f]/g;
  return normalized.replace(controlCharacters, '').slice(0, maxLength);
}

function createAgentFileUploadController(options = {}) {
  if (!options.dialog || typeof options.dialog.showOpenDialog !== 'function') {
    throw new TypeError('Agent file uploads require an Electron dialog');
  }
  const lstat = options.lstat || fs.promises.lstat;
  const getOwnerWindow =
    options.getOwnerWindow || ((webContents) => webContents.getOwnerBrowserWindow?.());

  return Object.freeze({
    async upload({ pageAdapter, ref, signal } = {}) {
      if (!pageAdapter || typeof pageAdapter.upload !== 'function') {
        throw new AutomationError(
          ERROR_CODES.CAPABILITY_UNAVAILABLE,
          'File attachment is unavailable for this page'
        );
      }
      if (signal?.aborted) throw cancellationError();
      const ownerWindow = getOwnerWindow(pageAdapter.webContents);
      const pickerOptions = {
        title: 'Choose a file for Agent to share',
        buttonLabel: 'Choose',
        properties: ['openFile'],
      };
      const selection = ownerWindow
        ? await options.dialog.showOpenDialog(ownerWindow, pickerOptions)
        : await options.dialog.showOpenDialog(pickerOptions);
      if (signal?.aborted || selection?.canceled || !selection?.filePaths?.[0]) {
        throw cancellationError();
      }
      const filePath = selection.filePaths[0];
      let fileState;
      try {
        fileState = await lstat(filePath);
      } catch (error) {
        throw new AutomationError(
          ERROR_CODES.CAPABILITY_UNAVAILABLE,
          'The selected file is no longer available',
          { cause: error }
        );
      }
      if (!fileState.isFile() || fileState.isSymbolicLink()) {
        throw new AutomationError(
          ERROR_CODES.POLICY_DENIED,
          'Freedom only attaches a directly selected regular file'
        );
      }
      const attached = await pageAdapter.upload(ref, filePath);
      if (attached?.attached !== true) {
        throw new AutomationError(
          ERROR_CODES.INTERNAL_ERROR,
          'Freedom could not confirm that the selected file was attached'
        );
      }
      const filename = safeMetadataString(path.basename(filePath), 255);
      if (!filename) {
        throw new AutomationError(
          ERROR_CODES.POLICY_DENIED,
          'The selected file does not have a usable filename'
        );
      }
      return {
        attached: true,
        ref,
        upload: {
          filename,
          bytes: Number.isSafeInteger(fileState.size) && fileState.size >= 0 ? fileState.size : 0,
          ...(safeMetadataString(attached?.mimeType, 200)
            ? { mimeType: safeMetadataString(attached.mimeType, 200) }
            : {}),
          state: 'attached',
        },
      };
    },
  });
}

module.exports = { createAgentFileUploadController };
