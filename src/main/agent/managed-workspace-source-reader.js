'use strict';

const fs = require('fs');
const path = require('path');

const MAX_WORKSPACE_PUBLICATION_BYTES = 50 * 1024 * 1024;
const MAX_WORKSPACE_PUBLICATION_ENTRIES = 1_000;
const MAX_WORKSPACE_PUBLICATION_FILES = 100;
const MAX_WORKSPACE_PUBLICATION_PATH_LENGTH = 1_024;
const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
});

class ManagedWorkspaceSourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ManagedWorkspaceSourceError';
    this.code = code;
  }
}

function sourceError(code, message) {
  return new ManagedWorkspaceSourceError(code, message);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function validateWorkspacePublicationPath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_WORKSPACE_PUBLICATION_PATH_LENGTH ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value)
  ) {
    throw sourceError(
      'INVALID_WORKSPACE_PUBLICATION_PATH',
      'Publication paths must be bounded paths inside the managed workspace'
    );
  }
  if (value === '.') return value;
  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git'
    )
  ) {
    throw sourceError(
      'INVALID_WORKSPACE_PUBLICATION_PATH',
      'Publication paths must remain outside protected workspace metadata'
    );
  }
  return segments.join('/');
}

async function checkedEntry(root, relativePath) {
  const rootEntry = await fs.promises.lstat(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw sourceError(
      'WORKSPACE_PUBLICATION_UNSAFE',
      'The managed workspace is unavailable for publication'
    );
  }
  const rootReal = await fs.promises.realpath(root);
  let candidate = root;
  for (const segment of relativePath === '.' ? [] : relativePath.split('/')) {
    candidate = path.join(candidate, segment);
    const entry = await fs.promises.lstat(candidate);
    if (entry.isSymbolicLink()) {
      throw sourceError(
        'WORKSPACE_PUBLICATION_UNSAFE',
        'Symbolic links cannot be published from a managed workspace'
      );
    }
  }
  const canonical = await fs.promises.realpath(candidate);
  if (!isInside(rootReal, canonical)) {
    throw sourceError(
      'WORKSPACE_PUBLICATION_UNSAFE',
      'The publication source escaped its managed workspace'
    );
  }
  return { candidate, canonical, rootReal };
}

