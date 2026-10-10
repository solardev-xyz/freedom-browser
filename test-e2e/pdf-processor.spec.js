'use strict';

const path = require('path');
const { test, expect } = require('./fixtures');

function testPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 49 >>\nstream\nBT /F1 18 Tf 30 100 Td (Freedom page one) Tj ET\nendstream',
    '<< /Length 49 >>\nstream\nBT /F1 18 Tf 30 100 Td (Freedom page two) Tj ET\nendstream',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body, 'ascii'));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'ascii');
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'ascii');
}

test('sandboxed attachment processor extracts PDF text and renders bounded pages and previews', async ({
  electronApp,
}) => {
  const processorPath = path.resolve(__dirname, '..', 'src', 'main', 'agent', 'pdf-processor.js');
  const result = await electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, { modulePath, pdfBase64 }) => {
      const { PdfProcessor } = process.mainModule.require(modulePath);
      const processor = new PdfProcessor({ BrowserWindow, ipcMain });
      try {
        const data = Buffer.from(pdfBase64, 'base64');
        const text = await processor.extractText(data, { page: 1, pageCount: 2 });
        const image = await processor.renderPage(data, { page: 2 });
        const pdfPreview = await processor.renderPreview(data, {
          category: 'pdf',
          mimeType: 'application/pdf',
        });
        const imagePreview = await processor.renderPreview(image.data, {
          category: 'image',
          mimeType: 'image/png',
        });
        return {
          text,
          image: {
            ...image,
            data: Buffer.from(image.data).toString('base64'),
          },
          previews: [pdfPreview, imagePreview].map((preview) => ({
            ...preview,
            data: Buffer.from(preview.data).toString('base64'),
          })),
        };
      } finally {
        processor.dispose();
      }
    },
    {
      modulePath: processorPath,
      pdfBase64: testPdf().toString('base64'),
    }
  );

  expect(result.text).toMatchObject({
    kind: 'pdf_text',
    pageCount: 2,
    pages: [
      { page: 1, text: expect.stringContaining('Freedom page one') },
      { page: 2, text: expect.stringContaining('Freedom page two') },
    ],
  });
  expect(result.image).toMatchObject({
    kind: 'pdf_page',
    page: 2,
    pageCount: 2,
    mimeType: 'image/png',
  });
  expect(Buffer.from(result.image.data, 'base64').subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  );
  expect(result.previews).toHaveLength(2);
  expect(result.previews[0]).toMatchObject({
    kind: 'attachment_preview',
    sourceKind: 'pdf',
    mimeType: 'image/png',
  });
  expect(result.previews[1]).toMatchObject({
    kind: 'attachment_preview',
    sourceKind: 'image',
    mimeType: 'image/png',
  });
  for (const preview of result.previews) {
    expect(preview.width).toBeLessThanOrEqual(192);
    expect(preview.height).toBeLessThanOrEqual(192);
    expect(Buffer.from(preview.data, 'base64').subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  }
});
