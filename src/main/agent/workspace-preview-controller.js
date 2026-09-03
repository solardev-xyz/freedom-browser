'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREVIEW_SCHEME = 'freedom-preview';
const MAX_PREVIEWS = 32;
const MAX_CONCURRENT_PREVIEW_REQUESTS = 8;
const MAX_PREVIEW_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_PATH_LENGTH = 1_024;
const PREVIEW_CSP = [
  'sandbox allow-scripts allow-same-origin',
  "default-src 'self'",
  "connect-src 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const MIME_TYPES = Object.freeze({
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
});

class WorkspacePreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspacePreviewError';
    this.code = code;
  }
}

function previewToken() {
  return crypto.randomBytes(20).toString('hex');
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function safeRelativePath(value, options = {}) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_PREVIEW_PATH_LENGTH ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value)
  ) {
    throw new WorkspacePreviewError(
      'INVALID_WORKSPACE_REQUEST',
      'Preview paths must be bounded workspace-relative paths'
    );
  }
  if (value === '.' && options.allowRoot === true) return value;
  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git'
    )
  ) {
    throw new WorkspacePreviewError(
      'WORKSPACE_PREVIEW_UNSAFE',
      'The requested preview path is not available'
    );
  }
  return segments.join('/');
}

function requestRelativePath(url) {
  const rawSegments = url.pathname.split('/').slice(1);
  const segments = rawSegments.map((segment) => {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new WorkspacePreviewError('WORKSPACE_PREVIEW_UNSAFE', 'The preview URL is invalid');
    }
    if (
      decoded.includes('/') ||
      decoded.includes('\\') ||
      decoded.includes('\0') ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.toLowerCase() === '.git'
    ) {
      throw new WorkspacePreviewError('WORKSPACE_PREVIEW_UNSAFE', 'The preview URL is invalid');
    }
    return decoded;
  });
  return segments.filter(Boolean).join('/');
}

