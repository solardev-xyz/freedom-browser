'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ATTACHMENTS_DIR = 'agent-attachments';
const MANIFEST_FILE = 'manifest.json';
const MAX_SELECTIONS = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_READ_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FOLDER_ENTRIES = 200;
const SAFE_READ_FLAGS =
  fs.constants.O_RDONLY |
  (fs.constants.O_NOFOLLOW || 0) |
  (fs.constants.O_NONBLOCK || 0);

const IMAGE_MIME_TYPES = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
});
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.conf', '.cpp', '.css', '.csv', '.env', '.go', '.graphql', '.h', '.hpp',
  '.html', '.ini', '.java', '.js', '.json', '.jsx', '.log', '.md', '.mjs', '.py', '.rb',
  '.rs', '.sh', '.sql', '.svg', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
]);

function opaqueId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

function cleanName(value) {
  // eslint-disable-next-line no-control-regex
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240) || 'Untitled';
}

function fileClassification(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (IMAGE_MIME_TYPES[extension]) {
    return { category: 'image', mimeType: IMAGE_MIME_TYPES[extension] };
  }
  if (extension === '.pdf') {
    return { category: 'pdf_unsupported', mimeType: 'application/pdf' };
  }
  if (TEXT_EXTENSIONS.has(extension)) return { category: 'text', mimeType: 'text/plain' };
  return { category: 'unsupported', mimeType: 'application/octet-stream' };
}

function publicResource(resource) {
  return {
    resourceId: resource.resourceId,
    kind: resource.kind,
    name: resource.name,
    ...(Number.isSafeInteger(resource.bytes) && { bytes: resource.bytes }),
    ...(resource.mimeType && { mimeType: resource.mimeType }),
    ...(resource.category && { category: resource.category }),
    available: resource.available !== false,
  };
}

function pathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

class ConversationAttachmentStore {
  constructor(options = {}) {
    if (typeof options.userDataDir !== 'string' || !options.userDataDir) {
      throw new TypeError('Conversation attachments require a profile userDataDir');
    }
    if (!options.dialog || typeof options.dialog.showOpenDialog !== 'function') {
      throw new TypeError('Conversation attachments require an Electron dialog');
    }
    this.rootDir = path.join(options.userDataDir, ATTACHMENTS_DIR);
    this.dialog = options.dialog;
    this.fs = options.fs || fs.promises;
    this.staged = new Map();
    this.resources = new Map();
  }

  async pickFiles({ ownerId, ownerWindow } = {}) {
    const selection = ownerWindow
      ? await this.dialog.showOpenDialog(ownerWindow, {
          title: 'Attach files to Agent',
          buttonLabel: 'Attach',
          properties: ['openFile', 'multiSelections'],
        })
      : await this.dialog.showOpenDialog({
          title: 'Attach files to Agent',
          buttonLabel: 'Attach',
          properties: ['openFile', 'multiSelections'],
        });
    if (selection?.canceled || !Array.isArray(selection?.filePaths) || !selection.filePaths.length) {
      return [];
    }
    if (selection.filePaths.length > MAX_SELECTIONS) {
      throw new Error(`Attach at most ${MAX_SELECTIONS} files at once`);
    }
    const ownerKey = String(ownerId);
    const pending = this.staged.get(ownerKey) || new Map();
    if (pending.size + selection.filePaths.length > MAX_SELECTIONS) {
      throw new Error(`Attach at most ${MAX_SELECTIONS} files and folders per message`);
    }
    const stagedResources = [];
    let selectedBytes = [...pending.values()].reduce((total, item) => total + (item.bytes || 0), 0);
    for (const filePath of selection.filePaths) {
      const stat = await this.fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Only regular files can be attached');
      if (stat.size > MAX_FILE_BYTES) throw new Error(`${path.basename(filePath)} is larger than 20 MB`);
      selectedBytes += stat.size;
      if (selectedBytes > MAX_TOTAL_BYTES) throw new Error('Attachments cannot exceed 50 MB total');
      const classification = fileClassification(filePath);
      if (classification.category === 'pdf_unsupported') {
        throw new Error('PDF attachments are not supported yet; attach text or images instead');
      }
      if (classification.category === 'unsupported') {
        throw new Error(`${path.basename(filePath)} is not a supported text or image file`);
      }
      const resource = {
        selectionId: opaqueId('selection'),
        kind: 'file',
        sourcePath: await this.fs.realpath(filePath),
        name: cleanName(path.basename(filePath)),
        bytes: stat.size,
        ...classification,
      };
      stagedResources.push(resource);
    }
    for (const resource of stagedResources) {
      pending.set(resource.selectionId, resource);
    }
    this.staged.set(ownerKey, pending);
    return stagedResources.map((resource) => ({
      selectionId: resource.selectionId,
      ...publicResource(resource),
    }));
  }

