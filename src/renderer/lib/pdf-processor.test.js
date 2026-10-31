// The PDF processor's standard fonts come from src/renderer/assets/pdf-fonts/,
// not pdfjs-dist's standard_fonts/, whose Liberation Sans 1.x is GPL-2.0 and
// is left out of the package (#962). These checks keep that directory usable
// across pdfjs-dist bumps.
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..', '..');
const fontDir = path.join(repoRoot, 'src', 'renderer', 'assets', 'pdf-fonts');
const pdfjsRoot = path.join(repoRoot, 'node_modules', 'pdfjs-dist');
const pdfjsFonts = path.join(pdfjsRoot, 'standard_fonts');

describe('PDF standard fonts', () => {
  test('the processor reads them from assets/pdf-fonts with system fonts on', () => {
    const source = fs.readFileSync(path.join(__dirname, 'pdf-processor.js'), 'utf8');
    expect(source).toMatch(/new URL\('\.\.\/assets\/pdf-fonts\/', import\.meta\.url\)/);
    expect(source).toMatch(/standardFontDataUrl: STANDARD_FONT_DATA_URL/);
    expect(source).not.toMatch(/assetUrl\(['"`]standard_fonts/);
    // With system fonts off PDF.js would fetch every standard font file, and
    // the directory carries only the ones it fetches with them on.
    expect(source).toMatch(/useSystemFonts: true/);
  });

  test('holds every Liberation Sans file PDF.js names, none of them 1.x', () => {
    const worker = fs.readFileSync(path.join(pdfjsRoot, 'build', 'pdf.worker.mjs'), 'utf8');
    const names = new Set(worker.match(/LiberationSans-[A-Za-z]+\.ttf/g));
    expect(names.size).toBe(4);
    for (const name of names) {
      const bytes = fs.readFileSync(path.join(fontDir, name));
      expect({
        name,
        sameAsPdfjs: bytes.equals(fs.readFileSync(path.join(pdfjsFonts, name))),
      }).toEqual({ name, sameAsPdfjs: false });
    }
    const license = fs.readFileSync(path.join(fontDir, 'LICENSE_LIBERATION'), 'utf8');
    expect(license).toMatch(/SIL Open Font License,\s+Version 1\.1/);
    expect(license).not.toMatch(/General Public License/);
  });

  test.each(['FoxitSymbol.pfb', 'FoxitDingbats.pfb', 'LICENSE_FOXIT'])(
    '%s matches the installed pdfjs-dist',
    (name) => {
      const ours = fs.readFileSync(path.join(fontDir, name));
      expect(ours.equals(fs.readFileSync(path.join(pdfjsFonts, name)))).toBe(true);
    }
  );
});