function responseHeaders(contentType = null) {
  return {
    ...(contentType && { 'Content-Type': contentType }),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': PREVIEW_CSP,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

async function checkedPath(root, relativePath) {
  const rootEntry = await fs.promises.lstat(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new WorkspacePreviewError('WORKSPACE_PREVIEW_UNSAFE', 'The preview root is unavailable');
  }
  const rootReal = await fs.promises.realpath(root);
  let candidate = root;
  for (const segment of relativePath ? relativePath.split('/') : []) {
    candidate = path.join(candidate, segment);
    const entry = await fs.promises.lstat(candidate);
    if (entry.isSymbolicLink()) {
      throw new WorkspacePreviewError(
        'WORKSPACE_PREVIEW_UNSAFE',
        'Symbolic links are unavailable in previews'
      );
    }
  }
  const canonical = await fs.promises.realpath(candidate);
  if (!isInside(rootReal, canonical)) {
    throw new WorkspacePreviewError(
      'WORKSPACE_PREVIEW_UNSAFE',
      'The preview path escaped its root'
    );
  }
  return { candidate, canonical, rootReal };
}

async function readRegularFile(root, relativePath) {
  const checked = await checkedPath(root, relativePath);
  const handle = await fs.promises.open(
    checked.candidate,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new WorkspacePreviewError(
        'WORKSPACE_PREVIEW_UNSAFE',
        'Only ordinary, unlinked files can be previewed'
      );
    }
    if (stats.size > MAX_PREVIEW_FILE_BYTES) {
      throw new WorkspacePreviewError(
        'WORKSPACE_PREVIEW_TOO_LARGE',
        'The requested preview file is too large'
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
      throw new WorkspacePreviewError(
        'WORKSPACE_PREVIEW_UNSAFE',
        'The preview file changed while it was being opened'
      );
    }
    const data = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < data.length) {
      const result = await handle.read(data, offset, data.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    return data.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

class WorkspacePreviewController {
  constructor(options = {}) {
    if (typeof options.workspaceController?.resolveWorkspacePath !== 'function') {
      throw new TypeError('Workspace previews require a managed workspace controller');
    }
    this.workspaceController = options.workspaceController;
    this.tokenFactory = options.tokenFactory || previewToken;
    this.maxPreviews = Number.isSafeInteger(options.maxPreviews)
      ? Math.max(1, options.maxPreviews)
      : MAX_PREVIEWS;
    this.previews = new Map();
    this.session = null;
    this.activeRequests = 0;
  }

  register(targetSession) {
    if (typeof targetSession?.protocol?.handle !== 'function') {
      throw new TypeError('Workspace previews require an Electron protocol session');
    }
    if (this.session) throw new Error('Workspace preview protocol is already registered');
    this.session = targetSession;
    targetSession.protocol.handle(PREVIEW_SCHEME, (request) => this.handleRequest(request));
  }

  async createPreview(conversationId, requestedPath = '.') {
    const relative = safeRelativePath(requestedPath || '.', { allowRoot: true });
    const { workspace, path: workspaceRoot } =
      await this.workspaceController.resolveWorkspacePath(conversationId);
    const selected = await checkedPath(workspaceRoot, relative === '.' ? '' : relative);
    const selectedEntry = await fs.promises.lstat(selected.candidate);
    let root;
    let entryPath;
    if (selectedEntry.isDirectory()) {
      root = selected.canonical;
      entryPath = 'index.html';
    } else if (
      selectedEntry.isFile() &&
      selectedEntry.nlink === 1 &&
      ['.html', '.htm'].includes(path.extname(selected.candidate).toLowerCase())
    ) {
      root = path.dirname(selected.canonical);
      entryPath = path.basename(selected.canonical);
    } else {
      throw new WorkspacePreviewError(
        'WORKSPACE_PREVIEW_UNAVAILABLE',
        'Preview a directory containing index.html or an HTML file'
      );
    }
    await readRegularFile(root, entryPath);
    for (const [token, preview] of this.previews) {
      if (
        preview.conversationId === conversationId &&
        preview.workspaceId === workspace.workspaceId &&
        preview.root === root &&
        preview.entryPath === entryPath
      ) {
        return Object.freeze({
          url: `${PREVIEW_SCHEME}://${token}/${encodeURIComponent(entryPath)}`,
          entryPath: relative === '.' ? entryPath : relative,
        });
      }
    }
    if (this.previews.size >= this.maxPreviews) {
      throw new WorkspacePreviewError(
        'WORKSPACE_PREVIEW_UNAVAILABLE',
        'Too many static previews are already open'
      );
    }
    const token = this.tokenFactory();
    if (
      typeof token !== 'string' ||
      !/^[a-f0-9]{20,128}$/.test(token) ||
      this.previews.has(token)
    ) {
      throw new WorkspacePreviewError(
        'WORKSPACE_PREVIEW_UNAVAILABLE',
        'Could not allocate a preview'
      );
    }
    this.previews.set(
      token,
      Object.freeze({ conversationId, workspaceId: workspace.workspaceId, root, entryPath })
    );
    return Object.freeze({
      url: `${PREVIEW_SCHEME}://${token}/${encodeURIComponent(entryPath)}`,
      entryPath: relative === '.' ? entryPath : relative,
    });
  }

  async handleRequest(request) {
    if (this.activeRequests >= MAX_CONCURRENT_PREVIEW_REQUESTS) {
      return new Response('Preview busy', {
        status: 429,
        headers: responseHeaders('text/plain; charset=utf-8'),
      });
    }
    this.activeRequests += 1;
    try {
      if (!['GET', 'HEAD'].includes(request?.method || 'GET')) {
        return new Response('Method not allowed', {
          status: 405,
          headers: responseHeaders('text/plain; charset=utf-8'),
        });
      }
      const url = new URL(request.url);
      const preview = this.previews.get(url.hostname);
      if (url.protocol !== `${PREVIEW_SCHEME}:` || !preview) {
        return new Response('Preview unavailable', {
          status: 404,
          headers: responseHeaders('text/plain; charset=utf-8'),
        });
      }
      const workspace = this.workspaceController.getWorkspace(preview.conversationId);
      if (!workspace?.enabled || workspace.workspaceId !== preview.workspaceId) {
        this.previews.delete(url.hostname);
        return new Response('Preview unavailable', {
          status: 404,
          headers: responseHeaders('text/plain; charset=utf-8'),
        });
      }
      let relative = requestRelativePath(url);
      const checked = await checkedPath(preview.root, relative);
      const entry = await fs.promises.lstat(checked.candidate);
      if (entry.isDirectory()) {
        if (!url.pathname.endsWith('/')) {
          return new Response(null, {
            status: 307,
            headers: { ...responseHeaders(), Location: `${url.pathname}/${url.search}` },
          });
        }
        relative = relative ? `${relative}/index.html` : 'index.html';
      }
      const data = await readRegularFile(preview.root, relative);
      const contentType =
        MIME_TYPES[path.extname(relative).toLowerCase()] || 'application/octet-stream';
      return new Response(request.method === 'HEAD' ? null : data, {
        status: 200,
        headers: { ...responseHeaders(contentType), 'Content-Length': String(data.byteLength) },
      });
    } catch (error) {
      const status = error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 404 : 403;
      return new Response(status === 404 ? 'Not found' : 'Preview blocked', {
        status,
        headers: responseHeaders('text/plain; charset=utf-8'),
      });
    } finally {
      this.activeRequests -= 1;
    }
  }

  async revokeConversation(conversationId) {
    let revoked = 0;
    const storageClears = [];
    for (const [token, preview] of this.previews) {
      if (preview.conversationId !== conversationId) continue;
      this.previews.delete(token);
      if (typeof this.session?.clearStorageData === 'function') {
        storageClears.push(
          this.session.clearStorageData({
            origin: `${PREVIEW_SCHEME}://${token}`,
            storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'cachestorage'],
          })
        );
      }
      revoked += 1;
    }
    await Promise.allSettled(storageClears);
    return revoked;
  }

  async dispose() {
    const tokens = [...this.previews.keys()];
    if (typeof this.session?.clearStorageData === 'function') {
      await Promise.allSettled(
        tokens.map((token) =>
          this.session.clearStorageData({
            origin: `${PREVIEW_SCHEME}://${token}`,
            storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'cachestorage'],
          })
        )
      );
    }
    if (this.session?.protocol?.unhandle) {
      await this.session.protocol.unhandle(PREVIEW_SCHEME);
    }
    this.session = null;
    this.previews.clear();
  }
}

module.exports = {
  MAX_CONCURRENT_PREVIEW_REQUESTS,
  MAX_PREVIEW_FILE_BYTES,
  MAX_PREVIEWS,
  MIME_TYPES,
  PREVIEW_CSP,
  PREVIEW_SCHEME,
  WorkspacePreviewController,
  WorkspacePreviewError,
  readRegularFile,
  requestRelativePath,
  safeRelativePath,
};
