const { describeGlibcTooOld } = require('./freedom-ipfs-native-binding');

// What Electron's loader threw on Ubuntu 22.04 (glibc 2.35) in #350.
const GLIBC_ERROR = new Error(
  "/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.38' not found (required by /opt/Freedom/resources/freedom-ipfs-node/freedom_ipfs_native.node)"
);
GLIBC_ERROR.code = 'ERR_DLOPEN_FAILED';

describe('freedom-ipfs native binding load failures (#350)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('recognises a glibc too old for the add-on, with the system version when known', () => {
    jest
      .spyOn(process.report, 'getReport')
      .mockReturnValue({ header: { glibcVersionRuntime: '2.35' } });

    expect(describeGlibcTooOld(GLIBC_ERROR)).toEqual({ host: '2.35' });
  });

  test('still recognises it when the system version is unavailable', () => {
    jest.spyOn(process.report, 'getReport').mockImplementation(() => {
      throw new Error('report unavailable');
    });

    expect(describeGlibcTooOld(GLIBC_ERROR)).toEqual({ host: null });
  });

  test('other load failures are not a glibc problem', () => {
    const missing = new Error('freedom-ipfs native addon not found. Tried: /a, /b');
    missing.code = 'FREEDOM_IPFS_NATIVE_ADDON_MISSING';
    const wrongArch = new Error('dlopen(/x/freedom_ipfs_native.node, 0x0001): wrong architecture');

    expect(describeGlibcTooOld(missing)).toBeNull();
    expect(describeGlibcTooOld(wrongArch)).toBeNull();
    expect(describeGlibcTooOld(null)).toBeNull();
  });
});
