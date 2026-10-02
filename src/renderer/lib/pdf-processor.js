import * as pdfjsLib from '../../../node_modules/pdfjs-dist/build/pdf.mjs';

const MAX_PAGES = 500;
const MAX_TEXT_PAGES = 4;
const MAX_TEXT_CHARS = 128 * 1024;
const MAX_RENDER_DIMENSION = 2048;
const MAX_RENDER_PIXELS = 4_000_000;
const MAX_RENDER_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_PREVIEW_DIMENSION = 192;
const MAX_IMAGE_DIMENSION = 32_768;
const MAX_IMAGE_PIXELS = 100_000_000;
const PREVIEW_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).href;

function assetUrl(relativePath) {
  return new URL(`../../../node_modules/pdfjs-dist/${relativePath}`, import.meta.url).href;
}

function safeError(error) {
  const name = typeof error?.name === 'string' ? error.name : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  if (name === 'PasswordException' || /password/i.test(message)) {
    return { code: 'PDF_PASSWORD_REQUIRED', message: 'Password-protected PDFs are not supported' };
  }
  if (name === 'InvalidPDFException') {
    return { code: 'PDF_INVALID', message: 'The PDF is malformed or invalid' };
  }
  if (name === 'MissingPDFException') {
    return { code: 'PDF_INVALID', message: 'The PDF data is unavailable' };
  }
  return { code: 'PDF_PROCESSING_FAILED', message: 'The PDF could not be processed safely' };
}

function validateRequest(request) {
  if (!request || typeof request.jobId !== 'string') throw new Error('Invalid attachment job');
  if (!(request.data instanceof Uint8Array)) throw new Error('Invalid attachment bytes');
  if (!['extractText', 'renderPage', 'renderPdfPreview', 'renderImagePreview'].includes(request.operation)) {
    throw new Error('Invalid attachment operation');
  }
  if (
    request.operation !== 'renderImagePreview' &&
    (!Number.isSafeInteger(request.page) || request.page < 1)
  ) {
    throw new Error('Invalid PDF page');
  }
  if (
    request.operation === 'renderImagePreview' &&
    !PREVIEW_IMAGE_MIME_TYPES.has(request.mimeType)
  ) {
    throw new Error('Invalid image preview type');
  }
  if (
    request.operation === 'extractText' &&
    (!Number.isSafeInteger(request.pageCount) ||
      request.pageCount < 1 ||
      request.pageCount > MAX_TEXT_PAGES)
  ) {
    throw new Error('Invalid PDF page count');
  }
}

async function loadDocument(data) {
  const loadingTask = pdfjsLib.getDocument({
    data,
    cMapUrl: assetUrl('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts/'),
    wasmUrl: assetUrl('wasm/'),
    iccUrl: assetUrl('iccs/'),
    enableScripting: false,
    isEvalSupported: false,
    stopAtErrors: true,
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
    maxImageSize: MAX_RENDER_PIXELS,
    useWorkerFetch: true,
  });
  let rejectPassword;
  const passwordRequest = new Promise((_resolve, reject) => {
    rejectPassword = reject;
  });
  loadingTask.onPassword = () => {
    const error = new Error('Password-protected PDFs are not supported');
    error.code = 'PDF_PASSWORD_REQUIRED';
    rejectPassword(error);
    void loadingTask.destroy();
  };
  const document = await Promise.race([loadingTask.promise, passwordRequest]);
  if (document.numPages > MAX_PAGES) {
    await document.destroy();
    const error = new Error(`PDFs may contain at most ${MAX_PAGES} pages`);
    error.code = 'PDF_PAGE_LIMIT';
    throw error;
  }
  return document;
}

function pageText(items) {
  let text = '';
  for (const item of items) {
    if (typeof item?.str !== 'string') continue;
    text += item.str;
    text += item.hasEOL ? '\n' : ' ';
    if (text.length >= MAX_TEXT_CHARS) break;
  }
  return text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}

function assertPageInRange(document, page) {
  if (page <= document.numPages) return;
  const error = new Error(`The PDF has ${document.numPages} pages; page ${page} is out of range`);
  error.code = 'PDF_PAGE_OUT_OF_RANGE';
  throw error;
}