  async pickFolder({ ownerId, ownerWindow } = {}) {
    const selection = ownerWindow
      ? await this.dialog.showOpenDialog(ownerWindow, {
          title: 'Give Agent read-only folder access',
          buttonLabel: 'Add folder',
          properties: ['openDirectory'],
        })
      : await this.dialog.showOpenDialog({
          title: 'Give Agent read-only folder access',
          buttonLabel: 'Add folder',
          properties: ['openDirectory'],
        });
    const folderPath = selection?.filePaths?.[0];
    if (selection?.canceled || !folderPath) return [];
    const ownerKey = String(ownerId);
    const pending = this.staged.get(ownerKey) || new Map();
    if (pending.size >= MAX_SELECTIONS) {
      throw new Error(`Attach at most ${MAX_SELECTIONS} files and folders per message`);
    }
    const stat = await this.fs.lstat(folderPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Only regular folders can be added');
    }
    const resource = {
      selectionId: opaqueId('selection'),
      kind: 'folder',
      sourcePath: await this.fs.realpath(folderPath),
      name: cleanName(path.basename(folderPath)),
      category: 'folder',
    };
    pending.set(resource.selectionId, resource);
    this.staged.set(ownerKey, pending);
    return [{ selectionId: resource.selectionId, ...publicResource(resource) }];
  }

  removeStaged(ownerId, selectionId) {
    const pending = this.staged.get(String(ownerId));
    const removed = pending?.delete(selectionId) || false;
    if (pending?.size === 0) this.staged.delete(String(ownerId));
    return removed;
  }

  clearStaged(ownerId) {
    this.staged.delete(String(ownerId));
  }

  dispose() {
    this.staged.clear();
    this.resources.clear();
  }

