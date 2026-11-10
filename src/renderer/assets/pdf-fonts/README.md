# PDF standard fonts

`standardFontDataUrl` for the agent's PDF processor
(`src/renderer/lib/pdf-processor.js`). PDF.js fetches from here when a PDF uses
a standard font without embedding it. With `useSystemFonts` on, the worker
fetches only Symbol and ZapfDingbats outright; Helvetica falls back to local
fonts first and names the Liberation Sans files as its `@font-face` fallback.

pdfjs-dist ships Liberation Sans 1.x, whose licence does not cover
redistributing the font files themselves, so `build.files` excludes its
`standard_fonts/` directory and Freedom ships these files instead
([#962](https://github.com/solardev-xyz/freedom-browser/issues/962)). The
file names are the ones PDF.js looks up.

| File                            | Source                                                                                                                                            | License                        | sha256                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `LiberationSans-Regular.ttf`    | [Liberation Fonts 2.1.5](https://github.com/liberationfonts/liberation-fonts/releases/tag/2.1.5), `liberation-fonts-ttf-2.1.5.tar.gz`, unmodified | OFL-1.1 (`LICENSE_LIBERATION`) | `76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8` |
| `LiberationSans-Bold.ttf`       | same                                                                                                                                              | OFL-1.1                        | `788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173` |
| `LiberationSans-Italic.ttf`     | same                                                                                                                                              | OFL-1.1                        | `e5bae5c4cde31f22142753855f4f8fb86da6ff39955ed3c0a11248b0d16948b0` |
| `LiberationSans-BoldItalic.ttf` | same                                                                                                                                              | OFL-1.1                        | `698da70fc191cc5f33ad4d6d3fe830fe4624b898ea2e3169955928b7c491f1ee` |
| `FoxitSymbol.pfb`               | `pdfjs-dist/standard_fonts/`, from PDFium                                                                                                         | BSD-3-Clause (`LICENSE_FOXIT`) | `47967d055530e7357088a08403115425643ec2cdfd6201ba8af0fbd7116c1539` |
| `FoxitDingbats.pfb`             | `pdfjs-dist/standard_fonts/`, from PDFium                                                                                                         | BSD-3-Clause (`LICENSE_FOXIT`) | `845c752392b6c914fb989c75a08b7792b88f542d2499042ef2889f8c814a16ed` |

The tarball's sha256 is
`7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0`.
Liberation is a Reserved Font Name under the OFL, so the files stay
unmodified: a subset or other edit would have to be renamed.

`src/renderer/lib/pdf-processor.test.js` fails if the Foxit copies drift from
the installed pdfjs-dist, so a pdfjs-dist bump re-copies them.