async function extractText(document, request) {
  assertPageInRange(document, request.page);
  const lastPage = Math.min(document.numPages, request.page + request.pageCount - 1);
  const pages = [];
  let remaining = MAX_TEXT_CHARS;
  for (let pageNumber = request.page; pageNumber <= lastPage && remaining > 0; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    try {
      const textContent = await page.getTextContent({ disableNormalization: false });
      const text = pageText(textContent.items).slice(0, remaining);
      pages.push({ page: pageNumber, text });
      remaining -= text.length;
    } finally {
      page.cleanup(true);
    }
  }
  return {
    kind: 'pdf_text',
    pageCount: document.numPages,
    pages,
    truncated: lastPage < document.numPages || remaining === 0,
  };
}

function renderScale(viewport, maximumDimension = MAX_RENDER_DIMENSION, maximumPixels = MAX_RENDER_PIXELS) {
  const dimensionScale = Math.min(
    maximumDimension / Math.max(1, viewport.width),
    maximumDimension / Math.max(1, viewport.height)
  );
  const pixelScale = Math.sqrt(
    maximumPixels / Math.max(1, viewport.width * viewport.height)
  );
  return Math.min(2, dimensionScale, pixelScale);
}

async function canvasPng(canvas, maximumBytes = MAX_RENDER_BYTES) {
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('PNG encoding failed'))), 'image/png');
  });
  if (blob.size > maximumBytes) throw new Error('Rendered image exceeds the output limit');
  return new Uint8Array(await blob.arrayBuffer());
}

async function renderPage(document, request, preview = false) {
  assertPageInRange(document, request.page);
  const page = await document.getPage(request.page);
  try {
    const baseViewport = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: preview
        ? renderScale(
            baseViewport,
            MAX_PREVIEW_DIMENSION,
            MAX_PREVIEW_DIMENSION * MAX_PREVIEW_DIMENSION
          )
        : renderScale(baseViewport),
    });
    const canvas = globalThis.document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext('2d', { alpha: false });
    await page.render({
      canvasContext: context,
      viewport,
      annotationMode: pdfjsLib.AnnotationMode.DISABLE,
      intent: 'display',
    }).promise;
    const data = await canvasPng(canvas, preview ? MAX_PREVIEW_BYTES : MAX_RENDER_BYTES);
    canvas.width = 1;
    canvas.height = 1;
    return {
      kind: preview ? 'attachment_preview' : 'pdf_page',
      ...(preview ? { sourceKind: 'pdf' } : { page: request.page, pageCount: document.numPages }),
      width: Math.floor(viewport.width),
      height: Math.floor(viewport.height),
      mimeType: 'image/png',
      data,
    };
  } finally {
    page.cleanup(true);
  }
}

async function renderImagePreview(request) {
  const blob = new Blob([request.data], { type: request.mimeType });
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    if (
      bitmap.width < 1 ||
      bitmap.height < 1 ||
      bitmap.width > MAX_IMAGE_DIMENSION ||
      bitmap.height > MAX_IMAGE_DIMENSION ||
      bitmap.width * bitmap.height > MAX_IMAGE_PIXELS
    ) {
      throw new Error('Image dimensions exceed the preview limit');
    }
    const scale = Math.min(
      1,
      MAX_PREVIEW_DIMENSION / bitmap.width,
      MAX_PREVIEW_DIMENSION / bitmap.height
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = globalThis.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: true });
    context.drawImage(bitmap, 0, 0, width, height);
    const data = await canvasPng(canvas, MAX_PREVIEW_BYTES);
    canvas.width = 1;
    canvas.height = 1;
    return {
      kind: 'attachment_preview',
      sourceKind: 'image',
      width,
      height,
      mimeType: 'image/png',
      data,
    };
  } finally {
    bitmap.close();
  }
}

window.freedomPdfProcessor.onRequest(async (request) => {
  let document;
  try {
    validateRequest(request);
    let value;
    if (request.operation === 'renderImagePreview') {
      value = await renderImagePreview(request);
    } else {
      document = await loadDocument(request.data);
      value =
        request.operation === 'extractText'
          ? await extractText(document, request)
          : await renderPage(document, request, request.operation === 'renderPdfPreview');
    }
    window.freedomPdfProcessor.respond({ jobId: request.jobId, ok: true, value });
  } catch (error) {
    const safe = error?.code
      ? { code: String(error.code).slice(0, 64), message: String(error.message).slice(0, 240) }
      : safeError(error);
    window.freedomPdfProcessor.respond({ jobId: request?.jobId, ok: false, error: safe });
  } finally {
    await document?.destroy().catch(() => {});
  }
});