  async consume(ownerId, selectionIds, conversationId) {
    if (!Array.isArray(selectionIds) || selectionIds.length === 0) return [];
    const pending = this.staged.get(String(ownerId));
    const selected = selectionIds.map((selectionId) => pending?.get(selectionId));
    if (selected.some((resource) => !resource)) throw new Error('An attachment selection expired');
    const current = await this.#resourcesFor(conversationId);
    const conversationDir = this.#conversationDir(conversationId);
    await this.fs.mkdir(conversationDir, { recursive: true, mode: 0o700 });
    const consumed = [];
    for (const staged of selected) {
      const resourceId = opaqueId(staged.kind === 'folder' ? 'folder' : 'attachment');
      if (staged.kind === 'folder') {
        const resource = { ...staged, resourceId, available: true };
        delete resource.selectionId;
        current.set(resourceId, resource);
        consumed.push(publicResource(resource));
        continue;
      }
      const extension = path.extname(staged.name).toLowerCase().slice(0, 16);
      const storageName = `${resourceId}${extension}`;
      const storagePath = path.join(conversationDir, storageName);
      const sourceStat = await this.fs.lstat(staged.sourcePath);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error(`${staged.name} is no longer a regular file; attach it again`);
      }
      const source = await this.fs.open(staged.sourcePath, SAFE_READ_FLAGS);
      try {
        const currentStat = await source.stat();
        if (!currentStat.isFile() || currentStat.size !== staged.bytes) {
          throw new Error(`${staged.name} changed after it was selected; attach it again`);
        }
        await this.fs.writeFile(storagePath, await source.readFile(), { mode: 0o600 });
      } finally {
        await source.close();
      }
      const resource = {
        resourceId,
        kind: 'file',
        name: staged.name,
        bytes: staged.bytes,
        mimeType: staged.mimeType,
        category: staged.category,
        storageName,
        storagePath,
        available: true,
      };
      current.set(resourceId, resource);
      consumed.push(publicResource(resource));
    }
    for (const selectionId of selectionIds) pending.delete(selectionId);
    if (!pending.size) this.staged.delete(String(ownerId));
    await this.#writeManifest(conversationId, current);
    return consumed;
  }

  async listResources(conversationId) {
    const resources = await this.#resourcesFor(conversationId);
    return [...resources.values()].map(publicResource);
  }

  async listFolder(conversationId, resourceId, relativePath = '', offset = 0) {
    const resource = await this.#resource(conversationId, resourceId);
    if (resource.kind !== 'folder' || !resource.available || !resource.sourcePath) {
      throw new Error('That folder is no longer available; ask the user to add it again');
    }
    const folderPath = await this.#resolveFolderPath(resource, relativePath, true);
    const start = Number.isSafeInteger(offset) ? Math.max(0, Math.min(offset, 10_000)) : 0;
    const entries = [];
    let index = 0;
    const directory = await this.fs.opendir(folderPath);
    for await (const entry of directory) {
      if (index++ < start) continue;
      if (entries.length >= MAX_FOLDER_ENTRIES + 1) break;
      entries.push({
        name: cleanName(entry.name),
        kind: entry.isDirectory() ? 'folder' : entry.isFile() ? 'file' : 'unavailable',
      });
    }
    const truncated = entries.length > MAX_FOLDER_ENTRIES;
    if (truncated) entries.pop();
    return {
      entries,
      offset: start,
      truncated,
      ...(truncated && { nextOffset: start + entries.length }),
    };
  }

  async read(conversationId, resourceId, options = {}) {
    const resource = await this.#resource(conversationId, resourceId);
    let filePath;
    let displayName = resource.name;
    let classification = resource;
    if (resource.kind === 'folder') {
      if (!options.path) throw new Error('Reading a folder resource requires a relative file path');
      filePath = await this.#resolveFolderPath(resource, options.path, false);
      displayName = cleanName(path.basename(filePath));
      classification = fileClassification(filePath);
    } else {
      filePath = resource.storagePath;
    }
    if (classification.category === 'pdf_unsupported') {
      throw new Error('PDF files are not supported yet; ask the user for text or page images');
    }
    if (!filePath || classification.category === 'unsupported') {
      throw new Error('That attachment type cannot be read by Agent');
    }
    const handle = await this.fs.open(filePath, SAFE_READ_FLAGS);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('The requested attachment is not a file');
      if (classification.category === 'image') {
        if (stat.size > MAX_IMAGE_BYTES) {
          throw new Error('The image is larger than the 8 MB model limit');
        }
        const data = await handle.readFile();
        return {
          kind: 'image',
          name: displayName,
          mimeType: classification.mimeType,
          bytes: data.length,
          data,
        };
      }
      const offset = Number.isSafeInteger(options.offset) ? Math.max(0, options.offset) : 0;
      const limit = Number.isSafeInteger(options.limit)
        ? Math.max(1, Math.min(MAX_TEXT_READ_BYTES, options.limit))
        : MAX_TEXT_READ_BYTES;
      const length = Math.min(limit, Math.max(0, stat.size - offset));
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return {
        kind: 'text',
        name: displayName,
        bytes: stat.size,
        offset,
        text: buffer.subarray(0, bytesRead).toString('utf8'),
        truncated: offset + bytesRead < stat.size,
      };
    } finally {
      await handle.close();
    }
  }

  async deleteConversation(conversationId) {
    this.resources.delete(conversationId);
    await this.fs.rm(this.#conversationDir(conversationId), { recursive: true, force: true });
  }

  async revokeFolder(conversationId, resourceId) {
    const current = await this.#resourcesFor(conversationId);
    const resource = current.get(resourceId);
    if (!resource || resource.kind !== 'folder') return false;
    const remaining = new Map(current);
    remaining.delete(resourceId);
    await this.#writeManifest(conversationId, remaining);
    this.resources.set(conversationId, remaining);
    return true;
  }

  #conversationDir(conversationId) {
    if (!/^conversation_[a-f0-9]{16}$/.test(conversationId)) {
      throw new TypeError('Invalid attachment conversation ID');
    }
    return path.join(this.rootDir, conversationId);
  }

  async #resourcesFor(conversationId) {
    if (this.resources.has(conversationId)) return this.resources.get(conversationId);
    const resources = new Map();
    const conversationDir = this.#conversationDir(conversationId);
    try {
      const manifest = JSON.parse(
        await this.fs.readFile(path.join(conversationDir, MANIFEST_FILE), 'utf8')
      );
      for (const item of Array.isArray(manifest?.resources) ? manifest.resources : []) {
        if (
          item?.kind === 'file' &&
          /^attachment_[a-f0-9]{20}$/.test(item.resourceId) &&
          typeof item.storageName === 'string' &&
          path.basename(item.storageName) === item.storageName &&
          item.storageName.startsWith(item.resourceId)
        ) {
          const classification = fileClassification(item.storageName);
          if (
            classification.category === 'unsupported' ||
            classification.category === 'pdf_unsupported'
          ) {
            continue;
          }
          resources.set(item.resourceId, {
            resourceId: item.resourceId,
            kind: 'file',
            name: cleanName(item.name),
            bytes: Number.isSafeInteger(item.bytes) && item.bytes >= 0 ? item.bytes : undefined,
            ...classification,
            storageName: item.storageName,
            storagePath: path.join(conversationDir, item.storageName),
            available: true,
          });
        } else if (item?.kind === 'folder' && /^folder_[a-f0-9]{20}$/.test(item.resourceId)) {
          resources.set(item.resourceId, {
            resourceId: item.resourceId,
            kind: 'folder',
            name: cleanName(item.name),
            category: 'folder',
            available: false,
          });
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.resources.set(conversationId, resources);
    return resources;
  }

  async #resource(conversationId, resourceId) {
    const resource = (await this.#resourcesFor(conversationId)).get(resourceId);
    if (!resource) throw new Error('Attachment resource was not found in this conversation');
    return resource;
  }

  async #resolveFolderPath(resource, relativePath, requireDirectory) {
    if (!resource.available || !resource.sourcePath) {
      throw new Error('That folder is no longer available; ask the user to add it again');
    }
    if (typeof relativePath !== 'string' || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
      throw new Error('Folder paths must be relative');
    }
    const candidate = path.resolve(resource.sourcePath, relativePath || '.');
    if (!pathInside(resource.sourcePath, candidate)) throw new Error('Folder path escapes its grant');
    const resolved = await this.fs.realpath(candidate);
    if (!pathInside(resource.sourcePath, resolved)) throw new Error('Folder path escapes its grant');
    const stat = await this.fs.stat(resolved);
    if (requireDirectory && !stat.isDirectory()) throw new Error('Requested folder path is not a directory');
    return resolved;
  }

  async #writeManifest(conversationId, resources) {
    const persisted = [...resources.values()].map((resource) =>
      resource.kind === 'file'
        ? {
            resourceId: resource.resourceId,
            kind: 'file',
            name: resource.name,
            bytes: resource.bytes,
            mimeType: resource.mimeType,
            category: resource.category,
            storageName: resource.storageName,
          }
        : {
            resourceId: resource.resourceId,
            kind: 'folder',
            name: resource.name,
            category: 'folder',
          }
    );
    const manifestPath = path.join(this.#conversationDir(conversationId), MANIFEST_FILE);
    const temporaryPath = `${manifestPath}.tmp`;
    await this.fs.writeFile(temporaryPath, JSON.stringify({ version: 1, resources: persisted }), {
      mode: 0o600,
    });
    await this.fs.rename(temporaryPath, manifestPath);
  }
}

module.exports = {
  ATTACHMENTS_DIR,
  ConversationAttachmentStore,
  MAX_FILE_BYTES,
  MAX_FOLDER_ENTRIES,
  MAX_IMAGE_BYTES,
  MAX_SELECTIONS,
  MAX_TEXT_READ_BYTES,
  MAX_TOTAL_BYTES,
  fileClassification,
  pathInside,
  publicResource,
};
