/**
 * Settings → About Freedom → Updates page script (#87). The script exports its render
 * helpers when `module` exists (Jest) and only wires the DOM in the page.
 */

const {
  formatUpdateBytes,
  describeDownloadDetail,
  describeLastChecked,
  updateSectionView,
  renderUpdateSection,
} = require('./settings-updates.js');

const el = () => ({
  dataset: {},
  style: {},
  hidden: false,
  disabled: false,
  textContent: '',
  attrs: {},
  setAttribute(name, value) {
    this.attrs[name] = value;
  },
});

const makeEls = () => ({
  row: el(),
  version: el(),
  message: el(),
  detail: el(),
  progress: el(),
  progressBar: el(),
  lastChecked: el(),
  check: el(),
  restart: el(),
});

const base = { currentVersion: '0.8.7', lastChecked: null, canCheck: true };

describe('Settings → About Freedom → Updates', () => {
  test('formatUpdateBytes', () => {
    expect(formatUpdateBytes(512)).toBe('512 B');
    expect(formatUpdateBytes(1536)).toBe('1.5 KB');
    expect(formatUpdateBytes(98 * 1024 * 1024)).toBe('98 MB');
    expect(formatUpdateBytes(null)).toBeNull();
  });

  test('download detail shows size and speed when reported', () => {
    expect(
      describeDownloadDetail({
        transferred: 12 * 1024 ** 2,
        total: 98 * 1024 ** 2,
        bytesPerSecond: 2.1 * 1024 ** 2,
      })
    ).toBe('12 MB of 98 MB · 2.1 MB/s');
    expect(describeDownloadDetail({ transferred: null, total: null, bytesPerSecond: 0 })).toBe('');
  });

  test('last checked is relative for the first hour', () => {
    const now = Date.UTC(2026, 9, 5, 12, 0);
    expect(describeLastChecked(null, now)).toBe('Not checked yet this session.');
    expect(describeLastChecked(now - 10_000, now)).toBe('Last checked just now.');
    expect(describeLastChecked(now - 60_000, now)).toBe('Last checked 1 minute ago.');
    expect(describeLastChecked(now - 5 * 60_000, now)).toBe('Last checked 5 minutes ago.');
    expect(describeLastChecked(now - 3 * 3600_000, now)).toMatch(/^Last checked .*2026.*\.$/);
  });

  test('idle: version, Check now enabled, not checked yet', () => {
    const els = makeEls();
    renderUpdateSection(els, {
      ...base,
      status: 'idle',
      message: 'Freedom checks for updates automatically.',
    });
    expect(els.version.textContent).toBe('Freedom 0.8.7');
    expect(els.message.textContent).toBe('Freedom checks for updates automatically.');
    expect(els.check).toMatchObject({ hidden: false, disabled: false, textContent: 'Check now' });
    expect(els.restart.hidden).toBe(true);
    expect(els.progress.hidden).toBe(true);
    expect(els.lastChecked).toMatchObject({
      hidden: false,
      textContent: 'Not checked yet this session.',
    });
  });

  test('downloading: progress bar, detail line, Check now disabled', () => {
    const els = makeEls();
    renderUpdateSection(els, {
      ...base,
      status: 'downloading',
      canCheck: false,
      percent: 42.5,
      transferred: 1024 ** 2,
      total: 10 * 1024 ** 2,
      bytesPerSecond: 0,
      message: 'Downloading Freedom 0.9.0… 42%',
      lastChecked: Date.UTC(2026, 9, 5, 12, 0),
    });
    expect(els.row.dataset.updateStatus).toBe('downloading');
    expect(els.progress.hidden).toBe(false);
    expect(els.progress.attrs['aria-valuenow']).toBe('42');
    expect(els.progressBar.style.width).toBe('42.5%');
    expect(els.detail).toMatchObject({ hidden: false, textContent: '1.0 MB of 10 MB' });
    expect(els.check.disabled).toBe(true);
    expect(els.lastChecked.textContent).toMatch(/^Last checked .*2026/);
  });

  test('checking relabels the button', () => {
    expect(updateSectionView({ ...base, status: 'checking', canCheck: false })).toMatchObject({
      checkLabel: 'Checking…',
      checkEnabled: false,
    });
  });

  test('ready swaps Check now for the restart button, with the profile note', () => {
    const els = makeEls();
    renderUpdateSection(els, {
      ...base,
      status: 'ready',
      canCheck: false,
      message: 'Freedom 0.9.0 is ready to install.',
      installLabel: 'Install update and close',
      installNote: 'Freedom will close after installing.',
    });
    expect(els.check.hidden).toBe(true);
    expect(els.restart).toMatchObject({
      hidden: false,
      disabled: false,
      textContent: 'Install update and close',
    });
    expect(els.message.textContent).toBe(
      'Freedom 0.9.0 is ready to install. Freedom will close after installing.'
    );
  });

  test('unsupported: reason shown, button disabled, no last-checked line', () => {
    const els = makeEls();
    renderUpdateSection(els, {
      ...base,
      status: 'unsupported',
      reason: 'development',
      canCheck: false,
      message: 'Updates are off in development builds.',
    });
    expect(els.message.textContent).toBe('Updates are off in development builds.');
    expect(els.check).toMatchObject({ hidden: false, disabled: true });
    expect(els.lastChecked.hidden).toBe(true);
  });
});
