/**
 * `refreshRadicleLaunchStatus` (src/renderer/pages/settings.html).
 *
 * The settings page is an inline classic script, so — like the rad-browser
 * page tests — the helper under test is extracted from the source and
 * evaluated with its collaborators injected. That keeps the assertion on the
 * shipped code rather than on a copy.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8');

const START = 'const refreshRadicleLaunchStatus = async () => {';
const END = '\n      };\n';

function loadRefresh({ fields, radicleLaunchHelp, radicleLaunchRow, defaultHelp, freedomAPI }) {
  const start = SOURCE.indexOf(START);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SOURCE.indexOf(END, start);
  expect(end).toBeGreaterThan(start);
  const body = SOURCE.slice(start, end + END.length);
  const factory = new Function(
    'fields',
    'radicleLaunchHelp',
    'radicleLaunchRow',
    'defaultRadicleLaunchHelp',
    'freedomAPI',
    `${body}\nreturn refreshRadicleLaunchStatus;`
  );
  return factory(fields, radicleLaunchHelp, radicleLaunchRow, defaultHelp, freedomAPI);
}

const fakeRow = () => {
  const classes = new Set();
  return {
    classes,
    classList: {
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
  };
};

const setup = (api) => {
  const fields = { startRadicle: { disabled: false } };
  const radicleLaunchHelp = { textContent: 'Start the Radicle node when Freedom launches.' };
  const radicleLaunchRow = fakeRow();
  const refresh = loadRefresh({
    fields,
    radicleLaunchHelp,
    radicleLaunchRow,
    defaultHelp: radicleLaunchHelp.textContent,
    freedomAPI: api,
  });
  return { refresh, fields, radicleLaunchHelp, radicleLaunchRow };
};

describe('refreshRadicleLaunchStatus', () => {
  test('greys the row and disables the checkbox for a profile with Radicle off', async () => {
    const ctx = setup({
      getActiveProfile: async () => ({ nodes: { radicle: { mode: 'disabled' } } }),
      checkRadicleBinary: async () => ({ available: true }),
    });

    await ctx.refresh();

    expect(ctx.fields.startRadicle.disabled).toBe(true);
    expect(ctx.radicleLaunchRow.classList.contains('disabled')).toBe(true);
    expect(ctx.radicleLaunchHelp.textContent).toMatch(/Disabled for this profile/);
  });

  test('leaves the row live when Radicle is available', async () => {
    const ctx = setup({
      getActiveProfile: async () => ({ nodes: { radicle: { mode: 'managed' } } }),
      checkRadicleBinary: async () => ({ available: true }),
    });

    await ctx.refresh();

    expect(ctx.fields.startRadicle.disabled).toBe(false);
    expect(ctx.radicleLaunchRow.classList.contains('disabled')).toBe(false);
  });

  // The regression: the catch branch re-enabled the checkbox but left the
  // `disabled` class a previous successful run had set, so a transient status
  // read failure rendered a greyed-out row wrapped around a live control.
  test('a transient status failure restores the whole row, not just the checkbox', async () => {
    const ctx = setup({
      getActiveProfile: async () => ({ nodes: { radicle: { mode: 'disabled' } } }),
      checkRadicleBinary: async () => ({ available: true }),
    });

    await ctx.refresh();
    expect(ctx.radicleLaunchRow.classList.contains('disabled')).toBe(true);

    const failing = setup({
      getActiveProfile: async () => {
        throw new Error('IPC unavailable');
      },
      checkRadicleBinary: async () => ({ available: true }),
    });
    // Same row object as the successful run above: this is the desync case.
    failing.refresh = loadRefresh({
      fields: ctx.fields,
      radicleLaunchHelp: ctx.radicleLaunchHelp,
      radicleLaunchRow: ctx.radicleLaunchRow,
      defaultHelp: 'Start the Radicle node when Freedom launches.',
      freedomAPI: {
        getActiveProfile: async () => {
          throw new Error('IPC unavailable');
        },
        checkRadicleBinary: async () => ({ available: true }),
      },
    });

    await failing.refresh();

    expect(ctx.fields.startRadicle.disabled).toBe(false);
    expect(ctx.radicleLaunchRow.classList.contains('disabled')).toBe(false);
    expect(ctx.radicleLaunchHelp.textContent).toMatch(/could not be read/);
  });
});