async function readRegularFile(root, relativePath, remainingBytes) {
  const checked = await checkedEntry(root, relativePath);
  const handle = await fs.promises.open(
    checked.candidate,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1) {
      throw sourceError(
        'WORKSPACE_PUBLICATION_UNSAFE',
        'Only ordinary files without hard links can be published'
      );
    }
    if (stats.size > remainingBytes) {
      throw sourceError(
        'WORKSPACE_PUBLICATION_TOO_LARGE',
        `Managed workspace publications are limited to ${MAX_WORKSPACE_PUBLICATION_BYTES} bytes`
      );
    }
    const canonicalAfterOpen = await fs.promises.realpath(checked.candidate);
    const entryAfterOpen = await fs.promises.lstat(checked.candidate);
    if (
      !isInside(checked.rootReal, canonicalAfterOpen) ||
      entryAfterOpen.isSymbolicLink() ||
      entryAfterOpen.dev !== stats.dev ||
      entryAfterOpen.ino !== stats.ino
    ) {
      throw sourceError(
        'WORKSPACE_PUBLICATION_UNSAFE',
        'A workspace file changed while Freedom was opening it for publication'
      );
    }
    const bytes = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset !== stats.size) {
      throw sourceError(
        'WORKSPACE_PUBLICATION_UNSAFE',
        'A workspace file changed while Freedom was reading it for publication'
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function publicName(relativePath, kind) {
  if (relativePath === '.') return kind === 'folder' ? 'Project workspace' : 'Workspace file';
  return path.posix.basename(relativePath);
}

function contentTypeForPath(relativePath) {
  return (
    CONTENT_TYPES[path.posix.extname(relativePath).toLowerCase()] || 'application/octet-stream'
  );
}

class ManagedWorkspaceSourceReader {
  constructor(options = {}) {
    if (typeof options.workspaceController?.resolveWorkspacePath !== 'function') {
      throw new TypeError('Managed workspace sources require a workspace controller');
    }
    this.workspaceController = options.workspaceController;
  }

  async describe(conversationId, requestedPath = '.') {
    const relativePath = validateWorkspacePublicationPath(requestedPath || '.');
    try {
      const { path: workspaceRoot } =
        await this.workspaceController.resolveWorkspacePath(conversationId);
      const checked = await checkedEntry(workspaceRoot, relativePath);
      const stats = await fs.promises.lstat(checked.candidate);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        return Object.freeze({
          sourceType: 'workspace',
          kind: 'folder',
          name: publicName(relativePath, 'folder'),
          workspacePath: relativePath,
        });
      }
      if (stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1) {
        if (stats.size > MAX_WORKSPACE_PUBLICATION_BYTES) {
          throw sourceError(
            'WORKSPACE_PUBLICATION_TOO_LARGE',
            `Managed workspace publications are limited to ${MAX_WORKSPACE_PUBLICATION_BYTES} bytes`
          );
        }
        return Object.freeze({
          sourceType: 'workspace',
          kind: 'file',
          name: publicName(relativePath, 'file'),
          workspacePath: relativePath,
          bytes: stats.size,
        });
      }
      throw sourceError(
        'WORKSPACE_PUBLICATION_UNSAFE',
        'Only ordinary workspace files and folders can be published'
      );
    } catch (error) {
      if (error instanceof ManagedWorkspaceSourceError) throw error;
      throw sourceError(
        'WORKSPACE_PUBLICATION_UNAVAILABLE',
        'The requested managed workspace source is unavailable'
      );
    }
  }

  async read(conversationId, requestedPath = '.') {
    const descriptor = await this.describe(conversationId, requestedPath);
    let workspaceRoot;
    try {
      ({ path: workspaceRoot } =
        await this.workspaceController.resolveWorkspacePath(conversationId));
    } catch {
      throw sourceError(
        'WORKSPACE_PUBLICATION_UNAVAILABLE',
        'The managed workspace is unavailable for publication'
      );
    }
    if (descriptor.kind === 'file') {
      try {
        const bytes = await readRegularFile(
          workspaceRoot,
          descriptor.workspacePath,
          MAX_WORKSPACE_PUBLICATION_BYTES
        );
        const contentType = contentTypeForPath(descriptor.workspacePath);
        return Object.freeze({
          ...descriptor,
          bytes: bytes.byteLength,
          data: bytes,
          contentType,
        });
      } catch (error) {
        if (error instanceof ManagedWorkspaceSourceError) throw error;
        throw sourceError(
          'WORKSPACE_PUBLICATION_UNAVAILABLE',
          'Freedom could not read the requested managed workspace file'
        );
      }
    }

    const files = [];
    let totalBytes = 0;
    let entriesSeen = 0;
    const selectedRoot = descriptor.workspacePath;

    const walk = async (relativeDirectory) => {
      entriesSeen += 1;
      if (entriesSeen > MAX_WORKSPACE_PUBLICATION_ENTRIES) {
        throw sourceError(
          'WORKSPACE_PUBLICATION_TOO_LARGE',
          'The managed workspace publication contains too many entries'
        );
      }
      const checked = await checkedEntry(workspaceRoot, relativeDirectory);
      const stats = await fs.promises.lstat(checked.candidate);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw sourceError(
          'WORKSPACE_PUBLICATION_UNSAFE',
          'A workspace directory changed while Freedom was preparing the publication'
        );
      }
      const names = await fs.promises.readdir(checked.candidate);
      names.sort((left, right) => left.localeCompare(right));
      for (const name of names) {
        if (name.toLowerCase() === '.git') continue;
        entriesSeen += 1;
        if (entriesSeen > MAX_WORKSPACE_PUBLICATION_ENTRIES) {
          throw sourceError(
            'WORKSPACE_PUBLICATION_TOO_LARGE',
            'The managed workspace publication contains too many entries'
          );
        }
        const child = relativeDirectory === '.' ? name : `${relativeDirectory}/${name}`;
        const childChecked = await checkedEntry(workspaceRoot, child);
        const childStats = await fs.promises.lstat(childChecked.candidate);
        if (childStats.isSymbolicLink()) {
          throw sourceError(
            'WORKSPACE_PUBLICATION_UNSAFE',
            'Symbolic links cannot be published from a managed workspace'
          );
        }
        if (childStats.isDirectory()) {
          await walk(child);
          continue;
        }
        if (!childStats.isFile() || childStats.nlink !== 1) {
          throw sourceError(
            'WORKSPACE_PUBLICATION_UNSAFE',
            'Only ordinary files without hard links can be published'
          );
        }
        if (files.length >= MAX_WORKSPACE_PUBLICATION_FILES) {
          throw sourceError(
            'WORKSPACE_PUBLICATION_TOO_LARGE',
            `Managed workspace publications are limited to ${MAX_WORKSPACE_PUBLICATION_FILES} files`
          );
        }
        const bytes = await readRegularFile(
          workspaceRoot,
          child,
          MAX_WORKSPACE_PUBLICATION_BYTES - totalBytes
        );
        totalBytes += bytes.byteLength;
        const collectionPath =
          selectedRoot === '.' ? child : path.posix.relative(selectedRoot, child);
        files.push(Object.freeze({ path: collectionPath, bytes }));
      }
    };

    try {
      await walk(selectedRoot);
    } catch (error) {
      if (error instanceof ManagedWorkspaceSourceError) throw error;
      throw sourceError(
        'WORKSPACE_PUBLICATION_UNAVAILABLE',
        'Freedom could not read the requested managed workspace source'
      );
    }
    if (!files.length) {
      throw sourceError(
        'WORKSPACE_PUBLICATION_EMPTY',
        'The requested managed workspace folder contains no publishable files'
      );
    }
    return Object.freeze({
      ...descriptor,
      bytes: totalBytes,
      files: Object.freeze(files),
    });
  }
}

module.exports = {
  MAX_WORKSPACE_PUBLICATION_BYTES,
  MAX_WORKSPACE_PUBLICATION_ENTRIES,
  MAX_WORKSPACE_PUBLICATION_FILES,
  ManagedWorkspaceSourceError,
  ManagedWorkspaceSourceReader,
  checkedEntry,
  contentTypeForPath,
  readRegularFile,
  validateWorkspacePublicationPath,
};
