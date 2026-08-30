'use strict';

const { loadPiSdk, validatePiSdk } = require('./pi-sdk');

const EMPTY_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {},
  additionalProperties: false,
});

function safeAttachmentError(error) {
  if (typeof error?.code === 'string') {
    if (error.code === 'ENOENT') return new Error('The requested attachment path is unavailable');
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return new Error('The requested attachment is not readable');
    }
    return new Error('The attachment could not be read safely');
  }
  const message = typeof error?.message === 'string' ? error.message : '';
  if (message && !message.includes('/') && !message.includes('\\')) {
    return new Error(message.slice(0, 240));
  }
  return new Error('The attachment could not be read safely');
}

async function createConversationAttachmentTools(options = {}) {
  if (!options.store || typeof options.store.listResources !== 'function') {
    throw new TypeError('Attachment tools require a conversation attachment store');
  }
  if (typeof options.conversationId !== 'string' || !options.conversationId) {
    throw new TypeError('Attachment tools require a conversation ID');
  }
  const sdk = validatePiSdk(options.sdk || (await loadPiSdk()));
  const list = sdk.defineTool({
    name: 'attachment_list',
    label: 'List attachments',
    description:
      'List files and read-only folders explicitly shared with this conversation. Pass a folder resource ID to list one directory inside that grant. Local filesystem paths are never exposed.',
    parameters: {
      type: 'object',
      properties: {
        resourceId: { type: 'string' },
        path: { type: 'string' },
        offset: { type: 'integer', minimum: 0, maximum: 10000 },
      },
      additionalProperties: false,
    },
    executionMode: 'sequential',
    execute: async (_toolCallId, params = {}) => {
      try {
        const resources = await options.store.listResources(options.conversationId);
        let value;
        let details;
        if (params.resourceId) {
          const resource = resources.find((item) => item.resourceId === params.resourceId);
          const listing = await options.store.listFolder(
            options.conversationId,
            params.resourceId,
            params.path || '',
            params.offset || 0
          );
          value = {
            resourceId: params.resourceId,
            name: resource?.name || 'Attached folder',
            path: params.path || '',
            ...listing,
          };
          details = {
            resourceId: params.resourceId,
            resourceKind: 'folder',
            folderName: resource?.name || 'Attached folder',
            relativePath: params.path || '',
            entryCount: listing.entries.length,
            truncated: listing.truncated === true,
          };
        } else {
          value = { resources };
          details = { resourceCount: resources.length, truncated: false };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          details,
        };
      } catch (error) {
        throw safeAttachmentError(error);
      }
    },
  });
  const read = sdk.defineTool({
    name: 'attachment_read',
    label: 'Read attachment',
    description:
      'Read a bounded section of an attached text file or a file within a shared read-only folder. Images are returned visually when the selected model supports vision. Use relative paths only for folder resources.',
    parameters: {
      type: 'object',
      properties: {
        resourceId: { type: 'string', minLength: 1 },
        path: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 },
      },
      required: ['resourceId'],
      additionalProperties: false,
    },
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      try {
        const resource = (await options.store.listResources(options.conversationId)).find(
          (item) => item.resourceId === params.resourceId
        );
        const result = await options.store.read(options.conversationId, params.resourceId, params);
        if (result.kind === 'image') {
          if (options.visionEnabled !== true) {
            throw new Error('The selected model cannot inspect image attachments');
          }
          return {
            content: [
              { type: 'text', text: `Attached image: ${result.name}` },
              { type: 'image', data: result.data.toString('base64'), mimeType: result.mimeType },
            ],
            details: {
              resourceId: params.resourceId,
              resourceKind: resource?.kind || 'file',
              name: result.name,
              ...(resource?.kind === 'folder' && {
                folderName: resource.name,
                relativePath: params.path,
              }),
              bytesRead: result.bytes,
              offset: 0,
              truncated: false,
            },
          };
        }
        const details = {
          resourceId: params.resourceId,
          resourceKind: resource?.kind || 'file',
          name: result.name,
          ...(resource?.kind === 'folder' && {
            folderName: resource.name,
            relativePath: params.path,
          }),
          bytesRead: Buffer.byteLength(result.text || '', 'utf8'),
          offset: result.offset,
          truncated: result.truncated,
        };
        return {
          content: [{ type: 'text', text: result.text || '(empty file)' }],
          details,
        };
      } catch (error) {
        throw safeAttachmentError(error);
      }
    },
  });
  return [list, read];
}

module.exports = { EMPTY_PARAMETERS, createConversationAttachmentTools, safeAttachmentError };
