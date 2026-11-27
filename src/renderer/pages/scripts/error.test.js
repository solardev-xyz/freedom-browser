/**
 * error page-script tests.
 *
 * The script is a classic (non-module) page script that renders at load and
 * touches DOM globals, so it can't just be `require()`d. These tests extract
 * the helpers under test from the source and evaluate them in isolation, with
 * `getRegistry` stubbed.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'error.js'), 'utf8');

/** Pull top-level functions (async or not) out of the source. */
function loadHelpers(names, registry) {
  const chunks = names.map((name) => {
    const asyncStart = SOURCE.indexOf(`async function ${name}(`);
    const start = asyncStart !== -1 ? asyncStart : SOURCE.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    // Helpers are separated by a blank line at top level.
    const end = SOURCE.indexOf('\n\n', start);
    return SOURCE.slice(start, end === -1 ? undefined : end);
  });
  return new Function(
    'registry',
    `const getRegistry = async () => registry;\n${chunks.join('\n')}\nreturn { ${names.join(', ')} };`
  )(registry);
}

describe('IPFS error page on a Linux system too old for the bundled node (#350)', () => {
  const statusFor = (registry) => loadHelpers(['checkIpfsStatus'], registry).checkIpfsStatus();

  test('the registry reason reaches the page, with the system glibc', async () => {
    await expect(
      statusFor({ ipfs: { mode: 'none', unavailableReason: 'glibc', hostGlibc: '2.35' } })
    ).resolves.toEqual({ running: false, glibcTooOld: true, hostGlibc: '2.35' });
  });

  test('an external node in use is not blamed on glibc', async () => {
    await expect(
      statusFor({
        ipfs: {
          mode: 'external',
          gateway: null,
          errorState: true,
          unavailableReason: 'glibc',
          hostGlibc: '2.35',
        },
      })
    ).resolves.toMatchObject({ running: false, glibcTooOld: false });
  });

  test('a profile with IPFS disabled is not blamed on glibc', async () => {
    await expect(
      statusFor({ ipfs: { mode: 'disabled', unavailableReason: 'glibc', hostGlibc: '2.35' } })
    ).resolves.toMatchObject({ glibcTooOld: false });
  });

  test('a stopped node without a reason keeps the usual message', async () => {
    await expect(statusFor({ ipfs: { mode: 'none' } })).resolves.toEqual({
      running: false,
      glibcTooOld: false,
      hostGlibc: null,
    });
  });

  test('the description names the cause and the way out', () => {
    const { glibcTooOldDescription } = loadHelpers(['glibcTooOldDescription']);

    expect(glibcTooOldDescription('2.35')).toBe(
      'Freedom\'s built-in IPFS node can\'t run on this Linux system because its C library (glibc 2.35) is too old. To open IPFS pages, use your own IPFS node: in Settings > Nodes, choose "Use external node" for IPFS.'
    );
    expect(glibcTooOldDescription(null)).toContain('its C library (glibc) is too old');
  });
});
